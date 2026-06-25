import { describe, it, expect } from "vitest";
import { ManualClock, systemClock } from "../src/fleet/clock.ts";

describe("ManualClock — deterministic virtual time", () => {
  it("now() only advances when advanced", async () => {
    const c = new ManualClock(1000);
    expect(c.now()).toBe(1000);
    await c.advance(500);
    expect(c.now()).toBe(1500);
  });

  it("sleep() resolves exactly when virtual time crosses the wakeup", async () => {
    const c = new ManualClock(0);
    let woke = false;
    const p = c.sleep(100).then(() => {
      woke = true;
    });

    await c.advance(50);
    await Promise.resolve();
    expect(woke).toBe(false); // not yet

    await c.advance(50); // now at 100
    await p;
    expect(woke).toBe(true);
  });

  it("sleep(0) resolves promptly without advancing", async () => {
    const c = new ManualClock(0);
    let woke = false;
    await c.sleep(0).then(() => {
      woke = true;
    });
    expect(woke).toBe(true);
    expect(c.now()).toBe(0);
  });

  it("runAll() drains all sleepers in time order", async () => {
    const c = new ManualClock(0);
    const order: number[] = [];
    void c.sleep(300).then(() => order.push(300));
    void c.sleep(100).then(() => order.push(100));
    void c.sleep(200).then(() => order.push(200));

    await c.runAll();
    expect(order).toEqual([100, 200, 300]);
    expect(c.pendingCount).toBe(0);
  });

  it("records the timestamp at which each sleep was issued", async () => {
    const c = new ManualClock(0);
    c.sleep(10);
    await c.advance(10);
    c.sleep(5);
    expect(c.issuedAt).toEqual([0, 10]);
  });
});

describe("systemClock", () => {
  it("now() returns a real epoch ms", () => {
    const before = Date.now();
    const n = systemClock.now();
    expect(n).toBeGreaterThanOrEqual(before);
  });

  it("sleep(0) resolves without a timer", async () => {
    await expect(systemClock.sleep(0)).resolves.toBeUndefined();
  });
});
