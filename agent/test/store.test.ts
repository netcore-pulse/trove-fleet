import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TargetStore } from "../src/store.ts";
import { IllegalTransitionError } from "../src/state.ts";
import { syntheticSeed } from "./helpers/seed-gen.ts";

function freshStore(): TargetStore {
  // In-memory DB → isolated, fast, no fs writes.
  return new TargetStore(":memory:");
}

describe("TargetStore — seed ingest (the A0 gate)", () => {
  let store: TargetStore;
  beforeEach(() => {
    store = freshStore();
  });
  afterEach(() => store.close());

  it("loads a 1K seed, dedups variants, lands all as queued", () => {
    const seed = syntheticSeed(1000);
    const r = store.ingest(seed.rows);

    // Canonicalization collapsed www / path / scheme / subdomain variants.
    expect(r.distinct).toBe(1000);
    expect(r.invalid).toBe(seed.expectedInvalid);
    expect(r.inserted).toBe(1000);

    // Exactly 1000 rows, every one queued.
    expect(store.count()).toBe(1000);
    const by = store.statsByStatus();
    expect(by.queued).toBe(1000);
    expect(by.confirmed).toBe(0);
    expect(by.attempting).toBe(0);
  });

  it("proves registrable collapse: www.X / X.com/uk / X collapse to one row", () => {
    const rows = [
      { domain: "nike.com", brand_name: "Nike", category: "Apparel" },
      { domain: "www.nike.com" },
      { domain: "https://www.nike.com/uk" },
      { domain: "HTTP://NIKE.COM/en?ref=x" },
      { domain: "shop.nike.com" },
    ];
    const r = store.ingest(rows);
    expect(r.parsed).toBe(5);
    expect(r.distinct).toBe(1);
    expect(r.inserted).toBe(1);
    expect(store.count()).toBe(1);

    const row = store.get("nike.com");
    expect(row?.status).toBe("queued");
    expect(row?.brand_name).toBe("Nike");
    expect(row?.category).toBe("Apparel");
  });

  it("re-loading is idempotent: never re-queues confirmed or in-flight domains", () => {
    store.ingest([{ domain: "nike.com" }, { domain: "adidas.com" }, { domain: "puma.com" }]);

    // Advance a few through the machine.
    store.setStatus("nike.com", "attempting");
    store.setStatus("nike.com", "submitted");
    store.setStatus("nike.com", "confirmed"); // terminal, confirmed
    store.setStatus("adidas.com", "attempting"); // in-flight

    const before = store.statsByStatus();
    expect(before.confirmed).toBe(1);
    expect(before.attempting).toBe(1);
    expect(before.queued).toBe(1); // puma

    // Re-load the SAME seed.
    const r = store.ingest([{ domain: "nike.com" }, { domain: "adidas.com" }, { domain: "puma.com" }]);
    expect(r.inserted).toBe(0);
    expect(r.skipped).toBe(3);

    // Nothing disturbed: confirmed stays confirmed, in-flight stays in-flight.
    const after = store.statsByStatus();
    expect(after.confirmed).toBe(1);
    expect(after.attempting).toBe(1);
    expect(after.queued).toBe(1);
    expect(store.count()).toBe(3);
  });

  it("backfills missing metadata on a still-queued row when re-loaded", () => {
    store.ingest([{ domain: "nike.com" }]);
    expect(store.get("nike.com")?.brand_name).toBeNull();

    store.ingest([{ domain: "www.nike.com", brand_name: "Nike", category: "Apparel" }]);
    const row = store.get("nike.com");
    expect(row?.brand_name).toBe("Nike");
    expect(row?.category).toBe("Apparel");
    expect(row?.status).toBe("queued");
  });

  it("coverage % = confirmed / total", () => {
    store.ingest([{ domain: "a.com" }, { domain: "b.com" }, { domain: "c.com" }, { domain: "d.com" }]);
    store.setStatus("a.com", "attempting");
    store.setStatus("a.com", "submitted");
    store.setStatus("a.com", "confirmed");
    expect(store.coveragePct()).toBe(25);
  });
});

describe("TargetStore — state transitions", () => {
  let store: TargetStore;
  beforeEach(() => {
    store = freshStore();
    store.ingest([{ domain: "nike.com" }]);
  });
  afterEach(() => store.close());

  it("performs a legal transition and stamps fields", () => {
    store.setStatus("nike.com", "attempting");
    const row = store.setStatus("nike.com", "submitted", { addressId: 42, address: "nike.abc@in.trove.dev" });
    expect(row.status).toBe("submitted");
    expect(row.address_id).toBe(42);
    expect(row.address).toBe("nike.abc@in.trove.dev");
  });

  it("throws on an illegal transition (queued → confirmed)", () => {
    expect(() => store.setStatus("nike.com", "confirmed")).toThrow(IllegalTransitionError);
  });

  it("throws when transitioning an unknown domain", () => {
    expect(() => store.setStatus("ghost.com", "attempting")).toThrow(/Unknown target/);
  });

  it("records last_error on a fall-back to queued", () => {
    store.setStatus("nike.com", "attempting");
    const row = store.setStatus("nike.com", "queued", { lastError: "ETIMEDOUT" });
    expect(row.status).toBe("queued");
    expect(row.last_error).toBe("ETIMEDOUT");
    // Lease cleared when leaving attempting.
    expect(row.lease_owner).toBeNull();
    expect(row.lease_expires_at).toBeNull();
  });
});

describe("TargetStore — leasing + TTL", () => {
  let store: TargetStore;
  beforeEach(() => {
    store = freshStore();
    store.ingest([{ domain: "a.com" }, { domain: "b.com" }]);
  });
  afterEach(() => store.close());

  it("leases the next queued target and stamps owner + expiry", () => {
    const row = store.leaseNext("worker-1", 60_000);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("attempting");
    expect(row!.lease_owner).toBe("worker-1");
    expect(row!.lease_expires_at).toBeGreaterThan(Date.now());
    expect(row!.attempts).toBe(1);
    expect(store.holdsLease(row!.domain, "worker-1")).toBe(true);
  });

  it("at most one worker holds a domain (no double-lease of the same row)", () => {
    const first = store.leaseNext("worker-1", 60_000);
    const second = store.leaseNext("worker-2", 60_000);
    expect(first!.domain).not.toBe(second!.domain); // got the other queued one
    // No queued left → third lease is null (both held, neither expired).
    expect(store.leaseNext("worker-3", 60_000)).toBeNull();
  });

  it("an EXPIRED lease auto-releases and is re-leasable", () => {
    // Lease both with a TTL already in the past.
    const a = store.leaseNext("worker-1", -1_000)!;
    const b = store.leaseNext("worker-1", -1_000)!;
    expect(a.lease_expires_at).toBeLessThan(Date.now());
    expect(b.lease_expires_at).toBeLessThan(Date.now());

    // worker-1 no longer "holds" them (expired).
    expect(store.holdsLease(a.domain, "worker-1")).toBe(false);

    // A fresh worker reclaims an expired-lease row.
    const reclaimed = store.leaseNext("worker-2", 60_000);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.lease_owner).toBe("worker-2");
    expect(reclaimed!.status).toBe("attempting");
    expect(reclaimed!.attempts).toBe(2); // incremented again on reclaim
  });

  it("releaseExpiredLeases sweeps expired holds back to queued", () => {
    store.leaseNext("worker-1", -1_000);
    store.leaseNext("worker-1", -1_000);
    expect(store.statsByStatus().attempting).toBe(2);

    const released = store.releaseExpiredLeases();
    expect(released).toBe(2);
    expect(store.statsByStatus().queued).toBe(2);
    expect(store.statsByStatus().attempting).toBe(0);
  });

  it("does NOT sweep a live (un-expired) lease", () => {
    store.leaseNext("worker-1", 60_000);
    expect(store.releaseExpiredLeases()).toBe(0);
    expect(store.statsByStatus().attempting).toBe(1);
  });

  it("releaseLease only releases the holder's own lease", () => {
    const a = store.leaseNext("worker-1", 60_000)!;
    expect(store.releaseLease(a.domain, "worker-2")).toBe(false); // not the owner
    expect(store.releaseLease(a.domain, "worker-1")).toBe(true);
    expect(store.get(a.domain)?.status).toBe("queued");
  });
});
