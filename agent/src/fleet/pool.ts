/**
 * Bounded-concurrency worker pool (A3) — the fleet runtime that drives many
 * subscribe attempts concurrently WITHOUT getting mass-blocked.
 *
 * Shape (handoff "Footprint management"):
 *   - BOUNDED concurrency: `concurrency` in-flight attempts, sized to the proxy
 *     pool (one egress per worker), never unbounded.
 *   - PER-DOMAIN POLITENESS: exactly one in-flight attempt per registrable
 *     domain — guaranteed by A0's lease (one worker per domain) PLUS the store's
 *     leaseNext only ever handing out a `queued`/lapsed row. We never lease the
 *     same domain twice concurrently.
 *   - THROTTLE: every attempt passes through the {@link Throttle} gate before it
 *     starts (global rate cap + per-domain spacing + jitter).
 *   - PROXY ROTATION: each attempt acquires a proxy lease and reports the result
 *     back (dead-proxy detection rotates away from burned IPs).
 *   - ISOLATION: one target's failure never stalls the fleet. Each attempt is
 *     wrapped; a thrown step falls the lease back to `queued` (legal A0
 *     transition) so the row is retried later, never stranded in `attempting`.
 *
 * The actual per-target work is injected as an {@link AttemptStep}. In production
 * that wraps A1's `subscribeOnPage` (via a browser worker bound to the leased
 * proxy + the persona fingerprint). In tests it's a fast fake — so the gate
 * proves the ORCHESTRATION (bounded concurrency, throttle pacing, per-domain
 * politeness, proxy rotation, isolation, resume) at 50-target scale, offline.
 *
 * The dispatcher leases serially (so the throttle's sliding-window bookkeeping
 * stays correct on the single event-loop thread), then runs the leased attempt
 * on a free worker slot. The store's atomic leaseNext is the work queue.
 */

import type { TargetStore, TargetRow } from "../store.ts";
import type { Status } from "../state.ts";
import { personaForDomain, type Persona } from "../persona.ts";
import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";
import type { Throttle } from "./throttle.ts";
import type { ProxyPool, ProxyLease } from "./proxy-pool.ts";

/**
 * The outcome a step resolves a leased target to. Must be a legal A0 transition
 * from `attempting`:
 *   - submitted        → form filled + submitted; confirmation expected (A2 closes it)
 *   - needs_solver     → CAPTCHA/anti-bot wall detected → PARKED, never looped
 *   - no_form_found    → no newsletter field found
 *   - needs_attention  → submit didn't take after a retry
 *   - queued           → transient error; fall back for a later retry
 */
export type AttemptStatus = Extract<
  Status,
  "submitted" | "needs_solver" | "no_form_found" | "needs_attention" | "queued"
>;

export interface AttemptResult {
  status: AttemptStatus;
  reason: string;
  /** Did the egress (proxy) carry the attempt usefully? Drives proxy health. */
  proxyOk?: boolean;
  /** Minted address, when the step got far enough (persisted to the store). */
  address?: string | undefined;
  addressId?: number | undefined;
  /** ESP detected on the chosen form (A4 per-ESP success rates). */
  esp?: string | undefined;
}

export interface AttemptContext {
  domain: string;
  row: TargetRow;
  persona: Persona;
  /** The leased proxy for this attempt (server may be null = direct). */
  proxy: ProxyLease;
  workerId: string;
}

/** The injected unit of work — one subscribe attempt for one leased target. */
export type AttemptStep = (ctx: AttemptContext) => Promise<AttemptResult>;

export interface FleetPoolOptions {
  store: TargetStore;
  /** The per-target attempt (wraps A1's subscribe loop in prod). */
  step: AttemptStep;
  throttle: Throttle;
  proxies: ProxyPool;
  /**
   * Max in-flight attempts. Defaults to the proxy pool size (one egress per
   * worker) — never larger, so we don't over-subscribe a single IP.
   */
  concurrency?: number;
  /** Base worker id; each slot gets a `-<n>` suffix for distinct leases. */
  workerId?: string;
  /** Lease TTL handed to the store (ms). */
  leaseTtlMs?: number;
  clock?: Clock;
  /** Per-attempt observer hook (metrics/logging). */
  onAttempt?: (domain: string, result: AttemptResult) => void;
}

export interface FleetRunResult {
  /** Targets that were leased + attempted this run. */
  attempted: number;
  /** Breakdown of resolved statuses. */
  byStatus: Record<AttemptStatus, number>;
  /** Attempts whose step threw (isolated; lease fell back to queued). */
  errored: number;
}

const EMPTY_BY_STATUS = (): Record<AttemptStatus, number> => ({
  submitted: 0,
  needs_solver: 0,
  no_form_found: 0,
  needs_attention: 0,
  queued: 0,
});

/**
 * Drain the store's queue through a bounded pool until no more targets are
 * leasable or `limit` attempts have been made.
 *
 * `limit` caps how many targets this invocation processes (the burst runner
 * passes a per-invocation budget). Omit for "drain everything currently queued".
 */
export async function runFleet(
  opts: FleetPoolOptions & { limit?: number },
): Promise<FleetRunResult> {
  const { store, step, throttle, proxies } = opts;
  const clock = opts.clock ?? systemClock;
  const concurrency = Math.max(1, opts.concurrency ?? proxies.size());
  const baseWorkerId = opts.workerId ?? "fleet";
  const leaseTtlMs = opts.leaseTtlMs;
  const limit = opts.limit ?? Infinity;

  const byStatus = EMPTY_BY_STATUS();
  let attempted = 0;
  let errored = 0;
  let leasedTotal = 0;
  // Domains leased in THIS pass, so a lease that lapses mid-pass and gets
  // re-handed isn't re-attempted (the bounded-pool politeness guard).
  const attemptedThisPass = new Set<string>();
  // Domains whose attempt resolved to `queued` — a thrown step OR a transient
  // returned-`queued`. We do NOT flip them to `queued` mid-pass: that makes them
  // immediately re-leasable and churns the pool, and with bounded slots a slot
  // could re-encounter a re-queued row and terminate while fresh rows remain →
  // stranded work + nondeterministic counts (the isolation-gate flake). Instead
  // we keep their lease held `attempting` for the pass (so leaseNext can't
  // re-hand them) and flush them ALL to `queued` once, after every slot drains.
  // Retry happens on the NEXT burst/maintenance pass (handoff: "fall back for a
  // later retry"). domain → lastError.
  const deferredRequeue = new Map<string, string | null>();

  /**
   * One worker slot: repeatedly lease → gate → attempt → persist, until the
   * queue is empty or the budget is spent. Leasing is atomic (A0), so N slots
   * never lease the same domain — that's the per-domain politeness guarantee.
   */
  const slot = async (slotIndex: number): Promise<void> => {
    const workerId = `${baseWorkerId}-${slotIndex}`;
    for (;;) {
      // Budget check before leasing (don't lease what we won't run).
      if (leasedTotal >= limit) return;
      const leased = store.leaseNext(workerId, leaseTtlMs);
      if (!leased) return; // queue drained for this slot

      const domain = leased.domain;

      // A lease lapsed mid-pass and was re-handed for a domain we already
      // attempted? Leave it leased to us (not leasable) and move on — it's
      // already slated for re-queue at the flush. No release → no spin, and the
      // slot keeps draining fresh work instead of terminating.
      if (attemptedThisPass.has(domain)) continue;
      attemptedThisPass.add(domain);
      leasedTotal++;

      const persona = personaForDomain(domain);

      // Pace: global rate cap + per-domain spacing + jitter, BEFORE the attempt.
      await throttle.gate(domain);

      // Rotate egress for this attempt.
      const proxy = proxies.acquire();

      let result: AttemptResult;
      try {
        result = await step({ domain, row: leased, persona, proxy, workerId });
      } catch (err) {
        // Isolation: a thrown step never stalls the fleet. Defer the row's
        // fall-back to `queued` to the post-pass flush (kept `attempting` for now
        // so it isn't re-leased this pass); report the proxy as failed (the
        // egress may be the culprit).
        errored++;
        proxy.report(false);
        const message = err instanceof Error ? err.message : String(err);
        deferredRequeue.set(domain, `fleet step error: ${message}`);
        byStatus.queued++;
        attempted++;
        opts.onAttempt?.(domain, { status: "queued", reason: `error: ${message}` });
        continue;
      }

      // Report proxy health: an explicit proxyOk wins; otherwise a non-queued
      // resolution means the egress carried the attempt (even a block/no-form is
      // a successful *connection*). A queued fallback is treated as a proxy miss.
      const proxyOk = result.proxyOk ?? result.status !== "queued";
      proxy.report(proxyOk);

      if (result.status === "queued") {
        // Transient — defer to the flush, same as a throw (don't re-lease this pass).
        deferredRequeue.set(domain, result.reason ?? null);
      } else {
        // Terminal-for-this-pass status — persist now (drives the A0 state
        // machine + funnel; not `queued`, so it won't be re-leased).
        try {
          store.setStatus(domain, result.status, {
            lastError: result.status === "submitted" ? null : result.reason,
            address: result.address ?? null,
            addressId: result.addressId ?? null,
            esp: result.esp ?? null,
          });
        } catch {
          // A racing transition (e.g. lease lapsed + reclaimed) — skip; the row's
          // state is owned by whoever holds the live lease.
        }
      }

      byStatus[result.status]++;
      attempted++;
      opts.onAttempt?.(domain, result);
    }
  };

  // Launch exactly `concurrency` slots; they self-terminate when the queue drains.
  const slots: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) slots.push(slot(i));
  await Promise.all(slots);

  // Flush deferred re-queues once, now that every slot has drained. These rows
  // were held `attempting` through the pass (so they couldn't be re-leased);
  // they become clean `queued` rows for the next pass.
  for (const [domain, lastError] of deferredRequeue) {
    try {
      store.setStatus(domain, "queued", { lastError });
    } catch {
      // If even that fails, the lease TTL auto-releases the row (A0).
    }
  }

  return { attempted, byStatus, errored };
}
