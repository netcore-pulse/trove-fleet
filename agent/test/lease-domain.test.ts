import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TargetStore } from "../src/store.ts";
import { personaValueForField } from "../src/subscribe.ts";
import { personaForDomain } from "../src/persona.ts";
import type { FieldCandidate } from "../src/form-finder.ts";

describe("TargetStore.leaseDomain — targeted single-domain lease (A1 manual path)", () => {
  let store: TargetStore;
  beforeEach(() => {
    store = new TargetStore(":memory:");
    store.ingest([{ domain: "a.com" }, { domain: "b.com" }]);
  });
  afterEach(() => store.close());

  it("leases a specific queued domain (not just the next one)", () => {
    const row = store.leaseDomain("b.com", "w1", 60_000);
    expect(row?.domain).toBe("b.com");
    expect(row?.status).toBe("attempting");
    expect(row?.lease_owner).toBe("w1");
    expect(store.get("a.com")?.status).toBe("queued"); // untouched
  });

  it("returns null for an unknown domain", () => {
    expect(store.leaseDomain("ghost.com", "w1")).toBeNull();
  });

  it("returns null when the domain holds a LIVE lease (one in-flight per domain)", () => {
    store.leaseDomain("a.com", "w1", 60_000);
    expect(store.leaseDomain("a.com", "w2", 60_000)).toBeNull();
  });

  it("reclaims a domain whose lease has EXPIRED", () => {
    store.leaseDomain("a.com", "w1", -1_000); // already expired
    const reclaimed = store.leaseDomain("a.com", "w2", 60_000);
    expect(reclaimed?.lease_owner).toBe("w2");
    expect(reclaimed?.attempts).toBe(2);
  });

  it("returns null for a CONFIRMED domain (never double-subscribe)", () => {
    store.setStatus("a.com", "attempting");
    store.setStatus("a.com", "submitted");
    store.setStatus("a.com", "confirmed");
    expect(store.leaseDomain("a.com", "w1")).toBeNull();
  });

  it("returns null for a parked (needs_solver) domain", () => {
    store.setStatus("b.com", "attempting");
    store.setStatus("b.com", "needs_solver");
    expect(store.leaseDomain("b.com", "w1")).toBeNull();
  });
});

describe("personaValueForField — fills only the fields the form asks for", () => {
  const persona = personaForDomain("brand.com");

  function f(over: Partial<FieldCandidate>): FieldCandidate {
    return {
      id: "x", type: "text", name: "", elementId: "", placeholder: "", ariaLabel: "",
      autocomplete: "", labelText: "", visible: true, regionTag: "form", regionContext: "",
      hasPasswordSibling: false, hasOtherEmailSibling: false, looksLikeSearch: false,
      inFooter: false, inModal: false, contextBlob: "", isHoneypot: false, ...over,
    };
  }

  it("maps first/last/full name", () => {
    expect(personaValueForField(f({ name: "first_name" }), persona)).toBe(persona.firstName);
    expect(personaValueForField(f({ name: "last_name" }), persona)).toBe(persona.lastName);
    expect(personaValueForField(f({ name: "full_name" }), persona)).toBe(persona.fullName);
  });

  it("maps zip/city/state/dob", () => {
    expect(personaValueForField(f({ name: "zip" }), persona)).toBe(persona.postalCode);
    expect(personaValueForField(f({ placeholder: "postal code" }), persona)).toBe(persona.postalCode);
    expect(personaValueForField(f({ name: "city" }), persona)).toBe(persona.city);
    expect(personaValueForField(f({ name: "state" }), persona)).toBe(persona.state);
    expect(personaValueForField(f({ name: "dob" }), persona)).toBe(persona.dateOfBirth);
  });

  it("returns null for an unrecognized/optional field (leave it blank)", () => {
    expect(personaValueForField(f({ name: "company" }), persona)).toBeNull();
    expect(personaValueForField(f({ name: "phone_extension" }), persona)).toBeNull();
  });
});
