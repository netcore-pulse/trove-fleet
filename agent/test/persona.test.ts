import { describe, it, expect } from "vitest";
import { personaForDomain, PERSONA_SPACE } from "../src/persona.ts";
import { distinctDomains } from "./helpers/seed-gen.ts";

describe("persona pool — synthetic + deterministic", () => {
  it("is deterministic by domain (same domain → same persona)", () => {
    const a = personaForDomain("nike.com");
    const b = personaForDomain("nike.com");
    expect(a).toEqual(b);
  });

  it("is case-insensitive on the domain key", () => {
    expect(personaForDomain("NIKE.com")).toEqual(personaForDomain("nike.com"));
  });

  it("produces internally-consistent, well-formed fields", () => {
    const p = personaForDomain("example.com");
    expect(p.firstName).toMatch(/^[A-Za-z]+$/);
    expect(p.lastName).toMatch(/^[A-Za-z]+$/);
    expect(p.fullName).toBe(`${p.firstName} ${p.lastName}`);
    // US 5-digit ZIP.
    expect(p.postalCode).toMatch(/^\d{5}$/);
    expect(p.state).toMatch(/^[A-Z]{2}$/);
    expect(p.city.length).toBeGreaterThan(0);
    // ISO date, and an adult (>= 18y).
    expect(p.dateOfBirth).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const age = (Date.now() - Date.parse(p.dateOfBirth)) / (365.25 * 24 * 3600 * 1000);
    expect(age).toBeGreaterThanOrEqual(18);
    expect(age).toBeLessThan(100);
  });

  it("spreads across the pool (not all identical) over many domains", () => {
    const domains = distinctDomains(500);
    const names = new Set(domains.map((d) => personaForDomain(d).fullName));
    // With a 32x32 name cross-product we expect plenty of variety.
    expect(names.size).toBeGreaterThan(50);
  });

  it("exposes a non-trivial persona space", () => {
    expect(PERSONA_SPACE).toBeGreaterThan(1000);
  });
});
