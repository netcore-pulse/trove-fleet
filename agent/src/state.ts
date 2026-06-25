/**
 * Target state machine.
 *
 * The seed-list-driven lifecycle of a single brand domain, per the handoff
 * "State machine" section. The store is the source of truth — never worker
 * memory. Illegal transitions throw; callers must catch or pre-check.
 *
 *   queued ──► attempting ──► submitted ──► confirmed ✓
 *      ▲           │              │
 *      │           │              └─► (no confirm in window) ─► needs_attention
 *      │           ├─► no_form_found ─► dead
 *      │           ├─► (CAPTCHA/Turnstile/honeypot) ─► needs_solver
 *      │           ├─► (form found, submit never confirmed) ─► needs_attention
 *      │           └─► (transient error) ─► queued  (backoff + requeue)
 *      └──────────────────────────────────── lease expiry auto-releases
 */

export const STATUSES = [
  "queued",
  "attempting",
  "submitted",
  "confirmed",
  "needs_solver",
  "no_form_found",
  "needs_attention",
  "dead",
] as const;

export type Status = (typeof STATUSES)[number];

export function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/**
 * Legal transitions. A status maps to the set of statuses it may move to.
 * Self-transitions are NOT legal (use a no-op or a dedicated touch instead).
 *
 * Notes on the design:
 *  - `attempting` is the only state a worker holds via a lease; it can resolve
 *    forward (submitted) or sideways into a terminal/parked bucket, or fall
 *    back to `queued` on a transient error or lease expiry.
 *  - `needs_solver`, `needs_attention` are parking lots; a maintenance pass may
 *    re-queue them, so a path back to `queued` exists.
 *  - `confirmed` and `dead` are terminal. A `confirmed` domain is NEVER
 *    re-queued (cardinal rule: never double-subscribe). `dead` is permanent
 *    after exhausting retries.
 */
const TRANSITIONS: Record<Status, ReadonlySet<Status>> = {
  queued: new Set<Status>(["attempting"]),
  attempting: new Set<Status>([
    "submitted",
    "no_form_found",
    "needs_solver",
    "needs_attention", // form found + filled, but submit never cleanly confirmed (validation/unknown after retry)
    "queued", // transient error / lease released
  ]),
  submitted: new Set<Status>([
    "confirmed",
    "needs_attention", // no confirmation arrived in window
    "queued", // re-attempt after a transient confirm-loop blip
  ]),
  needs_attention: new Set<Status>([
    "queued", // maintenance re-attempt
    "confirmed", // a late confirmation finally landed
    "dead",
  ]),
  needs_solver: new Set<Status>([
    "queued", // a later solver/manual-assist pass re-queues
    "dead",
  ]),
  no_form_found: new Set<Status>([
    "dead",
    "queued", // re-attempt (site may have added a form)
  ]),
  confirmed: new Set<Status>([]), // terminal
  dead: new Set<Status>([]), // terminal
};

export class IllegalTransitionError extends Error {
  readonly from: Status;
  readonly to: Status;
  constructor(from: Status, to: Status) {
    super(`Illegal target transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function canTransition(from: Status, to: Status): boolean {
  if (!isStatus(from) || !isStatus(to)) return false;
  return TRANSITIONS[from].has(to);
}

/** Throws {@link IllegalTransitionError} if the transition is not allowed. */
export function assertTransition(from: Status, to: Status): void {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
}

/** Terminal states never move again. */
export function isTerminal(status: Status): boolean {
  return TRANSITIONS[status].size === 0;
}

/** A confirmed domain must never be re-queued (cardinal: no double-subscribe). */
export function isConfirmedOrInFlight(status: Status): boolean {
  return status === "confirmed" || status === "attempting" || status === "submitted";
}
