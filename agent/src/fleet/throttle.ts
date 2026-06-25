/**
 * Throttle + jitter (A3) — human-plausible pacing so 200K subscriptions don't
 * arrive in one machine-gun burst (handoff "Footprint management" + "Never run
 * the burst fast"). Two independent governors, both honored before every attempt:
 *
 *   1. GLOBAL RATE CAP — at most `globalMaxPerWindow` attempt-starts per
 *      `windowMs` sliding window, across the whole fleet. This is the hard
 *      anti-block ceiling: "weeks, not hours".
 *
 *   2. PER-DOMAIN SPACING — at least `perDomainMinDelayMs` between two attempts
 *      to the SAME registrable domain (politeness / never hammer a domain).
 *
 * Plus JITTER: each governor's wait is padded by a deterministic-in-test random
 * amount so the cadence isn't a robotic metronome.
 *
 * Determinism: the clock AND the jitter RNG are injected. With a `ManualClock`
 * and a seeded RNG, a test asserts exact gate timestamps — proving the rate cap
 * is never exceeded and same-domain attempts are always spaced — with zero real
 * waiting. In production it's the system clock + Math.random.
 *
 * Concurrency note: `gate()` is `await`ed serially by the pool's dispatcher
 * (one target admitted at a time), so the sliding-window bookkeeping needs no
 * locking — the single-threaded event loop plus serial admission is the lock.
 */

import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

export interface ThrottleOptions {
  /** Max attempt-starts per sliding window (the global rate cap). */
  globalMaxPerWindow: number;
  /** Sliding-window length in ms for the global cap. */
  windowMs: number;
  /** Minimum gap between two attempts to the SAME registrable domain (ms). */
  perDomainMinDelayMs: number;
  /** Max extra jitter added to any computed wait (ms). 0 disables jitter. */
  jitterMs?: number;
  clock?: Clock;
  /** Injected RNG in [0,1) — default Math.random; seed it in tests. */
  random?: () => number;
}

/**
 * The fleet's pacing governor. Call {@link gate} immediately before starting an
 * attempt for `domain`; it resolves only once BOTH the global cap and the
 * per-domain spacing permit the attempt, then records the admission.
 */
export class Throttle {
  private readonly globalMax: number;
  private readonly windowMs: number;
  private readonly perDomainMinDelayMs: number;
  private readonly jitterMs: number;
  private readonly clock: Clock;
  private readonly random: () => number;

  /** Admission timestamps within the current window (global cap bookkeeping). */
  private readonly recentAdmissions: number[] = [];
  /** Last admission time per registrable domain (per-domain spacing). */
  private readonly lastByDomain = new Map<string, number>();

  constructor(opts: ThrottleOptions) {
    if (opts.globalMaxPerWindow < 1) throw new Error("globalMaxPerWindow must be >= 1");
    if (opts.windowMs < 1) throw new Error("windowMs must be >= 1");
    this.globalMax = opts.globalMaxPerWindow;
    this.windowMs = opts.windowMs;
    this.perDomainMinDelayMs = Math.max(0, opts.perDomainMinDelayMs);
    this.jitterMs = Math.max(0, opts.jitterMs ?? 0);
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
  }

  /** Drop admissions that have aged out of the sliding window. */
  private evictOld(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.recentAdmissions.length > 0 && this.recentAdmissions[0]! <= cutoff) {
      this.recentAdmissions.shift();
    }
  }

  /** Deterministic-in-test jitter in [0, jitterMs]. */
  private jitter(): number {
    if (this.jitterMs === 0) return 0;
    return Math.floor(this.random() * (this.jitterMs + 1));
  }

  /**
   * How long (ms) we must wait from `now` before an attempt for `domain` may
   * start, considering BOTH governors. Pure given the current state — exposed
   * for assertions; {@link gate} uses it internally.
   */
  waitFor(domain: string, now: number = this.clock.now()): number {
    this.evictOld(now);

    // Per-domain spacing.
    let domainWait = 0;
    const last = this.lastByDomain.get(domain);
    if (last !== undefined) {
      const earliest = last + this.perDomainMinDelayMs;
      if (earliest > now) domainWait = earliest - now;
    }

    // Global cap: if the window is full, we must wait until the oldest admission
    // ages out (frees a slot).
    let globalWait = 0;
    if (this.recentAdmissions.length >= this.globalMax) {
      const oldest = this.recentAdmissions[0]!;
      const freesAt = oldest + this.windowMs;
      if (freesAt > now) globalWait = freesAt - now;
    }

    return Math.max(domainWait, globalWait);
  }

  /**
   * Block until both governors permit an attempt for `domain`, then record the
   * admission. Adds jitter on top of any computed wait. Re-checks after sleeping
   * (state may have changed while we slept) so the cap is honored exactly.
   */
  async gate(domain: string): Promise<void> {
    // Loop: compute the required wait, sleep it (+jitter), re-check. Converges
    // because each iteration either admits (wait 0) or sleeps a positive amount
    // that strictly advances time toward a free slot.
    // A guard bounds pathological loops (shouldn't happen with sane config).
    for (let i = 0; i < 10_000; i++) {
      const now = this.clock.now();
      const wait = this.waitFor(domain, now);
      if (wait <= 0) {
        // Reserve the slot SYNCHRONOUSLY, before any await (forward-pass H3): the
        // jitter sleep used to yield between the wait<=0 check and admit(), so two
        // concurrent callers could both pass the cap in the same window. Admit
        // first (now()→waitFor→admit is now an atomic, await-free sequence on the
        // single event-loop thread), then apply jitter as a post-admission stagger.
        this.admit(domain);
        const j = this.jitter();
        if (j > 0) await this.clock.sleep(j);
        return;
      }
      await this.clock.sleep(wait + this.jitter());
    }
    // Extremely defensive: admit rather than spin forever.
    this.admit(domain);
  }

  private admit(domain: string): void {
    const now = this.clock.now();
    this.evictOld(now);
    this.recentAdmissions.push(now);
    this.lastByDomain.set(domain, now);
  }

  /** Current count of admissions inside the live window (for metrics/tests). */
  windowFill(now: number = this.clock.now()): number {
    this.evictOld(now);
    return this.recentAdmissions.length;
  }
}

/**
 * Sensible production defaults: paced for "weeks not hours". With a global cap of
 * 30 starts/minute (~43K/day theoretical, far less in practice with confirms +
 * blocks), a 200K seed onboards over weeks — exactly the handoff's intent. These
 * are config, overridable from the environment by the burst runner.
 */
export const DEFAULT_THROTTLE: ThrottleOptions = {
  globalMaxPerWindow: 30,
  windowMs: 60_000,
  perDomainMinDelayMs: 6 * 60 * 60_000, // 6h between two hits on the same domain
  jitterMs: 750,
};

/** Build throttle options from the environment, falling back to the defaults. */
export function throttleOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Omit<ThrottleOptions, "clock" | "random"> {
  const num = (v: string | undefined, dflt: number): number => {
    if (v === undefined || v.trim() === "") return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  // Like `num`, but accepts 0 — `TROVE_JITTER_MS=0` legitimately DISABLES jitter
  // (the deterministic-run setting); the `> 0` guard above would wrongly reject it.
  const numNonNeg = (v: string | undefined, dflt: number): number => {
    if (v === undefined || v.trim() === "") return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    globalMaxPerWindow: num(env.TROVE_RATE_MAX, DEFAULT_THROTTLE.globalMaxPerWindow),
    windowMs: num(env.TROVE_RATE_WINDOW_MS, DEFAULT_THROTTLE.windowMs),
    perDomainMinDelayMs: num(env.TROVE_DOMAIN_MIN_DELAY_MS, DEFAULT_THROTTLE.perDomainMinDelayMs),
    jitterMs: numNonNeg(env.TROVE_JITTER_MS, DEFAULT_THROTTLE.jitterMs!),
  };
}
