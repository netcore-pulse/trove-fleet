import { describe, it, expect } from "vitest";
import { classifyOutcome, type PageSnapshot } from "../src/outcome.ts";

function snap(over: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    bodyText: "",
    hasCaptchaWidget: false,
    hasValidationError: false,
    emailFieldStillPresent: false,
    ...over,
  };
}

describe("classifyOutcome — the four post-submit branches", () => {
  it("'check your email' copy → success", () => {
    expect(classifyOutcome(snap({ bodyText: "almost there! please confirm your subscription — check your email." }))).toBe("success");
  });

  it("'thanks for subscribing' copy → success", () => {
    expect(classifyOutcome(snap({ bodyText: "thanks for subscribing! please check your email to confirm." }))).toBe("success");
  });

  it("a CAPTCHA widget present → captcha (even with leftover success-ish copy)", () => {
    expect(
      classifyOutcome(snap({ hasCaptchaWidget: true, bodyText: "thanks for subscribing" })),
    ).toBe("captcha");
  });

  it("CAPTCHA copy ('verify you are human') → captcha", () => {
    expect(classifyOutcome(snap({ bodyText: "please verify you are human before subscribing." }))).toBe("captcha");
  });

  it("a visible validation error → validation_error", () => {
    expect(classifyOutcome(snap({ hasValidationError: true }))).toBe("validation_error");
  });

  it("validation copy ('please enter a valid email') → validation_error", () => {
    expect(classifyOutcome(snap({ bodyText: "please enter a valid email address." }))).toBe("validation_error");
  });

  it("no success copy + the email field still sitting there → validation_error (it didn't take)", () => {
    expect(classifyOutcome(snap({ emailFieldStillPresent: true, bodyText: "subscribe to our newsletter" }))).toBe(
      "validation_error",
    );
  });

  it("nothing recognizable and the field is gone → unknown", () => {
    expect(classifyOutcome(snap({ bodyText: "loading...", emailFieldStillPresent: false }))).toBe("unknown");
  });

  it("captcha takes precedence over validation", () => {
    expect(
      classifyOutcome(snap({ hasCaptchaWidget: true, hasValidationError: true })),
    ).toBe("captcha");
  });
});
