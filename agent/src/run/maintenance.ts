/**
 * Maintenance trickle (A5) — the steady-state run mode (handoff "Run shape" #2).
 *
 * After the burst has onboarded the seed, the fleet shifts to a low, steady
 * trickle that keeps coverage alive as the web erodes it:
 *
 *   1. RELEASE EXPIRED LEASES — sweep any `attempting` rows whose lease lapsed
 *      back to `queued` (dead-worker recovery; the pool also does this lazily).
 *   2. RE-QUEUE needs_attention — submits that never confirmed get another shot
 *      (the brand may have been slow, or our submit was a near-miss).
 *   3. RE-QUEUE needs_solver — a later pass re-attempts walled targets (the wall
 *      may have lifted, or a solver/manual-assist may have been added). Still
 *      best-effort; we never try to defeat a live CAPTCHA here.
 *   4. RE-QUEUE no_form_found — the site may have added a newsletter form since.
 *   5. RECONCILE CONFIRMATIONS — run the A2 confirm loop to close drops, then
 *      mirror any freshly-confirmed addresses onto their store rows.
 *   6. DRAIN — run a bounded, throttled pass over whatever is now queued
 *      (new seed rows + the re-queued parked rows), exactly like the burst but
 *      with a small budget.
 *
 * Idempotent + safe to run on a cron: re-queueing respects the state machine
 * (confirmed/dead are never touched → no double-subscribe), and the
 * `requeueOlderThanMs` guard means a row just parked isn't instantly retried.
 */

import type { TargetStore } from "../store.ts";
import type { ThrottleOptions } from "../fleet/throttle.ts";
import type { ProxyPool } from "../fleet/proxy-pool.ts";
import type { AttemptStep } from "../fleet/pool.ts";
import { runBurst, type BurstResult } from "./burst.ts";
import type { Clock } from "../fleet/clock.ts";
import { systemClock } from "../fleet/clock.ts";

export interface MaintenanceOptions {
  store: TargetStore;
  step: AttemptStep;
  throttle: ThrottleOptions;
  proxies?: ProxyPool;
  /** Only re-queue parked rows older than this (ms). Default 1h. */
  requeueOlderThanMs?: number;
  /** Re-queue at most this many of EACH parked status per pass. Default 500. */
  requeueLimitPerStatus?: number;
  /**
   * Reconcile freshly-confirmed addresses. Given the set of domains the archive
   * now reports confirmed, flips their store rows to `confirmed`. Optional —
   * when omitted, maintenance only re-queues + drains (the A2 confirm loop runs
   * separately via `agent confirm`). Injected so it's stubbable + offline.
   */
  reconcileConfirmed?: () => Promise<string[]>;
  /** Budget for the drain pass. Default 500. */
  drainLimit?: number;
  concurrency?: number;
  workerId?: string;
  leaseTtlMs?: number;
  clock?: Clock;
  onAttempt?: (domain: string, status: string) => void;
}

export interface MaintenanceResult {
  releasedLeases: number;
  requeued: { needs_attention: number; needs_solver: number; no_form_found: number };
  reconciledConfirmed: number;
  drain: BurstResult;
}

/**
 * Run ONE maintenance trickle pass. Returns what it re-queued, reconciled, and
 * drained — so a cron/loop can log progress and a test can assert each step.
 */
export async function runMaintenance(opts: MaintenanceOptions): Promise<MaintenanceResult> {
  const { store, step } = opts;
  const clock = opts.clock ?? systemClock;
  const olderThan = opts.requeueOlderThanMs ?? 60 * 60_000;
  const limit = opts.requeueLimitPerStatus ?? 500;

  // The store's durable timestamps (updated_at, lease_expires_at) are stamped
  // with REAL wall time (an A0 design choice); the injected fleet clock governs
  // only pacing/sleeping. So the lease-sweep + re-queue age math run against
  // real time, NOT the (possibly virtual) fleet clock.
  const storeNow = Date.now();

  // 1. Dead-worker recovery: lapsed leases back to queued.
  const releasedLeases = store.releaseExpiredLeases(storeNow);

  // 2–4. Re-queue parked rows (respecting the state machine + age guard).
  const requeued = {
    needs_attention: store.requeueParked("needs_attention", { olderThanMs: olderThan, limit, now: storeNow }),
    needs_solver: store.requeueParked("needs_solver", { olderThanMs: olderThan, limit, now: storeNow }),
    no_form_found: store.requeueParked("no_form_found", { olderThanMs: olderThan, limit, now: storeNow }),
  };

  // 5. Reconcile freshly-confirmed addresses onto their store rows (close drops).
  let reconciledConfirmed = 0;
  if (opts.reconcileConfirmed) {
    const confirmedDomains = await opts.reconcileConfirmed();
    for (const domain of confirmedDomains) {
      if (store.markConfirmed(domain)) reconciledConfirmed++;
    }
  }

  // 6. Drain the now-queued backlog (new seed + re-queued) under the throttle.
  const drain = await runBurst({
    store,
    step,
    throttle: opts.throttle,
    ...(opts.proxies !== undefined ? { proxies: opts.proxies } : {}),
    limit: opts.drainLimit ?? 500,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
    ...(opts.leaseTtlMs !== undefined ? { leaseTtlMs: opts.leaseTtlMs } : {}),
    clock,
    ...(opts.onAttempt ? { onAttempt: opts.onAttempt } : {}),
  });

  return { releasedLeases, requeued, reconciledConfirmed, drain };
}
