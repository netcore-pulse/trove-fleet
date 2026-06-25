# Trove Subscriber Agent

A **separate deployable** from the Trove Rails archive. It drives a headless
browser fleet to subscribe to ~200K brand newsletters and close the
double-opt-in loop autonomously. It shares only two HTTP seams with the
archive: the **address-mint API** and the **confirmations queue**.

> This directory is the agent service. It is **not** part of the Rails app — it
> has its own `package.json`, `tsconfig.json`, and tests. The agent never writes
> to the corpus; the archive never drives a browser.

## Status — A0–A5 (spine → fleet → run modes)

| Built | Module(s) |
|---|---|
| **A0** Durable target store (SQLite) | `src/store.ts` |
| **A0** Target state machine | `src/state.ts` |
| **A0** Registrable-domain canonicalizer + seed parser | `src/canonical.ts` |
| **A0** Synthetic persona pool (deterministic, **never real PII**) | `src/persona.ts` |
| **A0** Archive clients (mint + confirmations + helpers) | `src/archive-client.ts` |
| **A1** Single-target subscribe loop (Playwright) | `src/subscribe.ts`, `src/form-finder.ts`, `src/outcome.ts`, `src/browser/*` |
| **A2** Confirm loop + link whitelist | `src/confirm-loop.ts`, `src/confirm-link.ts` |
| **A3** Proxy pool (rotation + dead-proxy detection) | `src/fleet/proxy-pool.ts` |
| **A3** Throttle + jitter (global rate cap + per-domain spacing) | `src/fleet/throttle.ts` |
| **A3** Bounded-concurrency worker pool | `src/fleet/pool.ts`, `src/fleet/subscribe-step.ts` |
| **A3** Injectable clock (deterministic pacing in tests) | `src/fleet/clock.ts` |
| **A4** Coverage + funnel metrics | `src/observability/metrics.ts` |
| **A4** Alerts (confirm collapse / block spike / stall / proxy exhaustion) | `src/observability/alerts.ts` |
| **A5** Burst orchestrator (resumable, throttled) | `src/run/burst.ts` |
| **A5** Maintenance trickle | `src/run/maintenance.ts` |
| Operator CLI (`seed`, `stats`, `persona`, `subscribe`, `confirm`, `metrics`, `doctor`, `burst`, `maintain`) | `src/cli/index.ts` |

**Deferred (operational, not code):** the real proxy *provider* (the rotation
seam + dead-proxy detection are built; plug a vendor's URLs into
`TROVE_PROXY_URLS`, or wire GitHub-Actions egress), and the actual 200K
onboarding run (the burst/maintenance logic is built + tested at small scale).

## Toolchain

Node 22 via mise. Before any node/npm command:

```sh
export PATH="$HOME/.local/share/mise/shims:$PATH"
```

## Commands

```sh
npm install
npm run build      # tsc → dist/
npm test           # vitest
npm run typecheck  # tsc --noEmit

# CLI (dev, via tsx-less node type-stripping):
npm run agent -- seed path/to/seed.csv
npm run agent -- stats
npm run agent -- persona nike.com
npm run agent -- metrics              # A4 funnel + coverage dashboard
npm run agent -- doctor               # A4 proxy health + alert check (exit 1 on critical)
npm run agent -- burst --limit 100    # A5 heavy onboarding pass (throttled, resumable)
npm run agent -- maintain             # A5 trickle: re-queue parked + new seed, reconcile
```

## Run modes (A5)

- **Burst** — onboard the seed through the bounded, throttled pool. Paced for
  "weeks not hours" (the throttle is not optional). **Resumable:** all state is
  in the store, so a killed burst loses nothing — re-run picks up where it left
  off and never double-subscribes a `confirmed` domain.
- **Maintenance trickle** — steady-state: release lapsed leases, re-queue
  `needs_attention` / `needs_solver` / `no_form_found` (age-guarded) + new seed
  rows, reconcile freshly-confirmed addresses, then drain a small budget.

## Configuration (env)

| Var | Default | Meaning |
|---|---|---|
| `TROVE_ARCHIVE_URL` | `http://localhost:3033` | Archive internal API base |
| `TROVE_INTERNAL_API_TOKEN` | `dev-only-internal-token` | Bearer token |
| `TROVE_AGENT_DB` | `./data/targets.db` | SQLite store path |
| `TROVE_WORKER_ID` | `agent-1` | Worker id for leases/claims |
| `TROVE_PROXY_URLS` | _(unset → direct)_ | Comma-list of egress proxy URLs (A3 rotation) |
| `TROVE_RATE_MAX` | `30` | Global rate cap: max attempt-starts per window |
| `TROVE_RATE_WINDOW_MS` | `60000` | Sliding-window length for the rate cap |
| `TROVE_DOMAIN_MIN_DELAY_MS` | `21600000` (6h) | Min gap between two attempts to one domain |
| `TROVE_JITTER_MS` | `750` | Max jitter padded onto each pacing wait |

## State machine

```
queued ──► attempting ──► submitted ──► confirmed ✓
   ▲           │              │
   │           │              └─► needs_attention   (no confirm in window)
   │           ├─► no_form_found ─► dead
   │           ├─► needs_solver        (CAPTCHA/anti-bot — parked, not looped)
   │           └─► queued              (transient error / lease release)
   └──────────────────────────── lease expiry auto-releases to queued
```

`confirmed` and `dead` are terminal. A `confirmed` domain is **never**
re-queued (cardinal rule: no double-subscribe). `attempting` is held by exactly
one worker via a TTL lease; an expired lease auto-releases.

## Cardinal rules (baked in)

1. **Click ONLY confirmation links.** `src/confirm-link.ts` is a conservative
   allowlist; `extractConfirmLinks` is deliberately unimplemented in A0 so the
   spine cannot follow arbitrary links.
2. **Never real PII.** Personas are synthetic + deterministic by domain.
3. **Idempotent + leased + never double-subscribe.**

## The frozen archive contract

The clients code exactly to `app/controllers/internal/*.rb` (token-auth,
JSON). See `src/archive-client.ts` for the request/response shapes.
