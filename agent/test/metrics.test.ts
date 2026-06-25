/**
 * A4 — coverage + funnel metrics. Driven against a seeded in-memory store with
 * hand-walked state transitions, so every metric (coverage, submit rate, block
 * rate, confirm-loop latency, per-ESP success) is asserted exactly.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { TargetStore } from "../src/store.ts";
import { computeMetrics, formatMetrics, percentile } from "../src/observability/metrics.ts";
import { EnvProxyPool, NullProxyPool } from "../src/fleet/proxy-pool.ts";

afterEach(() => vi.useRealTimers());

/** Seed n domains and walk a controlled set through the machine. */
function buildStore(): TargetStore {
  const store = new TargetStore(":memory:");
  store.ingest(Array.from({ length: 10 }, (_, i) => ({ domain: `brand${i}.com` })));
  return store;
}

describe("percentile", () => {
  it("nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10], 50)).toBe(10);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 95)).toBe(40);
    expect(percentile([10, 20, 30, 40], 100)).toBe(40);
  });
});

describe("A4 — funnel + coverage", () => {
  it("coverage % = confirmed / total seed", () => {
    const store = buildStore();
    // Confirm 2 of 10: queued→attempting→submitted→confirmed.
    for (const d of ["brand0.com", "brand1.com"]) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted");
      store.setStatus(d, "confirmed");
    }
    const m = computeMetrics(store);
    expect(m.total).toBe(10);
    expect(m.funnel.confirmed).toBe(2);
    expect(m.coveragePct).toBeCloseTo(20, 5);
    store.close();
  });

  it("submit rate + block rate over resolved attempts", () => {
    const store = buildStore();
    // 4 submitted, 1 confirmed (a submitted that advanced), 2 needs_solver,
    // 1 no_form_found → resolved = these. Remaining 2 stay queued.
    const subm = ["brand0.com", "brand1.com", "brand2.com", "brand3.com"];
    for (const d of subm) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted");
    }
    store.setStatus("brand0.com", "confirmed");
    for (const d of ["brand4.com", "brand5.com"]) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "needs_solver");
    }
    store.setStatus("brand6.com", "attempting");
    store.setStatus("brand6.com", "no_form_found");

    const m = computeMetrics(store);
    // resolved = submitted(3) + confirmed(1) + needs_solver(2) + no_form_found(1) = 7
    expect(m.funnel.submitted).toBe(3);
    expect(m.funnel.confirmed).toBe(1);
    expect(m.funnel.needs_solver).toBe(2);
    // submit rate = (submitted+confirmed)/resolved = 4/7
    expect(m.submitRatePct).toBeCloseTo((4 / 7) * 100, 4);
    // block rate = needs_solver/resolved = 2/7
    expect(m.blockRatePct).toBeCloseTo((2 / 7) * 100, 4);
    store.close();
  });
});

describe("A4 — confirm-loop latency (submit → confirmed)", () => {
  it("measures submit→confirmed deltas via the timestamps", () => {
    const store = buildStore();
    vi.useFakeTimers();

    // brand0: submit at t=1000, confirm at t=4000 → 3000ms.
    vi.setSystemTime(1000);
    store.setStatus("brand0.com", "attempting");
    store.setStatus("brand0.com", "submitted");
    vi.setSystemTime(4000);
    store.setStatus("brand0.com", "confirmed");

    // brand1: submit at t=2000, confirm at t=3000 → 1000ms.
    vi.setSystemTime(2000);
    store.setStatus("brand1.com", "attempting");
    store.setStatus("brand1.com", "submitted");
    vi.setSystemTime(3000);
    store.setStatus("brand1.com", "confirmed");

    const samples = store.confirmLatencySamplesMs().sort((a, b) => a - b);
    expect(samples).toEqual([1000, 3000]);

    const m = computeMetrics(store);
    expect(m.confirmLatency.count).toBe(2);
    expect(m.confirmLatency.p50Ms).toBe(1000); // nearest-rank p50 of [1000,3000]
    expect(m.confirmLatency.maxMs).toBe(3000);
    store.close();
  });
});

describe("A4 — per-ESP success rate", () => {
  it("buckets confirmed/submitted by detected ESP", () => {
    const store = buildStore();
    // klaviyo: 2 submitted, 1 confirmed. mailchimp: 1 submitted, 0 confirmed.
    store.setStatus("brand0.com", "attempting");
    store.setStatus("brand0.com", "submitted", { esp: "klaviyo" });
    store.setStatus("brand0.com", "confirmed");
    store.setStatus("brand1.com", "attempting");
    store.setStatus("brand1.com", "submitted", { esp: "klaviyo" });
    store.setStatus("brand2.com", "attempting");
    store.setStatus("brand2.com", "submitted", { esp: "mailchimp" });

    const m = computeMetrics(store);
    const klaviyo = m.byEsp.find((e) => e.esp === "klaviyo")!;
    const mailchimp = m.byEsp.find((e) => e.esp === "mailchimp")!;
    expect(klaviyo.submitted).toBe(2);
    expect(klaviyo.confirmed).toBe(1);
    expect(klaviyo.successPct).toBeCloseTo(50, 4);
    expect(mailchimp.submitted).toBe(1);
    expect(mailchimp.confirmed).toBe(0);
    expect(mailchimp.successPct).toBe(0);
    store.close();
  });
});

describe("A4 — proxy health folded into metrics", () => {
  it("reports healthy/total from the live pool", () => {
    const store = buildStore();
    const proxies = new EnvProxyPool(["http://a:1", "http://b:2"], { deadThreshold: 1 });
    proxies.acquire().report(false); // kill proxy-0
    const m = computeMetrics(store, proxies);
    expect(m.totalProxies).toBe(2);
    expect(m.healthyProxies).toBe(1);
    expect(m.proxies.find((p) => p.id === "proxy-0")!.healthy).toBe(false);
    store.close();
  });

  it("empty store + null pool yields zeroed, non-crashing metrics", () => {
    const store = new TargetStore(":memory:");
    const m = computeMetrics(store, new NullProxyPool());
    expect(m.total).toBe(0);
    expect(m.coveragePct).toBe(0);
    expect(m.submitRatePct).toBe(0);
    expect(m.blockRatePct).toBe(0);
    expect(m.confirmLatency.count).toBe(0);
    expect(formatMetrics(m)).toContain("Total seed: 0");
    store.close();
  });
});
