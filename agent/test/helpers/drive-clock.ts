/**
 * Drive a ManualClock until an async operation settles.
 *
 * The fleet pool runs concurrent slots that each `await throttle.gate()` (which
 * may sleep on the clock) and `await step()` (which may sleep on the clock).
 * Virtual time only moves when we move it. This helper repeatedly: drains
 * microtasks (so any synchronous progress + newly-scheduled sleeps appear), then
 * jumps the clock to the next pending wakeup, until the driven promise settles.
 *
 * It uses a REAL macrotask (`setTimeout(0)`) between rounds so vitest's test
 * timeout can still fire if the fleet genuinely deadlocks — the loop never spins
 * the event loop without yielding.
 */

import type { ManualClock } from "../../src/fleet/clock.ts";

const realSetTimeout = globalThis.setTimeout;
const macrotask = (): Promise<void> => new Promise((res) => realSetTimeout(res, 0));

/** Drain the microtask queue a few times so chained `.then`s all run. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

export async function driveToCompletion<T>(
  clock: ManualClock,
  promise: Promise<T>,
  maxRounds = 200_000,
): Promise<T> {
  let settled = false;
  let result: T;
  let error: unknown;
  let hasError = false;

  promise.then(
    (v) => {
      settled = true;
      result = v;
    },
    (e) => {
      settled = true;
      hasError = true;
      error = e;
    },
  );

  let rounds = 0;
  while (!settled) {
    if (++rounds > maxRounds) {
      throw new Error(`driveToCompletion exceeded ${maxRounds} rounds (deadlock?)`);
    }
    // 1. Let all currently-runnable continuations run.
    await drainMicrotasks();
    if (settled) break;

    // 2. Advance to the next pending sleeper, if any.
    const next = clock.nextWakeup();
    if (next !== null) {
      await clock.advance(Math.max(0, next - clock.now()));
    }

    // 3. Yield a real macrotask so (a) vitest can time us out on a true deadlock
    //    and (b) any pending I/O-ish continuations flush.
    await macrotask();
  }

  if (hasError) throw error;
  return result!;
}
