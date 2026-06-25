/**
 * Proxy abstraction (A3) — the rotation seam, NOT a specific vendor.
 *
 * The footprint rule (handoff "Footprint management"): 200K subscriptions from
 * one egress IP are flagged instantly. We need rotating egress with dead-proxy
 * detection. BUT the real provider is deferred — the owner is still weighing
 * GitHub-Actions egress vs. a residential/datacenter proxy vendor. So we build
 * the *interface* + rotation + health tracking, and ship two implementations:
 *
 *   - {@link EnvProxyPool}   — rotates over a static list (TROVE_PROXY_URLS).
 *                              This is the production shape the moment a list of
 *                              proxy URLs exists, vendor-agnostic.
 *   - {@link NullProxyPool}  — a single "direct" lease (no proxy). Dev + tests.
 *
 * Health model (dead-proxy detection): each lease is reported back via
 * {@link ProxyLease.report}. Repeated failures (>= `deadThreshold` consecutive)
 * mark a proxy unhealthy; the rotator skips unhealthy proxies. A later success
 * resets a proxy's failure streak. If ALL proxies go unhealthy, the pool falls
 * back to handing them out anyway (degraded-but-alive beats a stalled fleet) —
 * `doctor`/metrics surface the all-unhealthy condition.
 *
 * What a proxy URL becomes (later, not now): the worker passes it to
 * `chromium.launch({ proxy: { server } })`. A1's BrowserWorker already documents
 * this as the slot-in point. A3 does not wire chromium to the proxy yet (no real
 * provider), but the lease carries the `server` string so the wiring is a
 * one-liner when a provider lands.
 */

import type { Clock } from "./clock.ts";
import { systemClock } from "./clock.ts";

/** A single leased proxy. Report the outcome so health tracking can rotate away. */
export interface ProxyLease {
  /** Proxy id (stable; for metrics/health). `"direct"` for the null pool. */
  readonly id: string;
  /** The proxy server URL to pass to chromium, or null for a direct connection. */
  readonly server: string | null;
  /** Report whether the attempt that used this proxy succeeded. */
  report(ok: boolean): void;
}

export interface ProxyHealth {
  id: string;
  server: string | null;
  healthy: boolean;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  lastUsedAt: number | null;
}

export interface ProxyPool {
  /** Lease the next proxy to use (round-robin over healthy proxies). */
  acquire(): ProxyLease;
  /** Snapshot of every proxy's health (for `doctor` / metrics). */
  health(): ProxyHealth[];
  /** How many proxies are currently considered healthy. */
  healthyCount(): number;
  /** Total proxies in the pool. */
  size(): number;
}

interface ProxyState {
  id: string;
  server: string | null;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  lastUsedAt: number | null;
}

export interface ProxyPoolOptions {
  /** Consecutive failures before a proxy is marked unhealthy (default 3). */
  deadThreshold?: number;
  clock?: Clock;
}

/**
 * Round-robin pool over a fixed set of proxy server URLs, with consecutive-
 * failure dead-proxy detection. Vendor-agnostic: a "server" is whatever string
 * chromium accepts (`http://host:port`, `socks5://...`, with embedded creds).
 */
export class EnvProxyPool implements ProxyPool {
  private readonly proxies: ProxyState[];
  private readonly deadThreshold: number;
  private readonly clock: Clock;
  private cursor = 0;

  constructor(servers: string[], opts: ProxyPoolOptions = {}) {
    this.deadThreshold = opts.deadThreshold ?? 3;
    this.clock = opts.clock ?? systemClock;
    const cleaned = servers.map((s) => s.trim()).filter((s) => s !== "");
    if (cleaned.length === 0) {
      throw new Error("EnvProxyPool requires at least one proxy server URL");
    }
    this.proxies = cleaned.map((server, i) => ({
      id: `proxy-${i}`,
      server,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      lastUsedAt: null,
    }));
  }

  /** Parse a comma-separated env value into a pool, or null if unset/empty. */
  static fromEnv(value: string | undefined, opts: ProxyPoolOptions = {}): EnvProxyPool | null {
    if (!value || value.trim() === "") return null;
    const servers = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (servers.length === 0) return null;
    return new EnvProxyPool(servers, opts);
  }

  private isHealthy(p: ProxyState): boolean {
    return p.consecutiveFailures < this.deadThreshold;
  }

  healthyCount(): number {
    return this.proxies.filter((p) => this.isHealthy(p)).length;
  }

  size(): number {
    return this.proxies.length;
  }

  acquire(): ProxyLease {
    const n = this.proxies.length;
    // Walk round-robin from the cursor, preferring a healthy proxy. If every
    // proxy is unhealthy, fall back to the next one anyway (degraded > stalled).
    let chosen: ProxyState | null = null;
    for (let i = 0; i < n; i++) {
      const p = this.proxies[(this.cursor + i) % n]!;
      if (this.isHealthy(p)) {
        chosen = p;
        this.cursor = (this.cursor + i + 1) % n;
        break;
      }
    }
    if (!chosen) {
      // All unhealthy — hand out the next in rotation regardless.
      chosen = this.proxies[this.cursor % n]!;
      this.cursor = (this.cursor + 1) % n;
    }
    chosen.lastUsedAt = this.clock.now();
    return this.makeLease(chosen);
  }

  private makeLease(p: ProxyState): ProxyLease {
    let reported = false;
    return {
      id: p.id,
      server: p.server,
      report: (ok: boolean): void => {
        if (reported) return; // a lease's outcome is reported exactly once
        reported = true;
        if (ok) {
          p.consecutiveFailures = 0;
          p.totalSuccesses++;
        } else {
          p.consecutiveFailures++;
          p.totalFailures++;
        }
      },
    };
  }

  health(): ProxyHealth[] {
    return this.proxies.map((p) => ({
      id: p.id,
      server: p.server,
      healthy: this.isHealthy(p),
      consecutiveFailures: p.consecutiveFailures,
      totalSuccesses: p.totalSuccesses,
      totalFailures: p.totalFailures,
      lastUsedAt: p.lastUsedAt,
    }));
  }
}

/**
 * Direct connection — no proxy. The dev/test default and the honest fallback
 * when no proxy list is configured. Always "healthy"; rotation is a no-op (one
 * egress). Reporting is accepted (so callers needn't branch) but inert.
 */
export class NullProxyPool implements ProxyPool {
  private successes = 0;
  private failures = 0;
  private lastUsedAt: number | null = null;
  private readonly clock: Clock;

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? systemClock;
  }

  acquire(): ProxyLease {
    this.lastUsedAt = this.clock.now();
    let reported = false;
    return {
      id: "direct",
      server: null,
      report: (ok: boolean): void => {
        if (reported) return;
        reported = true;
        if (ok) this.successes++;
        else this.failures++;
      },
    };
  }

  health(): ProxyHealth[] {
    return [
      {
        id: "direct",
        server: null,
        healthy: true,
        consecutiveFailures: 0,
        totalSuccesses: this.successes,
        totalFailures: this.failures,
        lastUsedAt: this.lastUsedAt,
      },
    ];
  }

  healthyCount(): number {
    return 1;
  }

  size(): number {
    return 1;
  }
}

/**
 * Build the configured proxy pool from the environment. Returns an
 * {@link EnvProxyPool} when `TROVE_PROXY_URLS` is a non-empty comma list, else a
 * {@link NullProxyPool} (direct). Centralizes the "which pool" decision so the
 * burst/maintenance runners + `doctor` all agree.
 */
export function proxyPoolFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: ProxyPoolOptions = {},
): ProxyPool {
  return EnvProxyPool.fromEnv(env.TROVE_PROXY_URLS, opts) ?? new NullProxyPool({ clock: opts.clock });
}
