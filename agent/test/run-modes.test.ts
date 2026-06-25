/**
 * A5 GATE — burst + maintenance run modes.
 *
 * Deterministic + offline: fake step, ManualClock, in-memory store. Proves:
 *   - burst drains the seed under the bounded/throttled pool;
 *   - burst is RESUMABLE: kill mid-run (process only `limit`) → re-run → no
 *     double-subscribe, picks up exactly where it left off;
 *   - a confirmed domain is NEVER re-attempted across passes;
 *   - maintenance re-queues `needs_attention` + `needs_solver` + new seed rows,
 *     reconciles confirmations, and drains.
 */

import { describe, it, expect } from "vitest";
import { TargetStore } from "../src/store.ts";
import { runBurst } from "../src/run/burst.ts";
import { runMaintenance } from "../src/run/maintenance.ts";
import { NullProxyPool, EnvProxyPool } from "../src/fleet/proxy-pool.ts";
import { ManualClock } from "../src/fleet/clock.ts";
import { makeFakeStep } from "./helpers/fake-step.ts";
import { distinctDomains } from "./helpers/seed-gen.ts";
import { driveToCompletion } from "./helpers/drive-clock.ts";
import type { ThrottleOptions } from "../src/fleet/throttle.ts";

const FAST_THROTTLE: Omit<ThrottleOptions, "clock"> = {
  globalMaxPerWindow: 1000,
  windowMs: 1000,
  perDomainMinDelayMs: 0,
  jitterMs: 0,
};

function seeded(n: number): { store: TargetStore; domains: string[] } {
  const store = new TargetStore(":memory:");
  const domains = distinctDomains(n);
  store.ingest(domains.map((domain) => ({ domain })));
  return { store, domains };
}

describe("A5 — burst drains the seed", () => {
  it("processes the whole queue and reports the breakdown", async () => {
    const { store } = seeded(50);
    const clock = new ManualClock(0);
    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });

    const result = await driveToCompletion(
      clock,
      runBurst({
        store,
        step: fake.step,
        proxies: new EnvProxyPool(["http://a:1", "http://b:2"], { clock }),
        throttle: { ...FAST_THROTTLE },
        clock,
      }),
    );

    expect(result.attempted).toBe(50);
    expect(result.byStatus.submitted).toBe(50);
    expect(result.remainingQueued).toBe(0);
    store.close();
  });
});

describe("A5 — burst is resumable (kill mid-run → re-run, no double-subscribe)", () => {
  it("a budgeted first pass + a second pass cover the seed exactly once each", async () => {
    const { store, domains } = seeded(50);
    const clock = new ManualClock(0);
    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const proxies = new NullProxyPool({ clock });

    // First "burst" is killed after 20 (simulated via the limit budget).
    const first = await driveToCompletion(
      clock,
      runBurst({ store, step: fake.step, proxies, throttle: { ...FAST_THROTTLE }, clock, limit: 20 }),
    );
    expect(first.attempted).toBe(20);
    expect(store.statsByStatus().submitted).toBe(20);
    expect(store.statsByStatus().queued).toBe(30);

    // Re-run (resume): picks up the remaining 30, never re-touches the first 20.
    const second = await driveToCompletion(
      clock,
      runBurst({ store, step: fake.step, proxies, throttle: { ...FAST_THROTTLE }, clock }),
    );
    expect(second.attempted).toBe(30);
    expect(store.statsByStatus().submitted).toBe(50);
    expect(store.statsByStatus().queued).toBe(0);

    // The cardinal property: every domain attempted EXACTLY once across both passes.
    expect(fake.countByDomain.size).toBe(50);
    for (const d of domains) expect(fake.countByDomain.get(d)).toBe(1);
    store.close();
  });

  it("a confirmed domain is never re-attempted by a later burst", async () => {
    const { store, domains } = seeded(5);
    const clock = new ManualClock(0);
    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const proxies = new NullProxyPool({ clock });
    const confirmedDomain = domains[0]!;

    // Manually drive one domain to confirmed (the terminal, no-double-subscribe state).
    store.setStatus(confirmedDomain, "attempting");
    store.setStatus(confirmedDomain, "submitted");
    store.setStatus(confirmedDomain, "confirmed");

    await driveToCompletion(
      clock,
      runBurst({ store, step: fake.step, proxies, throttle: { ...FAST_THROTTLE }, clock }),
    );

    // The confirmed domain was never leased/attempted; the other 4 were.
    expect(fake.countByDomain.has(confirmedDomain)).toBe(false);
    expect(fake.countByDomain.size).toBe(4);
    expect(store.statsByStatus().confirmed).toBe(1);
    store.close();
  });

  it("simulated mid-run kill: an attempting row's lapsed lease is reclaimed on resume", async () => {
    const { store } = seeded(3);
    const clock = new ManualClock(0);

    // Simulate a worker that died mid-attempt: lease a row, then "die" (never
    // resolve it). Its lease has a TTL; after expiry the next pass reclaims it.
    // (The store's leasing uses real Date.now for TTLs — an A0 design choice —
    // so we reclaim with a timestamp past the real lease expiry.)
    const leaseTtl = 1000;
    const leaseStart = Date.now();
    const leased = store.leaseNext("dead-worker", leaseTtl);
    expect(leased?.status).toBe("attempting");
    expect(store.statsByStatus().attempting).toBe(1);

    // The next pass would reclaim the lapsed lease lazily; maintenance does it
    // eagerly. Release everything older than the lease expiry.
    store.releaseExpiredLeases(leaseStart + leaseTtl + 1);
    expect(store.statsByStatus().attempting).toBe(0);
    expect(store.statsByStatus().queued).toBe(3);

    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const result = await driveToCompletion(
      clock,
      runBurst({
        store,
        step: fake.step,
        proxies: new NullProxyPool({ clock }),
        throttle: { ...FAST_THROTTLE },
        clock,
      }),
    );

    // All 3 (including the reclaimed one) end submitted — nothing stranded.
    expect(result.attempted).toBe(3);
    expect(store.statsByStatus().submitted).toBe(3);
    expect(store.statsByStatus().attempting).toBe(0);
    store.close();
  });
});

describe("A5 — maintenance trickle", () => {
  it("re-queues needs_attention + needs_solver + no_form_found and drains them", async () => {
    const { store, domains } = seeded(10);
    const clock = new ManualClock(0);

    // Park a few rows in each re-queueable status.
    const park = (d: string, to: "needs_attention" | "needs_solver" | "no_form_found") => {
      store.setStatus(d, "attempting");
      if (to === "needs_attention") {
        store.setStatus(d, "submitted");
        store.setStatus(d, "needs_attention");
      } else {
        store.setStatus(d, to);
      }
    };
    park(domains[0]!, "needs_attention");
    park(domains[1]!, "needs_solver");
    park(domains[2]!, "no_form_found");
    // Leave the rest queued (new seed rows).

    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const result = await driveToCompletion(
      clock,
      runMaintenance({
        store,
        step: fake.step,
        proxies: new NullProxyPool({ clock }),
        throttle: { ...FAST_THROTTLE },
        requeueOlderThanMs: 0, // re-queue immediately for the test
        clock,
      }),
    );

    expect(result.requeued.needs_attention).toBe(1);
    expect(result.requeued.needs_solver).toBe(1);
    expect(result.requeued.no_form_found).toBe(1);
    // All 10 (3 re-queued + 7 new) drained to submitted.
    expect(result.drain.attempted).toBe(10);
    expect(store.statsByStatus().submitted).toBe(10);
    store.close();
  });

  it("does NOT re-queue parked rows newer than the age guard", async () => {
    const { store, domains } = seeded(3);
    const clock = new ManualClock(0);
    store.setStatus(domains[0]!, "attempting");
    store.setStatus(domains[0]!, "needs_solver");

    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const result = await driveToCompletion(
      clock,
      runMaintenance({
        store,
        step: fake.step,
        proxies: new NullProxyPool({ clock }),
        throttle: { ...FAST_THROTTLE },
        requeueOlderThanMs: 60 * 60_000, // 1h guard — the row was just parked
        clock,
      }),
    );
    expect(result.requeued.needs_solver).toBe(0);
    expect(store.statsByStatus().needs_solver).toBe(1);
    store.close();
  });

  it("reconciles freshly-confirmed addresses onto their store rows", async () => {
    const { store, domains } = seeded(3);
    const clock = new ManualClock(0);
    // Two rows are submitted (awaiting confirm).
    for (const d of [domains[0]!, domains[1]!]) {
      store.setStatus(d, "attempting");
      store.setStatus(d, "submitted");
    }

    const fake = makeFakeStep({ sleep: (ms) => clock.sleep(ms) });
    const result = await driveToCompletion(
      clock,
      runMaintenance({
        store,
        step: fake.step,
        proxies: new NullProxyPool({ clock }),
        throttle: { ...FAST_THROTTLE },
        // The archive reports domain0 confirmed; domain1 still pending.
        reconcileConfirmed: async () => [domains[0]!],
        clock,
      }),
    );

    expect(result.reconciledConfirmed).toBe(1);
    expect(store.get(domains[0]!)?.status).toBe("confirmed");
    expect(store.get(domains[1]!)?.status).toBe("submitted");
    store.close();
  });
});
