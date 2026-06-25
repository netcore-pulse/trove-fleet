import { describe, it, expect } from "vitest";
import { EnvProxyPool, NullProxyPool, proxyPoolFromEnv } from "../src/fleet/proxy-pool.ts";
import { ManualClock } from "../src/fleet/clock.ts";

describe("EnvProxyPool — rotation + dead-proxy detection", () => {
  it("round-robins across proxies", () => {
    const pool = new EnvProxyPool(["http://a:1", "http://b:2", "http://c:3"]);
    const ids = [pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()].map((l) => l.id);
    expect(ids).toEqual(["proxy-0", "proxy-1", "proxy-2", "proxy-0"]);
  });

  it("carries the server URL for chromium wiring", () => {
    const pool = new EnvProxyPool(["socks5://h:9050"]);
    const lease = pool.acquire();
    expect(lease.server).toBe("socks5://h:9050");
  });

  it("marks a proxy unhealthy after deadThreshold consecutive failures and rotates away", () => {
    const pool = new EnvProxyPool(["http://a:1", "http://b:2"], { deadThreshold: 3 });
    // Fail proxy-0 three times (it's handed out on rounds 0,2,4 ...). Force it:
    // acquire 0, fail; the next acquire returns proxy-1 (rotation). To target
    // proxy-0 repeatedly we report fail each time it appears.
    for (let i = 0; i < 6; i++) {
      const lease = pool.acquire();
      if (lease.id === "proxy-0") lease.report(false);
      else lease.report(true);
    }
    const health = pool.health();
    const p0 = health.find((h) => h.id === "proxy-0")!;
    expect(p0.consecutiveFailures).toBeGreaterThanOrEqual(3);
    expect(p0.healthy).toBe(false);
    expect(pool.healthyCount()).toBe(1);

    // Subsequent acquires should skip the dead proxy-0 and return proxy-1.
    expect(pool.acquire().id).toBe("proxy-1");
    expect(pool.acquire().id).toBe("proxy-1");
  });

  it("a success resets the failure streak", () => {
    const pool = new EnvProxyPool(["http://a:1"], { deadThreshold: 3 });
    pool.acquire().report(false);
    pool.acquire().report(false);
    pool.acquire().report(true); // reset
    const p0 = pool.health()[0]!;
    expect(p0.consecutiveFailures).toBe(0);
    expect(p0.healthy).toBe(true);
  });

  it("falls back to handing out a proxy even when all are unhealthy (degraded > stalled)", () => {
    const pool = new EnvProxyPool(["http://a:1"], { deadThreshold: 1 });
    pool.acquire().report(false); // now unhealthy
    expect(pool.healthyCount()).toBe(0);
    const lease = pool.acquire();
    expect(lease.id).toBe("proxy-0"); // still served
  });

  it("a lease reports its outcome exactly once", () => {
    const pool = new EnvProxyPool(["http://a:1"]);
    const lease = pool.acquire();
    lease.report(false);
    lease.report(true); // ignored
    const p0 = pool.health()[0]!;
    expect(p0.totalFailures).toBe(1);
    expect(p0.totalSuccesses).toBe(0);
  });

  it("stamps lastUsedAt from the injected clock", () => {
    const clock = new ManualClock(5000);
    const pool = new EnvProxyPool(["http://a:1"], { clock });
    pool.acquire();
    expect(pool.health()[0]!.lastUsedAt).toBe(5000);
  });

  it("rejects an empty server list", () => {
    expect(() => new EnvProxyPool([])).toThrow();
    expect(() => new EnvProxyPool(["  ", ""])).toThrow();
  });

  it("fromEnv parses a comma list, returns null when unset/empty", () => {
    expect(EnvProxyPool.fromEnv("http://a:1, http://b:2")?.size()).toBe(2);
    expect(EnvProxyPool.fromEnv(undefined)).toBeNull();
    expect(EnvProxyPool.fromEnv("")).toBeNull();
    expect(EnvProxyPool.fromEnv("  ,  ")).toBeNull();
  });
});

describe("NullProxyPool — direct egress", () => {
  it("is a single always-healthy direct lease", () => {
    const pool = new NullProxyPool();
    const lease = pool.acquire();
    expect(lease.id).toBe("direct");
    expect(lease.server).toBeNull();
    expect(pool.healthyCount()).toBe(1);
    expect(pool.size()).toBe(1);
  });

  it("accepts reports inertly (tracked but never goes unhealthy)", () => {
    const pool = new NullProxyPool();
    pool.acquire().report(false);
    pool.acquire().report(true);
    expect(pool.healthyCount()).toBe(1);
    const h = pool.health()[0]!;
    expect(h.totalFailures).toBe(1);
    expect(h.totalSuccesses).toBe(1);
  });
});

describe("proxyPoolFromEnv", () => {
  it("returns EnvProxyPool when TROVE_PROXY_URLS is set, else NullProxyPool", () => {
    expect(proxyPoolFromEnv({ TROVE_PROXY_URLS: "http://a:1,http://b:2" }).size()).toBe(2);
    expect(proxyPoolFromEnv({}).size()).toBe(1); // null pool
  });
});
