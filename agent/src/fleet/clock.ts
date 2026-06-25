/**
 * Injectable clock + sleep — the single seam that makes the whole fleet runtime
 * (throttle pacing, bounded-pool scheduling, burst loop) deterministic in tests.
 *
 * Production uses {@link systemClock} (real `Date.now` + real `setTimeout`).
 * Tests use {@link ManualClock}: time only advances when the test advances it,
 * and `sleep(ms)` resolves exactly when virtual time reaches the wakeup — so a
 * test can assert "no two attempts to the same domain landed within minDelayMs"
 * and "the global rate cap was never exceeded" without ever waiting in wall time.
 *
 * Why this shape: A0/A1 already proved that isolating a flaky/slow surface behind
 * a plain injectable seam (the archive `fetch`, the DOM snapshot) is what keeps
 * the gate fast + deterministic. Time is exactly such a surface for A3–A5.
 */

/** The minimal time surface the fleet depends on. */
export interface Clock {
  /** Current epoch time in ms. */
  now(): number;
  /** Resolve after `ms` of (clock-relative) time. `ms <= 0` resolves promptly. */
  sleep(ms: number): Promise<void>;
}

/** Real wall-clock + real timers. The production clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number) =>
    ms <= 0 ? Promise.resolve() : new Promise((res) => setTimeout(res, ms)),
};

interface Pending {
  at: number;
  resolve: () => void;
}

/**
 * A virtual clock for tests. Time starts at `start` (default 0) and only moves
 * when {@link advance} / {@link runAll} is called. Sleepers are released in
 * time order as virtual time crosses their wakeup.
 *
 * It is intentionally tiny — no global monkeypatching, no fake-timers library.
 * The fleet only ever touches `now()` + `sleep()`, so this is all that's needed.
 */
export class ManualClock implements Clock {
  private current: number;
  private pending: Pending[] = [];
  /** Every distinct timestamp at which a sleep was *issued* (for pacing asserts). */
  readonly issuedAt: number[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    this.issuedAt.push(this.current);
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.pending.push({ at: this.current + ms, resolve });
    });
  }

  /** Number of sleepers still waiting. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** The earliest wakeup time among pending sleepers, or null if none. */
  nextWakeup(): number | null {
    if (this.pending.length === 0) return null;
    return this.pending.reduce((min, p) => (p.at < min ? p.at : min), this.pending[0]!.at);
  }

  /**
   * Advance virtual time by `ms`, releasing every sleeper whose wakeup is now in
   * the past. Returns a promise that resolves after the released continuations
   * have had a microtask tick to run (so awaiting it lets the woken code proceed).
   */
  async advance(ms: number): Promise<void> {
    this.current += ms;
    this.flushDue();
    // Yield so resolved sleepers' continuations run before the caller proceeds.
    await Promise.resolve();
  }

  /**
   * Repeatedly jump to the next pending wakeup and release it, until no sleepers
   * remain or `maxSteps` is hit (a guard against an unbounded scheduler bug).
   * Yields a microtask between steps so newly-scheduled sleeps are picked up.
   */
  async runAll(maxSteps = 1_000_000): Promise<void> {
    let steps = 0;
    while (this.pending.length > 0) {
      if (++steps > maxSteps) {
        throw new Error(`ManualClock.runAll exceeded ${maxSteps} steps (scheduler loop?)`);
      }
      const next = this.nextWakeup();
      if (next === null) break;
      if (next > this.current) this.current = next;
      this.flushDue();
      // Let woken continuations schedule their next sleep before we loop.
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  private flushDue(): void {
    const due: Pending[] = [];
    const still: Pending[] = [];
    for (const p of this.pending) {
      if (p.at <= this.current) due.push(p);
      else still.push(p);
    }
    this.pending = still;
    // Resolve in wakeup order for stable, intuitive release semantics.
    due.sort((a, b) => a.at - b.at);
    for (const p of due) p.resolve();
  }
}
