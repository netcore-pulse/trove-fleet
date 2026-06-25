/**
 * Alerts (A4) — turn the metrics snapshot into actionable flags.
 *
 * The handoff names exactly these failure modes to alert on:
 *   - "confirm rate collapses"      → few/no submitted rows are reaching confirmed
 *   - "block rate spikes"           → proxies burned or fingerprint stale
 *   - "confirm-loop stalls"         → archive seam broken (submitted piling up,
 *                                      nothing confirming)
 *   - (operational) proxy pool exhausted → all egress IPs marked dead
 *
 * Wiring an alert to a pager is deploy-time; here we PRODUCE structured alerts
 * (level + code + message + the numbers behind them) so `agent doctor` can print
 * them and a future shipper can route them. Pure function of a metrics snapshot
 * + thresholds → deterministic + unit-testable.
 *
 * Thresholds are deliberately conservative defaults; all overridable so an
 * operator can tune them per environment without a code change.
 */

import type { FleetMetrics } from "./metrics.ts";

export type AlertLevel = "info" | "warn" | "critical";

export type AlertCode =
  | "confirm_rate_collapse"
  | "block_rate_spike"
  | "confirm_loop_stall"
  | "proxy_pool_exhausted";

export interface Alert {
  level: AlertLevel;
  code: AlertCode;
  message: string;
  /** The metric values that triggered it (for the dashboard / debugging). */
  context: Record<string, number | string>;
}

export interface AlertThresholds {
  /**
   * If at least this many rows have been submitted but the confirm rate
   * (confirmed / submitted-or-confirmed) is below `minConfirmRatePct`, alert.
   * The minimum-sample guard avoids crying wolf on a cold start.
   */
  minSubmittedForConfirmCheck: number;
  minConfirmRatePct: number;
  /** Block rate (needs_solver / resolved) at/above this is a spike. */
  blockRateSpikePct: number;
  /**
   * Confirm-loop stall: at least this many rows sit in `submitted` while the
   * confirmed count is at/below `stallMaxConfirmed` — i.e. submits pile up but
   * nothing closes the loop (archive seam likely broken).
   */
  stallMinSubmitted: number;
  stallMaxConfirmed: number;
}

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  minSubmittedForConfirmCheck: 20,
  minConfirmRatePct: 40,
  blockRateSpikePct: 30,
  stallMinSubmitted: 25,
  stallMaxConfirmed: 0,
};

/**
 * Evaluate the metrics against thresholds → list of fired alerts (empty = all
 * clear). Order is by severity (critical first) then by code for stability.
 */
export function evaluateAlerts(
  m: FleetMetrics,
  thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS,
): Alert[] {
  const alerts: Alert[] = [];
  const submitted = m.funnel.submitted;
  const confirmed = m.funnel.confirmed;
  const submittedOrConfirmed = submitted + confirmed;

  // 1. Confirm-rate collapse: enough submits to judge, but too few confirm.
  if (submittedOrConfirmed >= thresholds.minSubmittedForConfirmCheck) {
    const confirmRatePct = submittedOrConfirmed === 0 ? 0 : (confirmed / submittedOrConfirmed) * 100;
    if (confirmRatePct < thresholds.minConfirmRatePct) {
      alerts.push({
        level: "critical",
        code: "confirm_rate_collapse",
        message: `Confirm rate ${confirmRatePct.toFixed(1)}% is below ${thresholds.minConfirmRatePct}% — confirm loop or archive seam may be failing.`,
        context: {
          confirmRatePct: round(confirmRatePct),
          confirmed,
          submittedOrConfirmed,
        },
      });
    }
  }

  // 2. Confirm-loop STALL: submits piling up, (near-)nothing confirmed. This is
  //    the sharper "archive seam broken" signal vs. the rate check above.
  if (submitted >= thresholds.stallMinSubmitted && confirmed <= thresholds.stallMaxConfirmed) {
    alerts.push({
      level: "critical",
      code: "confirm_loop_stall",
      message: `${submitted} rows submitted but only ${confirmed} confirmed — confirm loop appears stalled (archive seam / poller down).`,
      context: { submitted, confirmed },
    });
  }

  // 3. Block-rate spike: too many needs_solver among resolved attempts.
  if (m.blockRatePct >= thresholds.blockRateSpikePct) {
    alerts.push({
      level: "warn",
      code: "block_rate_spike",
      message: `Block rate ${m.blockRatePct.toFixed(1)}% at/above ${thresholds.blockRateSpikePct}% — proxies may be burned or the fingerprint is stale.`,
      context: { blockRatePct: round(m.blockRatePct), needsSolver: m.funnel.needs_solver },
    });
  }

  // 4. Proxy pool exhausted: every egress IP marked dead.
  if (m.totalProxies > 0 && m.healthyProxies === 0) {
    alerts.push({
      level: "critical",
      code: "proxy_pool_exhausted",
      message: `All ${m.totalProxies} proxies are unhealthy — egress is degraded; rotate in fresh proxies.`,
      context: { totalProxies: m.totalProxies, healthyProxies: m.healthyProxies },
    });
  }

  const rank: Record<AlertLevel, number> = { critical: 0, warn: 1, info: 2 };
  alerts.sort((a, b) => rank[a.level] - rank[b.level] || a.code.localeCompare(b.code));
  return alerts;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Render alerts for `agent doctor`. */
export function formatAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "No alerts — fleet healthy.\n";
  const lines: string[] = [`${alerts.length} alert(s):`, ""];
  for (const a of alerts) {
    lines.push(`  [${a.level.toUpperCase()}] ${a.code}: ${a.message}`);
  }
  lines.push("");
  return lines.join("\n");
}
