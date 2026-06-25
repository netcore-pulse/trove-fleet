import { describe, it, expect } from "vitest";
import { fingerprintForPersona } from "../src/browser/fingerprint.ts";
import { personaForDomain } from "../src/persona.ts";

describe("fingerprintForPersona — deterministic, persona-derived variation", () => {
  it("is deterministic: same persona → same fingerprint", () => {
    const p = personaForDomain("nike.com");
    const a = fingerprintForPersona(p);
    const b = fingerprintForPersona(p);
    expect(a).toEqual(b);
  });

  it("produces a plausible desktop fingerprint shape", () => {
    const fp = fingerprintForPersona(personaForDomain("adidas.com"));
    expect(fp.viewport.width).toBeGreaterThanOrEqual(1280);
    expect(fp.viewport.height).toBeGreaterThanOrEqual(700);
    expect(fp.userAgent).toMatch(/Mozilla\/5\.0/);
    expect(fp.locale).toBe("en-US");
    expect(fp.timezoneId).toMatch(/^America\//);
    expect([1, 2]).toContain(fp.deviceScaleFactor);
  });

  it("timezone is consistent with the persona's US state", () => {
    // Find a domain whose persona lands in a CA/WA/OR state → Pacific tz.
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      const p = personaForDomain(`brand${i}.com`);
      const fp = fingerprintForPersona(p);
      if (["CA", "WA", "OR"].includes(p.state)) {
        expect(fp.timezoneId).toBe("America/Los_Angeles");
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it("varies across personas (not all identical)", () => {
    const fps = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const fp = fingerprintForPersona(personaForDomain(`brand${i}.com`));
      fps.add(`${fp.viewport.width}x${fp.viewport.height}|${fp.userAgent}|${fp.deviceScaleFactor}`);
    }
    // The cross-product should yield real variety across 40 brands.
    expect(fps.size).toBeGreaterThan(5);
  });
});
