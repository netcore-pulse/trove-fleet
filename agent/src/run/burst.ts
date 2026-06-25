/**
 * Burst orchestrator (A5) — onboard the seed through the bounded pool under the
 * throttle + block thresholds, paced for "weeks not hours" (handoff "Run shape").
 *
 * The burst is NOT a fast drain. The {@link Throttle} (global rate cap +
 * per-domain spacing + jitter) is what keeps it under block thresholds; the
 * burst simply keeps feeding leased targets through the bounded pool until the
 * queue is exhausted or the per-invocation budget is spent.
 *
 * RESUMABLE / IDEMPOTENT (the cardinal property): all durable state lives in the
 * store (A0). A killed burst loses nothing —
 *   - a confirmed domain is terminal and is NEVER re-leased (no double-subscribe);
 *   - an in-flight (`attempting`) row's lease lapses on worker death and is
 *     reclaimed by the next pass — never stranded;
 *   - re-running the burst just leases whatever is still `queued`/lapsed.
 * So `burst` → kill → `burst` again picks up exactly where it left off, and a
 * row is attempted at most once per successful pass.
 *
 * The burst itself is intentionally thin: it constructs the pool wiring (store,
 * step, throttle, proxies) and runs it. The pacing lives in the throttle; the
 * concurrency + per-domain politeness live in the pool. This file is the
 * operator-facing "run the heavy phase" entry point.
 */

import type { TargetStore } from "../store.ts";
import { Throttle, type ThrottleOptions } from "../fleet/throttle.ts";
import { type ProxyPool, NullProxyPool } from "../fleet/proxy-pool.ts";
import { runFleet, type AttemptStep, type FleetRunResult } from "../fleet/pool.ts";
import { systemClock, type Clock } from "../fleet/clock.ts";

export interface BurstOptions {
  store: TargetStore;
  /** The per-target attempt (A1 subscribe step in prod, a fake in tests). */
  step: AttemptStep;
  /** Proxy pool (sizes the default concurrency). Defaults to direct (Null pool). */
  proxies?: ProxyPool;
  /** Throttle config (pacing). Defaults applied by the throttle if omitted. */
  throttle: ThrottleOptions;
  /** Cap the number of targets this invocation processes. Omit = drain queue. */
  limit?: number;
  /** Override concurrency (defaults to the proxy pool size). */
  concurrency?: number;
  workerId?: string;
  leaseTtlMs?: number;
  clock?: Clock;
  /** Per-attempt observer (metrics / progress logging). */
  onAttempt?: (domain: string, status: string) => void;
}

export interface BurstResult extends FleetRunResult {
  /** Targets still queued/leasable after this pass (resume backlog). */
  remainingQueued: number;
}

/**
 * Run ONE burst pass: drain up to `limit` queued targets through the bounded,
 * throttled pool. Returns the per-status breakdown plus how many remain queued
 * (so an operator/loop can decide whether to run again).
 */
export async function runBurst(opts: BurstOptions): Promise<BurstResult> {
  const { store, step } = opts;
  const clock = opts.clock ?? systemClock;
  const proxies = opts.proxies ?? new NullProxyPool({ clock });
  const throttle = new Throttle({ ...opts.throttle, clock });

  const result = await runFleet({
    store,
    step,
    throttle,
    proxies,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}),
    ...(opts.leaseTtlMs !== undefined ? { leaseTtlMs: opts.leaseTtlMs } : {}),
    clock,
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.onAttempt
      ? { onAttempt: (domain, r) => opts.onAttempt!(domain, r.status) }
      : {}),
  });

  const funnel = store.statsByStatus();
  // "Remaining" = rows still eligible to be leased (queued). attempting rows are
  // either live or will lapse back to queued; we count queued as the resume backlog.
  const remainingQueued = funnel.queued;

  return { ...result, remainingQueued };
}
