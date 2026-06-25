import { describe, it, expect } from "vitest";
import { looksLikeDismissControl } from "../src/browser/overlays.ts";

describe("looksLikeDismissControl — classifies overlay dismissal controls", () => {
  it("classifies cookie-accept controls as 'accept'", () => {
    for (const t of ["Accept", "Accept All", "I Agree", "Agree", "Got it", "OK", "Allow all", "Continue"]) {
      expect(looksLikeDismissControl(t)).toBe("accept");
    }
  });

  it("classifies popup-close controls as 'close'", () => {
    for (const t of ["Close", "Dismiss", "No thanks", "Maybe later", "Not now", "Skip", "×", "x"]) {
      expect(looksLikeDismissControl(t)).toBe("close");
    }
  });

  it("'No thanks' / 'Skip' read as close, never as accept", () => {
    expect(looksLikeDismissControl("No thanks")).toBe("close");
    expect(looksLikeDismissControl("Skip")).toBe("close");
  });

  it("returns null for non-dismissal controls (never clicks the real CTA)", () => {
    for (const t of ["Subscribe", "Sign Up", "Reject", "Manage preferences", "Learn more", "Buy now", ""]) {
      expect(looksLikeDismissControl(t)).toBeNull();
    }
  });
});
