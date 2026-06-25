import { describe, it, expect } from "vitest";
import { Throttle, throttleOptionsFromEnv, DEFAULT_THROTTLE } from "../src/fleet/throttle.ts";
import { ManualClock } from "../src/fleet/clock.ts";

/**
 * The throttle is the anti-block keystone. These tests drive it with a
 * ManualClock so we assert EXACT admission timestamps — proving the global rate
 * cap is never exceeded and same-domain attempts are always spaced — with zero
 * real waiting.
 */

/** Admit `n` attempts (different domains) and return the clock time of each. */
async function admitSequential(
  t: Throttle,
  clock: ManualClock,
  domains: string[],
): Promise<number[]> {
  const times: number[] = [];
  for (const d of domains) {
    // gate() may sleep; resolve it by draining the clock between gates.
    const p = t.gate(d).then(() => times.push(clock.now()));
    await clock.runAll();
    await p;
  }
  return times;
}

describe("Throttle — global rate cap (no jitter)", () => {
  it("admits up to the cap instantly, then spaces the rest by the window", async () => {
    const clock = new ManualClock(0);
    // 3 admissions per 1000ms window.
    const t = new Throttle({
      globalMaxPerWindow: 3,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const times = await admitSequential(t, clock, ["a.com", "b.com", "c.com", "d.com", "e.com"]);

    // First 3 admit at t=0 (window not full). The 4th must wait until the oldest
    // (t=0) ages out at t=1000; the 5th likewise (next oldest at t=0 → 1000).
    expect(times.slice(0, 3)).toEqual([0, 0, 0]);
    expect(times[3]).toBe(1000);
    expect(times[4]).toBe(1000);
  });

  it("never exceeds the cap in ANY sliding window", async () => {
    const clock = new ManualClock(0);
    const cap = 4;
    const windowMs = 1000;
    const t = new Throttle({
      globalMaxPerWindow: cap,
      windowMs,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });

    const domains = Array.from({ length: 20 }, (_, i) => `brand${i}.com`);
    const times = await admitSequential(t, clock, domains);

    // For every admission, at most `cap` admissions fall within the preceding
    // window (inclusive) — the sliding-window invariant.
    for (let i = 0; i < times.length; i++) {
      const end = times[i]!;
      const start = end - windowMs;
      const inWindow = times.filter((x) => x > start && x <= end).length;
      expect(inWindow).toBeLessThanOrEqual(cap);
    }
  });
});

describe("Throttle — per-domain spacing", () => {
  it("spaces two attempts to the SAME domain by at least perDomainMinDelayMs", async () => {
    const clock = new ManualClock(0);
    const t = new Throttle({
      globalMaxPerWindow: 1000, // effectively unlimited globally
      windowMs: 1000,
      perDomainMinDelayMs: 500,
      jitterMs: 0,
      clock,
    });

    const times = await admitSequential(t, clock, ["x.com", "x.com", "x.com"]);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(500);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(500);
  });

  it("does NOT space DIFFERENT domains by the per-domain delay", async () => {
    const clock = new ManualClock(0);
    const t = new Throttle({
      globalMaxPerWindow: 1000,
      windowMs: 1000,
      perDomainMinDelayMs: 5000,
      jitterMs: 0,
      clock,
    });
    const times = await admitSequential(t, clock, ["a.com", "b.com", "c.com"]);
    // All admit at t=0: the per-domain delay only governs repeats of the same domain.
    expect(times).toEqual([0, 0, 0]);
  });
});

describe("Throttle — jitter", () => {
  it("adds bounded jitter from the injected RNG", async () => {
    const clock = new ManualClock(0);
    // RNG fixed at 1 → max jitter every time.
    const t = new Throttle({
      globalMaxPerWindow: 100,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 200,
      clock,
      random: () => 0.999999,
    });
    const p = t.gate("a.com");
    await clock.runAll();
    await p;
    // Admitted after the jitter sleep (<= jitterMs).
    expect(clock.now()).toBeGreaterThan(0);
    expect(clock.now()).toBeLessThanOrEqual(200);
  });

  it("zero jitter admits at exactly the computed time", async () => {
    const clock = new ManualClock(0);
    const t = new Throttle({
      globalMaxPerWindow: 100,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });
    const p = t.gate("a.com");
    await clock.runAll();
    await p;
    expect(clock.now()).toBe(0);
  });
});

describe("Throttle — config", () => {
  it("waitFor is consistent with the window/spacing math", () => {
    const clock = new ManualClock(0);
    const t = new Throttle({
      globalMaxPerWindow: 1,
      windowMs: 1000,
      perDomainMinDelayMs: 0,
      jitterMs: 0,
      clock,
    });
    // No admissions yet → no wait.
    expect(t.waitFor("a.com")).toBe(0);
  });

  it("validates options", () => {
    expect(() => new Throttle({ globalMaxPerWindow: 0, windowMs: 1, perDomainMinDelayMs: 0 })).toThrow();
    expect(() => new Throttle({ globalMaxPerWindow: 1, windowMs: 0, perDomainMinDelayMs: 0 })).toThrow();
  });

  it("throttleOptionsFromEnv falls back to defaults and parses overrides", () => {
    const dflt = throttleOptionsFromEnv({});
    expect(dflt.globalMaxPerWindow).toBe(DEFAULT_THROTTLE.globalMaxPerWindow);
    const over = throttleOptionsFromEnv({ TROVE_RATE_MAX: "5", TROVE_JITTER_MS: "10" });
    expect(over.globalMaxPerWindow).toBe(5);
    expect(over.jitterMs).toBe(10);
    // Garbage falls back.
    expect(throttleOptionsFromEnv({ TROVE_RATE_MAX: "nope" }).globalMaxPerWindow).toBe(
      DEFAULT_THROTTLE.globalMaxPerWindow,
    );
  });

  it("TROVE_JITTER_MS=0 disables jitter (deterministic run), not falls back to default", () => {
    // The deterministic-run setting: 0 must be honored, not treated as "unset".
    expect(throttleOptionsFromEnv({ TROVE_JITTER_MS: "0" }).jitterMs).toBe(0);
    // ...while a negative/garbage value still falls back to the default.
    expect(throttleOptionsFromEnv({ TROVE_JITTER_MS: "-5" }).jitterMs).toBe(DEFAULT_THROTTLE.jitterMs);
    expect(throttleOptionsFromEnv({ TROVE_JITTER_MS: "nope" }).jitterMs).toBe(DEFAULT_THROTTLE.jitterMs);
  });
});
