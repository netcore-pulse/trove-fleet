/**
 * Coverage + funnel metrics (A4) — the passive dashboard the handoff calls for
 * ("this service is watched *more* than the archive, because the web erodes it").
 *
 * Everything is READ from the store (the source of truth) — pure derivation, no
 * side effects, so it's trivially unit-tested against a seeded in-memory store.
 *
 * The handoff's metric list, all here:
 *   - Funnel counts by status: queued → attempting → submitted → confirmed;
 *     dead / needs_solver / needs_attention.
 *   - Coverage % = confirmed / total seed.
 *   - Confirm-loop latency (submit → confirmed): p50 / p95 over the samples.
 *   - Block rate: needs_solver / (terminal-ish attempts) — how often we hit a wall.
 *   - Per-ESP success rate: confirmed / submitted per ESP (which embeds to fix).
 *   - Proxy health: from the live ProxyPool (dead-proxy detection).
 */

import type { TargetStore } from "../store.ts";
import type { Status } from "../state.ts";
import type { ProxyPool, ProxyHealth } from "../fleet/proxy-pool.ts";

export interface LatencyStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface EspStat {
  esp: string;
  submitted: number;
  confirmed: number;
  /** confirmed / submitted, as a percentage. 0 when submitted === 0. */
  successPct: number;
}

export interface FleetMetrics {
  total: number;
  funnel: Record<Status, number>;
  /** Coverage % = confirmed / total seed. */
  coveragePct: number;
  /** Of the rows we actually attempted, the fraction submitted/confirmed. */
  submitRatePct: number;
  /**
   * Block rate: needs_solver / resolved-attempts, as a percentage. "resolved
   * attempts" = every row that left `queued`/`attempting` to a resolved bucket
   * (submitted, confirmed, needs_solver, no_form_found, needs_attention, dead).
   */
  blockRatePct: number;
  confirmLatency: LatencyStats;
  byEsp: EspStat[];
  proxies: ProxyHealth[];
  healthyProxies: number;
  totalProxies: number;
}

/** Percentile of a sample set (nearest-rank). Returns null for an empty set. */
export function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: rank = ceil(p/100 * N), 1-indexed, clamped.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

function latencyStats(samples: number[]): LatencyStats {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    maxMs: samples.length ? Math.max(...samples) : null,
  };
}

/**
 * Compute the full metrics snapshot from the store (+ optional live proxy pool).
 * Pure read; safe to call as often as a dashboard polls.
 */
export function computeMetrics(store: TargetStore, proxies?: ProxyPool): FleetMetrics {
  const funnel = store.statsByStatus();
  const total = store.count();

  // Attempts that have resolved out of queued/attempting into a real bucket.
  const resolved =
    funnel.submitted +
    funnel.confirmed +
    funnel.needs_solver +
    funnel.no_form_found +
    funnel.needs_attention +
    funnel.dead;

  const submittedOrConfirmed = funnel.submitted + funnel.confirmed;
  const submitRatePct = resolved === 0 ? 0 : (submittedOrConfirmed / resolved) * 100;
  const blockRatePct = resolved === 0 ? 0 : (funnel.needs_solver / resolved) * 100;

  const byEsp: EspStat[] = store.espFunnel().map((e) => ({
    esp: e.esp,
    submitted: e.submitted,
    confirmed: e.confirmed,
    successPct: e.submitted === 0 ? 0 : (e.confirmed / e.submitted) * 100,
  }));

  const proxyHealth = proxies ? proxies.health() : [];

  return {
    total,
    funnel,
    coveragePct: store.coveragePct(),
    submitRatePct,
    blockRatePct,
    confirmLatency: latencyStats(store.confirmLatencySamplesMs()),
    byEsp,
    proxies: proxyHealth,
    healthyProxies: proxies ? proxies.healthyCount() : 0,
    totalProxies: proxies ? proxies.size() : 0,
  };
}

/** Render the metrics snapshot as a human-readable funnel report (for `agent metrics`). */
export function formatMetrics(m: FleetMetrics): string {
  const pct = (n: number): string => `${n.toFixed(2)}%`;
  const ms = (n: number | null): string => (n === null ? "-" : `${(n / 1000).toFixed(1)}s`);

  const lines: string[] = [];
  lines.push("Trove Subscriber Agent — fleet metrics");
  lines.push("");
  lines.push(`Total seed: ${m.total}`);
  lines.push("");
  lines.push("Funnel:");
  // Ordered to mirror the lifecycle.
  const order: Status[] = [
    "queued",
    "attempting",
    "submitted",
    "confirmed",
    "needs_attention",
    "needs_solver",
    "no_form_found",
    "dead",
  ];
  for (const s of order) {
    lines.push(`  ${s.padEnd(16)} ${m.funnel[s]}`);
  }
  lines.push("");
  lines.push(`Coverage (confirmed/total): ${pct(m.coveragePct)}`);
  lines.push(`Submit rate (of resolved): ${pct(m.submitRatePct)}`);
  lines.push(`Block rate (needs_solver): ${pct(m.blockRatePct)}`);
  lines.push("");
  lines.push(
    `Confirm latency (submit→confirmed): n=${m.confirmLatency.count} ` +
      `p50=${ms(m.confirmLatency.p50Ms)} p95=${ms(m.confirmLatency.p95Ms)} max=${ms(m.confirmLatency.maxMs)}`,
  );
  lines.push("");
  if (m.byEsp.length) {
    lines.push("Per-ESP success (confirmed/submitted):");
    for (const e of m.byEsp) {
      lines.push(`  ${e.esp.padEnd(12)} ${e.confirmed}/${e.submitted}  ${pct(e.successPct)}`);
    }
    lines.push("");
  }
  lines.push(`Proxies: ${m.healthyProxies}/${m.totalProxies} healthy`);
  for (const p of m.proxies) {
    lines.push(
      `  ${p.id.padEnd(10)} ${p.healthy ? "healthy" : "DEAD   "} ` +
        `ok=${p.totalSuccesses} fail=${p.totalFailures} streak=${p.consecutiveFailures}` +
        (p.server ? ` (${redactProxy(p.server)})` : " (direct)"),
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Strip any embedded credentials from a proxy server string before printing
 * (forward-pass M9): `http://user:pass@host:port` → `http://host:port`. A
 * malformed value falls back to a host:port guess so we still never echo userinfo.
 */
export function redactProxy(server: string): string {
  try {
    const u = new URL(server);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return server.replace(/\/\/[^/@]*@/, "//");
  }
}
