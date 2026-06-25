/**
 * Persona-derived browser fingerprint variation.
 *
 * Footprint rule (handoff "Footprint management"): vary persona, viewport,
 * user-agent, and locale across workers so 200K subscriptions don't all look
 * like one machine. A0's persona is already a deterministic function of the
 * domain; we derive the *browser* fingerprint from that same persona so a brand
 * sees one coherent machine + identity per target, stable across retries.
 *
 * Pure + deterministic: same persona -> same fingerprint. No browser needed, so
 * this is unit-testable in isolation (the heuristic, not the chromium driver).
 *
 * A1 does NOT rotate egress IPs — that is A3 (proxy pool). This module covers
 * only the context-level fingerprint (viewport / UA / locale / timezone) that a
 * single context can vary without infrastructure.
 */

import { createHash } from "node:crypto";
import type { Persona } from "../persona.ts";

export interface Fingerprint {
  /** Browser context viewport. */
  viewport: { width: number; height: number };
  /** Full User-Agent string. */
  userAgent: string;
  /** BCP-47 locale (always an en-US-ish locale — personas are US-shaped). */
  locale: string;
  /** IANA timezone consistent with the persona's US state. */
  timezoneId: string;
  /** Device scale factor (1 or 2). */
  deviceScaleFactor: number;
}

// A small spread of *plausible desktop* viewports. Real consumer resolutions;
// nothing exotic that would itself look like a bot.
const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
];

// A spread of *current, common* desktop UAs. Kept modest; variety comes from the
// cross-product with viewport/locale. Chrome-on-Mac/Win + a Firefox + a Safari.
const USER_AGENTS: readonly string[] = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
];

// US state -> IANA timezone (coarse but internally consistent with the persona's
// state/city). Falls back to America/New_York for any unlisted code.
const STATE_TZ: Record<string, string> = {
  NY: "America/New_York",
  MA: "America/New_York",
  PA: "America/New_York",
  GA: "America/New_York",
  FL: "America/New_York",
  IL: "America/Chicago",
  TX: "America/Chicago",
  MN: "America/Chicago",
  CO: "America/Denver",
  AZ: "America/Phoenix",
  WA: "America/Los_Angeles",
  CA: "America/Los_Angeles",
  OR: "America/Los_Angeles",
};

/** Deterministic unsigned 32-bit int from a string under a salt. */
function hashToInt(input: string, salt: string): number {
  const h = createHash("sha256").update(salt).update("\x00").update(input).digest();
  return h.readUInt32BE(0);
}

function pick<T>(arr: readonly T[], n: number): T {
  return arr[n % arr.length] as T;
}

/**
 * Derive the deterministic browser fingerprint for a persona.
 *
 * Keyed off the persona's full name + ZIP so it is stable per-target (the
 * persona itself is stable per-domain) without re-hashing the domain here.
 */
export function fingerprintForPersona(persona: Persona): Fingerprint {
  const key = `${persona.fullName}|${persona.postalCode}`;

  const viewport = pick(VIEWPORTS, hashToInt(key, "viewport"));
  const userAgent = pick(USER_AGENTS, hashToInt(key, "ua"));
  const timezoneId = STATE_TZ[persona.state] ?? "America/New_York";
  // Retina-class displays are common; flip a deterministic coin.
  const deviceScaleFactor = hashToInt(key, "dpr") % 2 === 0 ? 1 : 2;

  return {
    viewport,
    userAgent,
    locale: "en-US",
    timezoneId,
    deviceScaleFactor,
  };
}
