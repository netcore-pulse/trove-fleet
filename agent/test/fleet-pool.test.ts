/**
 * A3 GATE — the bounded-concurrency fleet pool over a 50-target in-memory run.
 *
 * Deterministic + offline: the A1 subscribe step is a fake (makeFakeStep), the
 * clock is a ManualClock, proxies are an EnvProxyPool/NullProxyPool. No browser,
 * no network. The gate proves the orchestration contract:
 *   - bounded concurrency (peak in-flight ≤ pool size)
 *   - per-domain politeness (one in-flight per registrable domain)
 *   - the global rate cap is never exceeded (asserted via the injected clock)
 *   - proxy rotation + dead-proxy detection
 *   - isolation (a thrown step never stalls the fleet; the row falls to queued)
 *   - no double-subscribe (each domain attempted at most once per pass)
 */

import { describe, it, expect } from "vitest";
import { TargetStore } from "../src/store.ts";
import { runFleet } from "../src/fleet/pool.ts";
import { Throttle } from "../src/fleet/throttle.ts";
import { EnvProxyPool, NullProxyPool } from "../src/fleet/proxy-pool.ts";
import { ManualClock } from "../src/fleet/clock.ts";
import { makeFakeStep } from "./helpers/fake-step.ts";
import { distinctDomains } from "./helpers/seed-gen.ts";
import { driveToCompletion } from "./helpers/drive-clock.ts";

function seededStore(n: number): { store: TargetStore; domains: string[] } {
  const store = new TargetStore(":memory:");
  const domains = distinctDomains(n);
  store.ingest(domains.map((domain) => ({ domain })));
  return { store, domains };
}

describe("A3 gate — bounded concurrency + per-domain politeness", () => {
  it("runs 50 targets concurrently, peak in-flight ≤ pool size, one in-flight per domain", async () => {
    const { store } = seededStore(50);
    const clock = new ManualClock(0);
    const proxies = new EnvProxyPool(["http://a:1", "http://b:2", "http://c:3", "http://d:4"], {
      clock,
    });
    const concurrency = 4;
    // Each step "holds" for 10ms of virtual time so slots genuinely overlap.
    const fake = makeFakeStep({ holdMs: 10, sleep: (ms) => clock.sleep(ms) });
    // Throttle generous enough not to be the bottleneck for the concurrency check.
    const throttle = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const result = await driveToCompletion(
      clock,
      runFleet({ store, step: fake.step, throttle, proxies, concurrency, clock }),
    );

    // All 50 attempted, all submitted.
    expect(result.attempted).toBe(50);
    expect(result.byStatus.submitted).toBe(50);
    expect(store.statsByStatus().submitted).toBe(50);
    expect(store.statsByStatus().queued).toBe(0);

    // Bounded concurrency: never more than `concurrency` in flight.
    expect(fake.peakInFlight).toBeGreaterThan(1); // genuinely concurrent
    expect(fake.peakInFlight).toBeLessThanOrEqual(concurrency);

    // Per-domain politeness: no domain was ever in-flight twice at once.
    expect(fake.concurrentDomains.size).toBe(0);

    // No double-subscribe: each domain attempted exactly once.
    for (const [, count] of fake.countByDomain) expect(count).toBe(1);
    expect(fake.countByDomain.size).toBe(50);

    // Proxy rotation: more than one proxy id was used.
    expect(new Set(fake.proxyIds).size).toBeGreaterThan(1);
  });

  it("defaults concurrency to the proxy pool size", async () => {
    const { store } = seededStore(20);
    const clock = new ManualClock(0);
    const proxies = new EnvProxyPool(["http://a:1", "http://b:2"], { clock });
    const fake = makeFakeStep({ holdMs: 5, sleep: (ms) => clock.sleep(ms) });
    const throttle = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    await driveToCompletion(clock, runFleet({ store, step: fake.step, throttle, proxies, clock }));
    // Pool size 2 → at most 2 in flight.
    expect(fake.peakInFlight).toBeLessThanOrEqual(2);
  });
});

describe("A3 gate — global rate cap honored under concurrency", () => {
  it("never exceeds the global rate cap across the whole 50-target run", async () => {
    const { store } = seededStore(50);
    const clock = new ManualClock(0);
    const proxies = new EnvProxyPool(["http://a:1", "http://b:2", "http://c:3"], { clock });
    const cap = 3;
    const windowMs = 1000;
    // Record admission timestamps via onAttempt is post-hoc; instead assert the
    // store + reconstruct from the throttle's effect by capturing now() per call.
    const admittedAt: number[] = [];
    const fake = makeFakeStep({
      holdMs: 1,
      sleep: (ms) => clock.sleep(ms),
      statusFor: () => "submitted",
    });
    const wrappedStep: typeof fake.step = async (ctx) => {
      admittedAt.push(clock.now());
      return fake.step(ctx);
    };
    const throttle = new Throttle({
      globalMaxPerWindow: cap,
      windowMs,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    await driveToCompletion(
      clock,
      runFleet({ store, step: wrappedStep, throttle, proxies, concurrency: 5, clock }),
    );

    expect(admittedAt.length).toBe(50);
    // Sliding-window invariant: no window of `windowMs` contains more than `cap`
    // attempt-starts.
    const sorted = [...admittedAt].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
      const end = sorted[i]!;
      const start = end - windowMs;
      const inWindow = sorted.filter((x) => x > start && x <= end).length;
      expect(inWindow).toBeLessThanOrEqual(cap);
    }
  });
});

describe("A3 gate — needs_solver parking (CAPTCHA detected, not looped)", () => {
  it("a walled target is parked as needs_solver and never re-attempted in the pass", async () => {
    const { store, domains } = seededStore(10);
    const walled = new Set(domains.slice(0, 3)); // 3 of 10 hit a wall
    const clock = new ManualClock(0);
    const proxies = new NullProxyPool({ clock });
    const fake = makeFakeStep({
      sleep: (ms) => clock.sleep(ms),
      statusFor: (domain) => (walled.has(domain) ? "needs_solver" : "submitted"),
    });
    const throttle = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const result = await driveToCompletion(
      clock,
      runFleet({ store, step: fake.step, throttle, proxies, concurrency: 1, clock }),
    );

    expect(result.byStatus.needs_solver).toBe(3);
    expect(result.byStatus.submitted).toBe(7);
    expect(store.statsByStatus().needs_solver).toBe(3);
    // Parked rows are NOT looped: each walled domain attempted exactly once.
    for (const d of walled) expect(fake.countByDomain.get(d)).toBe(1);
  });
});

describe("A3 gate — isolation (one failure never stalls the fleet)", () => {
  it("a thrown step falls its row back to queued; the rest still complete", async () => {
    const { store, domains } = seededStore(10);
    const boom = new Set([domains[2]!, domains[7]!]);
    const clock = new ManualClock(0);
    const proxies = new EnvProxyPool(["http://a:1", "http://b:2"], { clock });
    const fake = makeFakeStep({ throwFor: boom, sleep: (ms) => clock.sleep(ms) });
    const throttle = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const result = await driveToCompletion(
      clock,
      runFleet({ store, step: fake.step, throttle, proxies, concurrency: 2, clock }),
    );

    // The 2 throwers fell back to queued (legal attempting→queued); never stranded.
    expect(result.errored).toBe(2);
    expect(store.statsByStatus().attempting).toBe(0);
    expect(store.statsByStatus().queued).toBe(2);
    // The other 8 submitted.
    expect(store.statsByStatus().submitted).toBe(8);

    // A failed step reported its proxy as unhealthy-trending (failure recorded).
    const totalFailures = proxies.health().reduce((s, p) => s + p.totalFailures, 0);
    expect(totalFailures).toBeGreaterThanOrEqual(2);
  });
});

describe("A3 gate — limit budget", () => {
  it("processes at most `limit` targets and leaves the rest queued", async () => {
    const { store } = seededStore(50);
    const clock = new ManualClock(0);
    const proxies = new NullProxyPool({ clock });
    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const throttle = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const result = await driveToCompletion(
      clock,
      runFleet({ store, step: fake.step, throttle, proxies, concurrency: 4, clock, limit: 10 }),
    );

    expect(result.attempted).toBe(10);
    expect(store.statsByStatus().submitted).toBe(10);
    expect(store.statsByStatus().queued).toBe(40);
  });
});
