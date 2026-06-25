/**
 * A4 — alerts. The handoff's three named failure modes plus proxy exhaustion,
 * driven against hand-built metrics snapshots so each threshold is asserted.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateAlerts,
  formatAlerts,
  DEFAULT_ALERT_THRESHOLDS,
  type AlertCode,
} from "../src/observability/alerts.ts";
import type { FleetMetrics } from "../src/observability/metrics.ts";

function metrics(partial: Partial<FleetMetrics> = {}): FleetMetrics {
  return {
    total: 1000,
    funnel: {
      queued: 0,
      attempting: 0,
      submitted: 0,
      confirmed: 0,
      needs_solver: 0,
      no_form_found: 0,
      needs_attention: 0,
      dead: 0,
    },
    coveragePct: 0,
    submitRatePct: 0,
    blockRatePct: 0,
    confirmLatency: { count: 0, p50Ms: null, p95Ms: null, maxMs: null },
    byEsp: [],
    proxies: [],
    healthyProxies: 1,
    totalProxies: 1,
    ...partial,
  };
}

function codes(m: FleetMetrics): AlertCode[] {
  return evaluateAlerts(m).map((a) => a.code);
}

describe("A4 alerts — healthy fleet", () => {
  it("no alerts when everything is within thresholds", () => {
    const m = metrics({
      funnel: { ...metrics().funnel, submitted: 10, confirmed: 90 },
      blockRatePct: 5,
    });
    expect(evaluateAlerts(m)).toEqual([]);
    expect(formatAlerts([])).toContain("healthy");
  });
});

describe("A4 alerts — confirm-rate collapse", () => {
  it("fires when enough submits but the confirm rate is below the floor", () => {
    // 100 submitted, 5 confirmed → confirm rate 5/105 ≈ 4.8% < 40%.
    const m = metrics({ funnel: { ...metrics().funnel, submitted: 100, confirmed: 5 } });
    expect(codes(m)).toContain("confirm_rate_collapse");
  });

  it("does NOT fire below the minimum sample (cold start)", () => {
    // 5 submitted, 0 confirmed — below minSubmittedForConfirmCheck (20).
    const m = metrics({ funnel: { ...metrics().funnel, submitted: 5, confirmed: 0 } });
    expect(codes(m)).not.toContain("confirm_rate_collapse");
  });
});

describe("A4 alerts — confirm-loop stall", () => {
  it("fires when submits pile up but nothing confirms (archive seam broken)", () => {
    const m = metrics({ funnel: { ...metrics().funnel, submitted: 50, confirmed: 0 } });
    const cs = codes(m);
    expect(cs).toContain("confirm_loop_stall");
  });

  it("does not fire once confirmations are flowing", () => {
    const m = metrics({ funnel: { ...metrics().funnel, submitted: 50, confirmed: 30 } });
    expect(codes(m)).not.toContain("confirm_loop_stall");
  });
});

describe("A4 alerts — block-rate spike", () => {
  it("fires when block rate is at/above the spike threshold", () => {
    const m = metrics({ blockRatePct: 35, funnel: { ...metrics().funnel, needs_solver: 35 } });
    expect(codes(m)).toContain("block_rate_spike");
  });

  it("does not fire below the threshold", () => {
    const m = metrics({ blockRatePct: 10 });
    expect(codes(m)).not.toContain("block_rate_spike");
  });
});

describe("A4 alerts — proxy pool exhausted", () => {
  it("fires when every proxy is unhealthy", () => {
    const m = metrics({ totalProxies: 3, healthyProxies: 0 });
    expect(codes(m)).toContain("proxy_pool_exhausted");
  });

  it("does not fire for the null (direct) pool", () => {
    const m = metrics({ totalProxies: 1, healthyProxies: 1 });
    expect(codes(m)).not.toContain("proxy_pool_exhausted");
  });
});

describe("A4 alerts — ordering + thresholds override", () => {
  it("sorts critical before warn", () => {
    const m = metrics({
      funnel: { ...metrics().funnel, submitted: 50, confirmed: 0 },
      blockRatePct: 40,
      needs_solver: 40,
    } as Partial<FleetMetrics>);
    const alerts = evaluateAlerts(m);
    expect(alerts[0]!.level).toBe("critical");
    expect(alerts.some((a) => a.level === "warn")).toBe(true);
  });

  it("respects custom thresholds", () => {
    const m = metrics({ blockRatePct: 15 });
    expect(codes(m)).not.toContain("block_rate_spike");
    const strict = evaluateAlerts(m, { ...DEFAULT_ALERT_THRESHOLDS, blockRateSpikePct: 10 });
    expect(strict.map((a) => a.code)).toContain("block_rate_spike");
  });
});
