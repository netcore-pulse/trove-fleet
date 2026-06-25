#!/usr/bin/env node
/**
 * Trove Subscriber Agent — operator CLI.
 *
 * A0 commands (no browser; spine only):
 *   agent seed <file>     Load a newline/CSV seed list into the target store.
 *   agent stats           Funnel counts by status + coverage %.
 *   agent persona <dom>   Show the deterministic synthetic persona for a domain.
 *
 * A1 commands (drive a headless browser — single target, manual trigger):
 *   agent subscribe <domain>       Run the subscribe loop for one domain.
 *   agent subscribe:live <domain>  LIVE-BRAND SMOKE — drives the real site.
 *                                   For the orchestrator to run MANUALLY; it
 *                                   hits a live network + a live archive and is
 *                                   NOT exercised by the test suite.
 *
 * A2 command (the confirm loop — closes the double-opt-in):
 *   agent confirm         Run one poll→click→confirm pass over the confirmations
 *                         queue. Clicks ONLY the confirmation link (cardinal
 *                         rule). Plain HTTPS GET by default; TROVE_CONFIRM_BROWSER=1
 *                         switches to a real-browser clicker.
 *
 *   agent help            Usage.
 *
 * Thin hand-rolled argv parser — no commander dependency (lean tooling).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.ts";
import { TargetStore } from "../store.ts";
import { canonicalizeDomain, parseSeedText } from "../canonical.ts";
import { personaForDomain } from "../persona.ts";
import { STATUSES, type Status } from "../state.ts";
import { ArchiveClient } from "../archive-client.ts";
import { BrowserWorker } from "../browser/worker.ts";
import { runSubscribe } from "../subscribe.ts";
import { runConfirmLoop } from "../confirm-loop.ts";
import { proxyPoolFromEnv } from "../fleet/proxy-pool.ts";
import { throttleOptionsFromEnv } from "../fleet/throttle.ts";
import { makeSubscribeStep } from "../fleet/subscribe-step.ts";
import { computeMetrics, formatMetrics } from "../observability/metrics.ts";
import { evaluateAlerts, formatAlerts } from "../observability/alerts.ts";
import { runBurst } from "../run/burst.ts";
import { runMaintenance } from "../run/maintenance.ts";

function usage(): string {
  return [
    "Trove Subscriber Agent (A0 spine + A1 subscribe loop + A2 confirm loop)",
    "",
    "Usage:",
    "  agent seed <file>      Load a newline/CSV seed list ({domain,brand_name?,category?})",
    "  agent stats            Show funnel counts by status + coverage %",
    "  agent persona <domain> Show the synthetic persona assigned to a domain",
    "  agent subscribe <domain>",
    "                         Run the A1 subscribe loop for ONE domain (headless).",
    "                         Seeds the domain if absent, leases it, finds the form,",
    "                         mints an address, fills + submits, records the outcome.",
    "  agent subscribe:live <domain>",
    "                         LIVE-BRAND SMOKE: same loop against the REAL site +",
    "                         REAL archive. For MANUAL operator use; not run in tests.",
    "                         Set TROVE_HEADED=1 to watch it in a headed browser.",
    "  agent confirm          Run ONE confirm pass: poll the confirmations queue,",
    "                         extract + click ONLY the confirmation link, flip the",
    "                         address active. Clicks via a plain HTTPS GET by default;",
    "                         set TROVE_CONFIRM_BROWSER=1 to click via a real browser.",
    "  agent metrics          Print the funnel + coverage % + confirm latency +",
    "                         per-ESP success + proxy health (A4 dashboard).",
    "  agent doctor           Proxy health + alert check (confirm-rate collapse,",
    "                         block-rate spike, confirm-loop stall, proxy exhaustion).",
    "                         Exits non-zero on any CRITICAL alert (cron/pager hook).",
    "  agent burst [--limit N]",
    "                         A5 BURST: drive the seed through the bounded, throttled",
    "                         pool (the heavy onboarding phase). Paced under block",
    "                         thresholds — slow by design. Resumable: kill + re-run",
    "                         picks up where it left off (no double-subscribe).",
    "  agent maintain [--limit N]",
    "                         A5 TRICKLE: release lapsed leases, re-queue parked rows",
    "                         + new seed, reconcile confirmations, drain a small budget.",
    "  agent help             Show this help",
    "",
    "Env:",
    "  TROVE_AGENT_DB           SQLite store path (default ./data/targets.db)",
    "  TROVE_ARCHIVE_URL        Archive internal API base (default http://localhost:3033)",
    "  TROVE_INTERNAL_API_TOKEN Bearer token (default dev-only-internal-token)",
    "  TROVE_WORKER_ID          Worker id (default agent-1)",
    "  TROVE_HEADED             '1' to run subscribe:live in a headed browser",
    "  TROVE_CONFIRM_BROWSER    '1' to click confirm links via a real browser",
    "  TROVE_PROXY_URLS         Comma-list of egress proxy URLs (empty = direct)",
    "  TROVE_RATE_MAX           Global rate cap: max attempt-starts per window (default 30)",
    "  TROVE_RATE_WINDOW_MS     Sliding-window length for the rate cap (default 60000)",
    "  TROVE_DOMAIN_MIN_DELAY_MS Min gap between two attempts to one domain (default 6h)",
    "  TROVE_JITTER_MS          Max jitter padded onto each pacing wait (default 750; 0 disables)",
    "  TROVE_POPUP_SETTLE_MS    Wait for provoked email popups incl. Klaviyo (default 1200; 0 to skip)",
    "  Deterministic run: TROVE_JITTER_MS=0 + a single worker -> reproducible target order + pacing.",
  ].join("\n");
}

function cmdSeed(file: string | undefined): number {
  if (!file) {
    process.stderr.write("error: `agent seed` requires a <file> path\n");
    return 2;
  }
  const cfg = loadConfig();
  const path = resolve(file);
  const text = readFileSync(path, "utf8");
  const rows = parseSeedText(text);

  const store = new TargetStore(cfg.dbPath);
  try {
    const r = store.ingest(rows);
    process.stdout.write(
      [
        `Seed loaded from ${path}`,
        `  parsed:   ${r.parsed}`,
        `  invalid:  ${r.invalid}  (no registrable domain)`,
        `  distinct: ${r.distinct}  (after canonicalization)`,
        `  inserted: ${r.inserted}  (newly queued)`,
        `  skipped:  ${r.skipped}  (already present / in-flight / confirmed)`,
        `  store:    ${cfg.dbPath}  (total now ${store.count()})`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdStats(): number {
  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  try {
    const by = store.statsByStatus();
    const total = store.count();
    const coverage = store.coveragePct();

    const lines = [`Target store: ${cfg.dbPath}`, `Total: ${total}`, ""];
    for (const s of STATUSES) {
      lines.push(`  ${s.padEnd(16)} ${by[s as Status]}`);
    }
    lines.push("");
    lines.push(`Coverage (confirmed/total): ${coverage.toFixed(2)}%`);
    lines.push("");
    process.stdout.write(lines.join("\n"));
    return 0;
  } finally {
    store.close();
  }
}

function cmdPersona(domain: string | undefined): number {
  if (!domain) {
    process.stderr.write("error: `agent persona` requires a <domain>\n");
    return 2;
  }
  const p = personaForDomain(domain);
  process.stdout.write(JSON.stringify({ domain, persona: p }, null, 2) + "\n");
  return 0;
}

/**
 * A1 single-target subscribe loop. Shared by `subscribe` and `subscribe:live`.
 *
 * `live=true` is the operator's manual live-brand smoke: identical mechanism,
 * but it announces itself loudly and honors TROVE_HEADED. Neither command runs
 * in the test suite (both drive a real browser + the real archive).
 */
async function cmdSubscribe(rawDomain: string | undefined, live: boolean): Promise<number> {
  const label = live ? "subscribe:live" : "subscribe";
  if (!rawDomain) {
    process.stderr.write(`error: \`agent ${label}\` requires a <domain>\n`);
    return 2;
  }
  const domain = canonicalizeDomain(rawDomain);
  if (!domain) {
    process.stderr.write(`error: '${rawDomain}' has no valid registrable domain\n`);
    return 2;
  }

  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  const client = new ArchiveClient(cfg);
  const headed = live && process.env.TROVE_HEADED === "1";
  const worker = new BrowserWorker({ headless: !headed });

  if (live) {
    process.stdout.write(
      [
        "=== LIVE-BRAND SMOKE ===",
        `Driving the REAL site for ${domain} and minting against ${cfg.archiveUrl}.`,
        "This is a manual operator action (not run in tests).",
        "",
      ].join("\n"),
    );
  }

  try {
    // Ensure the domain is in the store (idempotent — never disturbs progress).
    store.ingest([{ domain }]);

    // Live smoke uses one fixed persona (operator-named) so the run is easy to
    // eyeball; the non-live path keeps the deterministic per-domain persona.
    const OLIVIA = {
      firstName: "Olivia", lastName: "Smith", fullName: "Olivia Smith",
      postalCode: "55401", city: "Minneapolis", state: "MN", dateOfBirth: "1994-03-12",
    };
    const result = await runSubscribe({
      store,
      mint: (brand, ph) => client.mintAddress(brand, ph),
      persona: live ? OLIVIA : undefined,
      workerId: cfg.workerId,
      domain,
      worker,
    });

    if (result.domain === null) {
      // Not leasable: already confirmed / in-flight / parked.
      const row = store.get(domain);
      process.stdout.write(
        `not leasable: ${domain} is '${row?.status ?? "unknown"}' (confirmed/in-flight/parked)\n`,
      );
      return 0;
    }

    process.stdout.write(
      [
        `${label}: ${result.domain}`,
        `  status:  ${result.status}`,
        `  esp:     ${result.esp ?? "-"}`,
        `  address: ${result.address ?? "-"}`,
        `  reason:  ${result.reason ?? "-"}`,
        "",
      ].join("\n"),
    );
    return result.status === "submitted" ? 0 : 1;
  } finally {
    await worker.close();
    store.close();
  }
}

/**
 * A2 confirm loop — one poll→click→confirm pass over the confirmations queue.
 *
 * Clicks ONLY the confirmation link(s) the whitelist extracts (cardinal rule).
 * Default clicker is a plain HTTPS GET; TROVE_CONFIRM_BROWSER=1 swaps in the
 * real-browser clicker for links that need JS/cookies. Hits the live archive +
 * live endpoints, so it is NOT exercised by the test suite (the loop's logic is
 * proven against stubs in confirm-loop.test.ts).
 */
async function cmdConfirm(): Promise<number> {
  const cfg = loadConfig();
  const client = new ArchiveClient(cfg);
  const useBrowser = process.env.TROVE_CONFIRM_BROWSER === "1";
  const worker = useBrowser ? new BrowserWorker() : null;

  try {
    const { httpGetClick, playwrightClick } = await import("../confirm-loop.ts");
    const click = worker ? playwrightClick(worker) : httpGetClick();

    const result = await runConfirmLoop({
      workerId: cfg.workerId,
      archive: client,
      click,
    });

    const lines = [
      `confirm pass (worker ${cfg.workerId}) against ${cfg.archiveUrl}`,
      `  polled:    ${result.polled}`,
      `  confirmed: ${result.confirmed}`,
      `  failed:    ${result.failed}  (no confirm link / unparseable)`,
      `  released:  ${result.released}  (transient — will retry)`,
      `  errored:   ${result.errored}`,
      "",
    ];
    for (const i of result.items) {
      lines.push(
        `  #${i.confirmationId} addr=${i.addressId} ${i.disposition}` +
          (i.clickedLinks.length ? ` clicked=${i.clickedLinks.length}` : "") +
          ` — ${i.reason}`,
      );
    }
    lines.push("");
    process.stdout.write(lines.join("\n"));
    // Non-zero only if something errored unexpectedly; failed/released are normal.
    return result.errored > 0 ? 1 : 0;
  } finally {
    if (worker) await worker.close();
  }
}

/**
 * A4 `agent metrics` — print the funnel + coverage + confirm-latency + per-ESP +
 * proxy-health snapshot. Pure read from the store (+ the env-configured proxy
 * pool for health). No browser, no archive.
 */
function cmdMetrics(): number {
  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  const proxies = proxyPoolFromEnv(process.env);
  try {
    const metrics = computeMetrics(store, proxies);
    process.stdout.write(formatMetrics(metrics));
    return 0;
  } finally {
    store.close();
  }
}

/**
 * A4 `agent doctor` — proxy health + alert check. Exits non-zero if any
 * critical alert fired (so a cron can page on it). Pure read.
 */
function cmdDoctor(): number {
  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  const proxies = proxyPoolFromEnv(process.env);
  try {
    const metrics = computeMetrics(store, proxies);
    const alerts = evaluateAlerts(metrics);
    const lines = [
      "Trove Subscriber Agent — doctor",
      "",
      `Proxies: ${metrics.healthyProxies}/${metrics.totalProxies} healthy`,
    ];
    for (const p of metrics.proxies) {
      lines.push(
        `  ${p.id.padEnd(10)} ${p.healthy ? "healthy" : "DEAD"} ` +
          `ok=${p.totalSuccesses} fail=${p.totalFailures} streak=${p.consecutiveFailures}`,
      );
    }
    lines.push("");
    process.stdout.write(lines.join("\n") + "\n" + formatAlerts(alerts));
    // Non-zero on any critical alert (cron/pager hook).
    return alerts.some((a) => a.level === "critical") ? 1 : 0;
  } finally {
    store.close();
  }
}

/**
 * A5 `agent burst [--limit N]` — drive the seed through the bounded, throttled
 * pool. Drives a real browser + real archive (the heavy onboarding phase), so it
 * is a MANUAL operator action, not run in tests. The orchestration logic is
 * proven offline against a fake step in burst.test.ts.
 */
async function cmdBurst(rest: string[]): Promise<number> {
  const limit = parseLimitFlag(rest);
  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  const client = new ArchiveClient(cfg);
  const proxies = proxyPoolFromEnv(process.env);
  const step = makeSubscribeStep({ mint: (brand, ph) => client.mintAddress(brand, ph) });

  process.stdout.write(
    [
      "=== BURST (heavy onboarding phase) ===",
      `store=${cfg.dbPath} archive=${cfg.archiveUrl}`,
      `proxies=${proxies.healthyCount()}/${proxies.size()} healthy  limit=${limit ?? "drain"}`,
      "Paced under block thresholds (throttle is not optional). This is slow by design.",
      "",
    ].join("\n"),
  );

  try {
    const result = await runBurst({
      store,
      step,
      proxies,
      throttle: throttleOptionsFromEnv(process.env),
      ...(limit !== undefined ? { limit } : {}),
      onAttempt: (domain, status) => process.stdout.write(`  ${status.padEnd(16)} ${domain}\n`),
    });
    process.stdout.write(
      [
        "",
        `burst pass complete: attempted=${result.attempted} errored=${result.errored}`,
        `  submitted=${result.byStatus.submitted} needs_solver=${result.byStatus.needs_solver}` +
          ` no_form_found=${result.byStatus.no_form_found} needs_attention=${result.byStatus.needs_attention}` +
          ` queued(retry)=${result.byStatus.queued}`,
        `  remaining queued: ${result.remainingQueued}`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}

/**
 * A5 `agent maintain` — the steady-state trickle: release lapsed leases,
 * re-queue parked rows, reconcile confirmations, then drain a small budget under
 * the throttle. Manual/cron operator action; drives a real browser + archive.
 */
async function cmdMaintain(rest: string[]): Promise<number> {
  const limit = parseLimitFlag(rest);
  const cfg = loadConfig();
  const store = new TargetStore(cfg.dbPath);
  const client = new ArchiveClient(cfg);
  const proxies = proxyPoolFromEnv(process.env);
  const step = makeSubscribeStep({ mint: (brand, ph) => client.mintAddress(brand, ph) });

  process.stdout.write(
    [
      "=== MAINTENANCE TRICKLE ===",
      `store=${cfg.dbPath} archive=${cfg.archiveUrl}`,
      "",
    ].join("\n"),
  );

  try {
    const result = await runMaintenance({
      store,
      step,
      proxies,
      throttle: throttleOptionsFromEnv(process.env),
      ...(limit !== undefined ? { drainLimit: limit } : {}),
      onAttempt: (domain, status) => process.stdout.write(`  ${status.padEnd(16)} ${domain}\n`),
    });
    process.stdout.write(
      [
        "",
        `maintenance pass complete:`,
        `  released leases:   ${result.releasedLeases}`,
        `  re-queued:         needs_attention=${result.requeued.needs_attention}` +
          ` needs_solver=${result.requeued.needs_solver} no_form_found=${result.requeued.no_form_found}`,
        `  reconciled:        ${result.reconciledConfirmed}`,
        `  drained:           attempted=${result.drain.attempted} submitted=${result.drain.byStatus.submitted}`,
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    store.close();
  }
}

/** Parse `--limit N` (or `--limit=N`) from a command's residual args. */
function parseLimitFlag(rest: string[]): number | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--limit") {
      const v = rest[i + 1];
      const n = v !== undefined ? Number(v) : NaN;
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    } else if (a.startsWith("--limit=")) {
      const n = Number(a.slice("--limit=".length));
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
    }
  }
  return undefined;
}

export function run(argv: string[]): number | Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "seed":
      return cmdSeed(rest[0]);
    case "stats":
      return cmdStats();
    case "persona":
      return cmdPersona(rest[0]);
    case "subscribe":
      return cmdSubscribe(rest[0], false);
    case "subscribe:live":
      return cmdSubscribe(rest[0], true);
    case "confirm":
      return cmdConfirm();
    case "metrics":
      return cmdMetrics();
    case "doctor":
      return cmdDoctor();
    case "burst":
      return cmdBurst(rest);
    case "maintain":
      return cmdMaintain(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(usage() + "\n");
      return 0;
    default:
      process.stderr.write(`error: unknown command '${cmd}'\n\n${usage()}\n`);
      return 2;
  }
}

// Only auto-run when invoked as a script (not when imported by tests).
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMain) {
  Promise.resolve(run(process.argv.slice(2))).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
