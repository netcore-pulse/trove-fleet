/**
 * Fake attempt step for the fleet/burst/maintenance gate tests.
 *
 * Stands in for A1's real `subscribeOnPage` (which drives chromium). It is
 * synchronous-ish (resolves on a microtask), records every call, and resolves
 * each domain to a configurable status — so the gate proves the ORCHESTRATION
 * (bounded concurrency, throttle pacing, per-domain politeness, proxy rotation,
 * isolation, resume) without a browser or network.
 *
 * Concurrency observability: it tracks how many calls are in-flight at once
 * (peak), and which domains were seen concurrently, so a test can assert the
 * bounded-concurrency + one-in-flight-per-domain invariants directly.
 */

import type { AttemptStep, AttemptResult, AttemptContext } from "../../src/fleet/pool.ts";

export type StatusFor = (domain: string, callIndex: number) => AttemptResult["status"];

export interface FakeStepOptions {
  /** Decide the resolved status per call. Default: always "submitted". */
  statusFor?: StatusFor;
  /** Domains for which the step throws (isolation test). */
  throwFor?: Set<string>;
  /** A clock-driven delay each call "takes" (to exercise concurrency). 0 = none. */
  holdMs?: number;
  /** Sleep impl used for holdMs (inject ManualClock.sleep for determinism). */
  sleep?: (ms: number) => Promise<void>;
  /** Detected ESP to report (per domain). */
  espFor?: (domain: string) => string | undefined;
}

export interface FakeStep {
  step: AttemptStep;
  /** Every domain attempted, in completion order. */
  calls: string[];
  /** Per-domain attempt count (proves no double-subscribe). */
  countByDomain: Map<string, number>;
  /** Peak simultaneous in-flight attempts (bounded-concurrency assertion). */
  peakInFlight: number;
  /** Proxy ids seen (rotation assertion). */
  proxyIds: string[];
  /** Domains that were ever in-flight at the same instant as another (should be none same-domain). */
  concurrentDomains: Set<string>;
}

export function makeFakeStep(opts: FakeStepOptions = {}): FakeStep {
  const statusFor = opts.statusFor ?? (() => "submitted" as const);
  const throwFor = opts.throwFor ?? new Set<string>();
  const holdMs = opts.holdMs ?? 0;
  const sleep = opts.sleep;

  const state: FakeStep = {
    step: async () => ({ status: "submitted", reason: "" }), // replaced below
    calls: [],
    countByDomain: new Map(),
    peakInFlight: 0,
    proxyIds: [],
    concurrentDomains: new Set(),
  };

  let inFlight = 0;
  const inFlightDomains = new Set<string>();
  let callIndex = 0;

  state.step = async (ctx: AttemptContext): Promise<AttemptResult> => {
    const domain = ctx.domain;
    const myIndex = callIndex++;

    inFlight++;
    if (inFlight > state.peakInFlight) state.peakInFlight = inFlight;
    // If this domain is already in-flight, that violates per-domain politeness.
    if (inFlightDomains.has(domain)) state.concurrentDomains.add(domain);
    inFlightDomains.add(domain);
    state.proxyIds.push(ctx.proxy.id);
    state.countByDomain.set(domain, (state.countByDomain.get(domain) ?? 0) + 1);

    try {
      if (holdMs > 0 && sleep) await sleep(holdMs);

      if (throwFor.has(domain)) {
        throw new Error(`fake step boom for ${domain}`);
      }

      const status = statusFor(domain, myIndex);
      const esp = opts.espFor?.(domain);
      state.calls.push(domain);
      const result: AttemptResult = {
        status,
        reason: `fake:${status}`,
        ...(esp !== undefined ? { esp } : {}),
        ...(status === "submitted" ? { address: `${domain}@in.trove.dev`, addressId: myIndex + 1 } : {}),
      };
      return result;
    } finally {
      inFlight--;
      inFlightDomains.delete(domain);
    }
  };

  return state;
}
