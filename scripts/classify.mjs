#!/usr/bin/env node
// LLM classification runner — verticals per brand, campaign type / tone / narrative per email
// (plan 3.2). Runs in Node (GitHub Action / local), NOT in the Worker: the Worker cannot call
// an LLM at all, and conventions.md's cron-placement rule sends model-dependent work to a
// GitHub Action. See .github/workflows/classify.yml.
//
// Loop, per kind:
//   GET  /internal/classify-queue  → { items (residue for the model), settled (rules-only rows) }
//   POST /internal/classify        → settled rows, immediately; they never cost a model call
//   pack items ~20 per request     → DeepSeek chat-completions, ≤N packs in flight
//   correlate each response to the pack we sent, each row to the id it echoed
//   POST /internal/classify        → the labels that survived correlation
//
// ── This is a TRANSPORT rewrite, not a provider swap ────────────────────────────────────────
// It used to be Anthropic's Message Batches API: submit N requests each with a `custom_id`, poll
// for `processing_status: ended`, download JSONL results in arbitrary order, correlate on the
// echoed custom_id, and take a 50% batch discount for the latency. DeepSeek has no batch
// equivalent — it is a SYNCHRONOUS, OpenAI-compatible chat-completions endpoint — so this script
// now owns the queue, the concurrency, the retries and the correlation itself. All of that lives
// in scripts/deepseek.mjs, which is pure and unit-tested (scripts/deepseek.test.mjs); this file
// only shuttles bytes between the archive and that module.
//
// This script deliberately contains NO classification logic. The taxonomies, the rules pre-pass
// and the rules/model merge all live in cf-archive/src/classification.ts, where they are
// typechecked and unit-tested; if you find yourself adding a regex here, it belongs there.
//
// Idempotent: only rows with classified_at / vertical_at NULL are ever handed out, so a re-run
// picks up where the last one stopped and steady-state only touches new mail. A pack that fails
// every retry contributes no labels at all, so its rows simply stay in the queue.
//
//   DEEPSEEK_API_KEY=<key from a GitHub secret — never committed, never echoed> \
//   TROVE_INTERNAL_API_TOKEN=<token> \
//   ARCHIVE_URL=https://trove.livingemails.com \
//     node scripts/classify.mjs --kind emails --limit 200
//
// Raw HTTPS rather than the OpenAI SDK on purpose: cf-archive is a Cloudflare Worker whose only
// runtime dependency is postal-mime, and adding an SDK to its package.json for a Node-only
// script would put it in the Worker's install graph. DeepSeek is OpenAI-compatible, so two
// endpoints and plain fetch is the whole client.

import {
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  DEFAULT_ATTEMPTS,
  DEFAULT_CONCURRENCY,
  chatBody,
  estimateCost,
  jsonContract,
  keyPackResults,
  mapWithConcurrency,
  packRows,
  postPack,
} from "./deepseek.mjs";

const ARCHIVE_URL = (process.env.ARCHIVE_URL || "https://trove.livingemails.com").replace(/\/+$/, "");
const TOKEN = process.env.TROVE_INTERNAL_API_TOKEN;
const KEY = process.env.DEEPSEEK_API_KEY;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const KIND = arg("kind", "both");                 // emails | brands | both
const LIMIT = parseInt(arg("limit", "200"), 10);  // rows per queue page
const MAX_ROUNDS = parseInt(arg("rounds", "20"), 10);
const CONCURRENCY = parseInt(arg("concurrency", String(DEFAULT_CONCURRENCY)), 10) || DEFAULT_CONCURRENCY;
const ATTEMPTS = parseInt(arg("attempts", String(DEFAULT_ATTEMPTS)), 10) || DEFAULT_ATTEMPTS;
const DRY = process.argv.includes("--dry-run");
// Pinned in ONE place (deepseek.mjs, with the date and URL it was verified against), but
// overridable without a code change so an operator is never blocked on a deploy. VERIFIED AT
// RUNTIME against GET /v1/models before a single pack is sent — see verifyModel(). Do not "fix"
// a model id from memory; let the API tell you.
const MODEL = arg("model", process.env.CLASSIFY_MODEL || DEEPSEEK_MODEL);

if (!TOKEN) { console.error("TROVE_INTERNAL_API_TOKEN is required"); process.exit(1); }
if (!KEY && !DRY) { console.error("DEEPSEEK_API_KEY is required (set it as a GitHub secret)"); process.exit(1); }

const troveHeaders = { Authorization: `Bearer ${TOKEN}` };

let spendUsd = 0;
const addUsage = (usage) => { const c = estimateCost(MODEL, usage); if (c) spendUsd += c; };

/**
 * Confirm the pinned model id actually exists before spending anything on it. A wrong id is a
 * 404 on every single pack — the job would run to completion having classified nothing. Failing
 * here, loudly, with the live list, is the cheap version of that discovery.
 */
async function verifyModel(id) {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/models`, { headers: { authorization: `Bearer ${KEY}` } });
  if (!res.ok) throw new Error(`deepseek GET /models ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const ids = ((await res.json())?.data ?? []).map((m) => m.id);
  if (!ids.includes(id)) {
    throw new Error(`model "${id}" is not in the live model list. Pass --model <id> or set CLASSIFY_MODEL. Available: ${ids.join(", ")}`);
  }
  console.log(`[classify] model verified: ${id} (live list: ${ids.join(", ")})`);
}

// ── the archive side ─────────────────────────────────────────────────────────
async function fetchQueue(kind, limit) {
  const res = await fetch(`${ARCHIVE_URL}/internal/classify-queue?kind=${kind}&limit=${limit}`, { headers: troveHeaders });
  if (!res.ok) throw new Error(`classify-queue ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function postLabels(payload) {
  if (DRY) { console.log(`[classify] dry-run — would POST ${JSON.stringify(payload).length}B`); return { emails: 0, brands: 0, rejected: [] }; }
  const res = await fetch(`${ARCHIVE_URL}/internal/classify`, {
    method: "POST",
    headers: { ...troveHeaders, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`classify POST ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// ── the model side ───────────────────────────────────────────────────────────
/**
 * Send every pack, ≤CONCURRENCY in flight, and correlate what comes back.
 *
 * The pairing of response→pack is structural (we await the call we made), never echoed: DeepSeek
 * has no custom_id, so there is nothing to trust and nothing to spoof. The pairing of row→id is
 * checked against the ids that pack actually contained. See keyPackResults.
 */
async function runPacks(packs, system, schema, instruction) {
  const results = await mapWithConcurrency(packs, CONCURRENCY, async (pack) => {
    const body = chatBody({
      model: MODEL,
      system: `${system}\n${jsonContract(schema)}`,
      user: `${instruction}\n\n${JSON.stringify(pack.payload)}`,
    });
    const { rows, usage } = await postPack({
      key: KEY, body, attempts: ATTEMPTS, label: pack.label,
      onWarn: (m) => console.warn(`[classify] ${m}`),
    });
    addUsage(usage);
    return { pack, rows };
  });
  const keyed = keyPackResults(results);
  if (keyed.unknownIds.length) console.warn(`[classify] dropped ${keyed.unknownIds.length} unrecognised id(s) the model returned: ${keyed.unknownIds.slice(0, 5).join(", ")}`);
  if (keyed.missingIds.length) console.warn(`[classify] ${keyed.missingIds.length} row(s) came back with no label — left in the queue for the next run`);
  return keyed.labels;
}

// ── the two drains ───────────────────────────────────────────────────────────
async function runEmails() {
  let round = 0, written = 0, freeRows = 0;
  for (;;) {
    const q = await fetchQueue("emails", LIMIT);
    const settled = q.settled ?? [], items = q.items ?? [];
    if (!settled.length && !items.length) { console.log(`[classify] emails queue empty (remaining=${q.remaining ?? 0})`); break; }
    if (++round > MAX_ROUNDS) { console.log(`[classify] hit --rounds ${MAX_ROUNDS}; ${q.remaining} rows still queued`); break; }

    // Rules-settled rows cost nothing — post them as bare ids and let the Worker re-derive and
    // stamp them. This is the whole point of running the rules first.
    if (settled.length) {
      const r = await postLabels({ emails: settled.map((s) => ({ id: s.id })) });
      freeRows += r.emails ?? 0;
      console.log(`[classify] round ${round}: ${settled.length} settled by rules (no model call)`);
    }
    if (!items.length) continue;

    const packs = packRows(items, "emails").map((p) => ({
      ...p,
      // The id travels INSIDE the payload — it is the only correlation key DeepSeek gives us.
      payload: p.items.map((i) => ({ id: i.id, text: i.t, meta: i.meta, rules_label: i.pre?.campaign_type ?? null })),
    }));
    if (DRY) { console.log(`[classify] dry-run — ${packs.length} packs, ${items.length} emails; not calling the model`); break; }

    const labels = await runPacks(packs, q.system, q.schema, "Classify each email. Return one result per id.");
    const r = await postLabels({ emails: labels });
    written += r.emails ?? 0;
    console.log(`[classify] round ${round}: model labelled ${labels.length}/${items.length}; written ${r.emails}; rejected ${(r.rejected ?? []).length}; ~$${spendUsd.toFixed(3)} so far; ~remaining ${Math.max(0, (q.remaining ?? 0) - settled.length - items.length)}`);
  }
  console.log(`[classify] emails done — ${freeRows} settled by rules, ${written} written from the model`);
}

async function runBrands() {
  let round = 0, written = 0;
  for (;;) {
    const q = await fetchQueue("brands", LIMIT);
    const items = q.items ?? [];
    if (!items.length) { console.log(`[classify] brands queue empty (remaining=${q.remaining ?? 0})`); break; }
    if (++round > MAX_ROUNDS) { console.log(`[classify] hit --rounds ${MAX_ROUNDS}; ${q.remaining} brands still queued`); break; }

    const packs = packRows(items, "brands").map((p) => ({ ...p, payload: p.items }));
    if (DRY) { console.log(`[classify] dry-run — ${packs.length} packs, ${items.length} brands; not calling the model`); break; }

    const labels = await runPacks(packs, q.system, q.schema, "Assign a vertical to each brand. Return one result per id.");
    const r = await postLabels({ brands: labels });
    written += r.brands ?? 0;
    console.log(`[classify] round ${round}: model labelled ${labels.length}/${items.length}; written ${r.brands}; rejected ${(r.rejected ?? []).length}; ~$${spendUsd.toFixed(3)} so far`);
  }
  console.log(`[classify] brands done — ${written} written`);
}

async function main() {
  console.log(`[classify] archive=${ARCHIVE_URL} model=${MODEL} kind=${KIND} limit=${LIMIT} concurrency=${CONCURRENCY} attempts=${ATTEMPTS}${DRY ? " (dry-run)" : ""}`);
  // The json schema and the taxonomy system prompt travel with the queue response — they are
  // defined once in src/classification.ts and served by the Worker, so this script never holds
  // a second copy of the enums that could drift. DeepSeek has no json_schema mode, so the schema
  // is appended to the prompt as a contract (jsonContract) and enforced on WRITE by
  // parseEmailLabels / parseBrandLabels in the Worker.
  if (!DRY) await verifyModel(MODEL);
  if (KIND === "emails" || KIND === "both") await runEmails();
  if (KIND === "brands" || KIND === "both") await runBrands();
  if (!DRY) console.log(`[classify] estimated spend: ~$${spendUsd.toFixed(3)} at ${MODEL} list cache-miss prices`);
}

main().catch((e) => { console.error("[classify] FAILED:", e.message || e); process.exit(1); });
