// DeepSeek transport for the classification runner — the pure, testable half of
// scripts/classify.mjs. Everything here is a plain function over data or over an INJECTED
// `fetch`, so scripts/deepseek.test.mjs can drive every failure mode (429, 5xx, empty body,
// wrong ids, duplicate ids) without a network or an API key.
//
// ── Why this file exists at all: the transport is NOT a config swap ─────────────────────────
// The first cut of this pipeline talked to Anthropic's Message Batches API: submit a batch of
// requests each carrying a `custom_id`, poll until `processing_status: ended`, download JSONL
// results in arbitrary order, and correlate on the `custom_id` the API echoed back. The API
// owned the queue, the concurrency, the retries and the correlation key, and charged 50% for it.
//
// DeepSeek has NO batch equivalent. It is a synchronous, OpenAI-compatible chat-completions
// endpoint. So all four of those responsibilities move here:
//   * queue        → we hold the packs and walk them ourselves
//   * concurrency  → mapWithConcurrency(), bounded, default 6
//   * retries      → postPack(), exponential backoff + Retry-After, 429/5xx/empty-body
//   * correlation  → see the block comment on keyPackResults(). No custom_id exists any more.
//
// ── Correlation, the one property that must not break ──────────────────────────────────────
// A mis-keyed label is the worst outcome in this pipeline: it writes a confident, plausible,
// permanently wrong label onto a row and produces no error anywhere. Two independent guards:
//   1. PACK identity is structural, not echoed. The call is synchronous, so the response we
//      await IS the response to the pack we sent — we re-attach our own pack label locally and
//      never trust the model to carry it.
//   2. ROW identity travels INSIDE the payload. Every item we send carries its `id`, the schema
//      requires the model to echo it, and keyPackResults() accepts a row only if its id was in
//      that pack. Unknown ids are dropped, duplicate ids keep the first answer, and ids that
//      never came back are reported as missing so they stay in the queue for the next run.
// Positional matching is never used at any layer.
//
// Verified against the live docs on 2026-07-21:
//   https://api-docs.deepseek.com/quick_start/pricing      (model ids + prices)
//   https://api-docs.deepseek.com/api/create-chat-completion (body + response shape)
//   https://api-docs.deepseek.com/guides/json_mode          (response_format)
//   https://api-docs.deepseek.com/quick_start/rate_limit    (concurrency + 429)

/**
 * THE pinned model id. Verified 2026-07-21 against
 * https://api-docs.deepseek.com/quick_start/pricing/ — DeepSeek's first-party API lists exactly
 * two models, `deepseek-v4-flash` and `deepseek-v4-pro`. (The older `deepseek-chat` /
 * `deepseek-reasoner` names are aliases for v4-flash's non-thinking / thinking modes and are
 * documented as deprecated on 2026/07/24 15:59 UTC — do not use them.)
 *
 * Flash rather than Pro on purpose: this is bounded extraction against a closed enum, not
 * reasoning work, and flash is ~3x cheaper ($0.14/$0.28 per 1M in/out vs $0.435/$0.87) with a
 * 2,500-request concurrency ceiling against Pro's 500. Pass --model deepseek-v4-pro if a
 * measured accuracy pass ever justifies it.
 */
export const DEEPSEEK_MODEL = "deepseek-v4-flash";

/** OpenAI-compatible base. The `/v1` has nothing to do with the model version — it is the shape. */
export const DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";

/**
 * Per-1M-token list prices as of 2026-07-21, for the cost line the runner prints. Cache-hit
 * input is ~50x cheaper than a miss, and every pack repeats the same ~1KB taxonomy system
 * prompt, so DeepSeek's automatic prefix caching is doing roughly what the batch discount used
 * to — but it is not guaranteed, so the estimate below is priced at the CACHE-MISS rate. An
 * estimate that flatters itself is worse than no estimate.
 */
export const PRICES = {
  "deepseek-v4-flash": { in: 0.14, out: 0.28 },
  "deepseek-v4-pro": { in: 0.435, out: 0.87 },
};

/** Rows per request. Mirrors ROWS_PER_REQUEST in src/classification.ts — keep them equal. */
export const ROWS_PER_REQUEST = 20;

/**
 * Bounded concurrency. DeepSeek's documented ceiling for flash is 2,500 concurrent requests, so
 * this is not an API constraint — it is a BLAST-RADIUS constraint. Every in-flight pack is 20
 * rows we may have to abandon, and a runaway parallel run against a wrong prompt is a bill we
 * cannot un-spend. 6 keeps a 200-row page moving (10 packs, two waves) while leaving the archive
 * Worker's own request budget alone.
 */
export const DEFAULT_CONCURRENCY = 6;

/** Attempts per pack, including the first. Four gives ~1s + 2s + 4s of backoff before giving up. */
export const DEFAULT_ATTEMPTS = 4;

/**
 * The JSON contract, appended to the taxonomy system prompt the Worker serves.
 *
 * DeepSeek's JSON mode is `response_format: {type: "json_object"}` — it guarantees SYNTACTICALLY
 * valid JSON and nothing more. There is no `json_schema` mode, so the schema that used to be a
 * hard API-side constraint is now only a prompt-level contract, and the real enforcement moved
 * entirely to parseEmailLabels / parseBrandLabels in src/classification.ts (which already
 * rejected out-of-enum values, because "structured outputs make that near-impossible, but 'near'
 * is not 'never'"). That validation is now load-bearing rather than belt-and-braces.
 *
 * The docs also require the literal word "json" to appear in the prompt, and recommend showing
 * the desired shape — both are satisfied here.
 */
export function jsonContract(schema) {
  return [
    "",
    "OUTPUT FORMAT — respond with a single json object and nothing else. No prose, no markdown",
    "fences. The object must validate against this JSON Schema:",
    JSON.stringify(schema),
    "",
    'It has exactly one top-level key, "results", whose value is an array with ONE entry per',
    "input item. Copy each `id` through EXACTLY as it was given to you — the id is the only way",
    "your answer is matched back to a row, and an invented or altered id is discarded. Do not",
    "reorder, merge, split or omit items, and never return an id that was not in the input.",
  ].join("\n");
}

/**
 * The chat-completions request body. Fields are exactly the documented ones — DeepSeek is
 * OpenAI-compatible, so no SDK is needed (cf-archive's only runtime dependency stays postal-mime).
 */
export function chatBody({ model, system, user, maxTokens = 8192, temperature = 0 }) {
  return {
    model,
    // Thinking off, for the same reason it was off on Anthropic: bounded extraction against a
    // closed enum is not reasoning work, and thinking tokens bill at the output rate.
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
    // 0, not the API default of 1. Classification wants the same email to get the same label on
    // a re-run; sampling variety here is noise we would pay for twice.
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

/** Pull the assistant text out of a chat completion. Returns "" for anything unexpected. */
export function extractContent(json) {
  const c = json?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

/**
 * Parse the model's JSON body into the array of result rows.
 *
 * Returns null — never a partial or an empty array — for anything it cannot read, so the caller
 * can tell "the model said nothing usable" (retry, then leave the rows in the queue) apart from
 * "the model returned zero results" (a real, if odd, answer). A null here degrades the whole
 * pack to unclassified; it can never produce a wrong label.
 *
 * Tolerates a markdown fence because json_object mode is a strong hint, not a hard guarantee,
 * and a fenced-but-otherwise-perfect body is not worth throwing 20 rows away over.
 */
export function parseResultRows(text) {
  if (typeof text !== "string") return null;
  let s = text.trim();
  if (!s) return null; // DeepSeek documents occasionally returning empty content in JSON mode
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) s = fence[1].trim();
  let parsed;
  try { parsed = JSON.parse(s); } catch { return null; }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.results)) return parsed.results;
  return null;
}

/**
 * Which HTTP statuses are worth another attempt. 429 is the documented concurrency-limit
 * response; 5xx is transient by definition; 408 is a server-side timeout. Everything else —
 * 400 (a malformed body of OUR making), 401/403 (a bad key), 404 (a wrong model id) — is a bug
 * or a misconfiguration that will fail identically forever, so it throws immediately instead of
 * burning three retries and a minute of the operator's attention.
 */
export const isRetryableStatus = (status) =>
  status === 408 || status === 429 || (status >= 500 && status < 600);

/**
 * Exponential backoff with full jitter, capped. `retryAfter` (the header, in seconds) wins when
 * the server told us how long to wait. Jitter matters because we fire packs in parallel: without
 * it, a 429 synchronises every in-flight pack onto the same retry instant and we re-trip the
 * limit as a block.
 */
export function backoffMs(attempt, { retryAfter, rand = Math.random, base = 1000, cap = 30_000 } = {}) {
  const after = Number(retryAfter);
  if (Number.isFinite(after) && after > 0) return Math.min(cap, Math.round(after * 1000));
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + rand() * (ceiling / 2));
}

/**
 * Send one pack and return its result rows, or null if the pack could not be read.
 *
 * Null is the safe direction on purpose: a pack that returns null contributes NO labels, so
 * every id in it lands in `missingIds`, is never POSTed, keeps `classified_at` NULL, and is
 * handed out again by the next run. The alternative — guessing at a mangled body — writes a
 * wrong label that nothing downstream can detect.
 *
 * `fetchImpl` and `sleep` are injected so the tests can drive every branch deterministically.
 */
export async function postPack({
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  baseUrl = DEEPSEEK_BASE_URL,
  key,
  body,
  attempts = DEFAULT_ATTEMPTS,
  label = "pack",
  onWarn = () => {},
  rand,
} = {}) {
  let usage = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      // A transport-level failure (DNS, socket reset) is always worth another go.
      if (attempt === attempts) { onWarn(`${label}: network error after ${attempts} attempts: ${e?.message || e}`); return { rows: null, usage }; }
      await sleep(backoffMs(attempt, { rand }));
      continue;
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (!isRetryableStatus(res.status)) {
        // Fail the RUN, not the pack: a 401 or a 404 model id means every remaining pack would
        // fail the same way, and burning the queue against a broken config is pure cost.
        throw new Error(`deepseek ${res.status}: ${detail}`);
      }
      if (attempt === attempts) { onWarn(`${label}: ${res.status} after ${attempts} attempts — left in the queue`); return { rows: null, usage }; }
      const wait = backoffMs(attempt, { retryAfter: res.headers?.get?.("retry-after"), rand });
      onWarn(`${label}: ${res.status}, retrying in ${wait}ms (attempt ${attempt}/${attempts})`);
      await sleep(wait);
      continue;
    }

    const json = await res.json().catch(() => null);
    usage = json?.usage ?? usage;
    const rows = parseResultRows(extractContent(json));
    if (rows) return { rows, usage };

    // 200 with an unreadable body. DeepSeek documents that JSON mode "may occasionally return
    // empty content", and a `finish_reason: "length"` truncation lands here too — both are
    // transient enough to be worth a retry, and both must NEVER be turned into labels.
    if (attempt === attempts) {
      onWarn(`${label}: unparseable model output after ${attempts} attempts (finish_reason=${json?.choices?.[0]?.finish_reason ?? "?"}) — left in the queue`);
      return { rows: null, usage };
    }
    onWarn(`${label}: unparseable model output, retrying (attempt ${attempt}/${attempts})`);
    await sleep(backoffMs(attempt, { rand }));
  }
  return { rows: null, usage };
}

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving INPUT ORDER in the output.
 * Order is preserved for log readability only — nothing downstream is positional (see
 * keyPackResults) — but an out-of-order log during an incident costs real minutes.
 */
export async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * Correlate model output back to rows. THE load-bearing function of this file.
 *
 * `results` is [{ pack, rows }] where `pack` is OUR object (the one we sent) and `rows` is what
 * the model returned for it — or null if the call failed. Nothing about the pairing came from
 * the API: the call is synchronous, so the pairing is structural.
 *
 * Inside a pack, each row finds its target by the `id` the model echoed:
 *   - an id that was not in this pack  → dropped, reported in unknownIds (hallucinated/mangled)
 *   - an id already answered            → dropped, first answer wins (a duplicate is not new
 *                                         information, and picking the second is arbitrary)
 *   - an id we sent that never came back → reported in missingIds; it keeps classified_at NULL
 *                                          and is handed out again next run
 * A model that returns fewer, more, duplicated or entirely invented ids therefore costs us
 * coverage and never correctness.
 */
export function keyPackResults(results) {
  const labels = [];
  const unknownIds = [];
  const seen = new Set();
  for (const { pack, rows } of results) {
    if (!pack || !Array.isArray(rows)) continue; // failed pack — every id falls through to missingIds
    const allowed = new Set(pack.items.map((i) => String(i.id)));
    for (const row of rows) {
      const id = row?.id;
      if (typeof id !== "string" || !id) continue;
      if (!allowed.has(id)) { unknownIds.push(id); continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      labels.push(row);
    }
  }
  const missingIds = results.flatMap(({ pack }) => (pack?.items ?? []).map((i) => String(i.id)))
    .filter((id) => !seen.has(id));
  return { labels, unknownIds, missingIds };
}

/**
 * Split rows into packs. Mirrors packRows in src/classification.ts, minus the custom_id charset
 * dance: DeepSeek has no custom_id, so `label` is ours alone and only ever reaches a log line.
 * It still embeds the pack index and its first row id so a log can be traced back by eye.
 */
export function packRows(rows, prefix, size = ROWS_PER_REQUEST) {
  const packs = [];
  const step = Math.max(1, size);
  for (let i = 0; i < rows.length; i += step) {
    const items = rows.slice(i, i + step);
    packs.push({ label: `${prefix}-${i}-${items[0].id}`.slice(0, 80), items });
  }
  return packs;
}

/** Cost estimate at LIST cache-miss prices, in USD. Deliberately pessimistic — see PRICES. */
export function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return null;
  const inTok = usage.prompt_tokens ?? 0;
  const outTok = usage.completion_tokens ?? 0;
  return (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
}
