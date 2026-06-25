import { describe, it, expect } from "vitest";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  isConfirmedOrInFlight,
  isTerminal,
  STATUSES,
} from "../src/state.ts";

describe("state machine — legal transitions", () => {
  it("allows the happy path queued → attempting → submitted → confirmed", () => {
    expect(canTransition("queued", "attempting")).toBe(true);
    expect(canTransition("attempting", "submitted")).toBe(true);
    expect(canTransition("submitted", "confirmed")).toBe(true);
  });

  it("allows attempting to fall back to queued (transient error / lease release)", () => {
    expect(canTransition("attempting", "queued")).toBe(true);
  });

  it("allows attempting → no_form_found and → needs_solver", () => {
    expect(canTransition("attempting", "no_form_found")).toBe(true);
    expect(canTransition("attempting", "needs_solver")).toBe(true);
  });

  it("allows submitted → needs_attention (no confirm in window)", () => {
    expect(canTransition("submitted", "needs_attention")).toBe(true);
  });

  it("allows parking lots to be re-queued", () => {
    expect(canTransition("needs_attention", "queued")).toBe(true);
    expect(canTransition("needs_solver", "queued")).toBe(true);
    expect(canTransition("no_form_found", "queued")).toBe(true);
  });
});

describe("state machine — illegal transitions throw", () => {
  it("throws on confirmed → anything (terminal, never double-subscribe)", () => {
    for (const to of STATUSES) {
      expect(() => assertTransition("confirmed", to)).toThrow(IllegalTransitionError);
    }
  });

  it("throws on dead → anything (terminal)", () => {
    for (const to of STATUSES) {
      expect(() => assertTransition("dead", to)).toThrow(IllegalTransitionError);
    }
  });

  it("throws on queued → submitted (must pass through attempting)", () => {
    expect(() => assertTransition("queued", "submitted")).toThrow(IllegalTransitionError);
  });

  it("throws on queued → confirmed (cannot skip the loop)", () => {
    expect(() => assertTransition("queued", "confirmed")).toThrow(IllegalTransitionError);
  });

  it("rejects self-transitions", () => {
    for (const s of STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });
});

describe("state helpers", () => {
  it("isTerminal marks confirmed + dead terminal only", () => {
    expect(isTerminal("confirmed")).toBe(true);
    expect(isTerminal("dead")).toBe(true);
    expect(isTerminal("queued")).toBe(false);
    expect(isTerminal("attempting")).toBe(false);
  });

  it("isConfirmedOrInFlight covers confirmed + attempting + submitted", () => {
    expect(isConfirmedOrInFlight("confirmed")).toBe(true);
    expect(isConfirmedOrInFlight("attempting")).toBe(true);
    expect(isConfirmedOrInFlight("submitted")).toBe(true);
    expect(isConfirmedOrInFlight("queued")).toBe(false);
    expect(isConfirmedOrInFlight("needs_solver")).toBe(false);
  });
});
