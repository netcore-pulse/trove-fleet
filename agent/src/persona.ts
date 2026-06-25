/**
 * Persona pool — synthetic, internally-consistent identities.
 *
 * HARD RULE (handoff "Persona system" + "What NOT to do" #2): NEVER real PII.
 * Every field here is generated from curated synthetic name parts and a
 * deterministic hash of the target domain. The DOB, ZIP, city/state are
 * internally consistent (a real US ZIP prefix maps to a plausible city/state),
 * but the *person* does not exist. This is also the privacy story: every
 * `Hi {FirstName}` a brand later sends resolves to fake data.
 *
 * Deterministic by domain: the same domain always yields the same persona, so a
 * brand sees one coherent identity across retries (handoff: "one coherent
 * identity per target"), and the assignment is reproducible without storing a
 * separate pool table.
 */

import { createHash } from "node:crypto";

export interface Persona {
  firstName: string;
  lastName: string;
  /** Full display name, convenience for form-fill at A1. */
  fullName: string;
  /** US-style 5-digit ZIP. Synthetic but prefix-consistent with city/state. */
  postalCode: string;
  city: string;
  /** Two-letter US state code consistent with the ZIP prefix. */
  state: string;
  /** ISO date (YYYY-MM-DD), adult (>= 18y). */
  dateOfBirth: string;
}

// Curated synthetic name parts. Common-but-generic; no attempt to map to a real
// individual. Lists kept modest — variety comes from the cross-product.
const FIRST_NAMES = [
  "Avery", "Jordan", "Casey", "Riley", "Morgan", "Quinn", "Reese", "Skyler",
  "Cameron", "Hayden", "Emerson", "Rowan", "Sawyer", "Parker", "Logan", "Dakota",
  "Harper", "Finley", "Tatum", "Blake", "Drew", "Elliot", "Marlowe", "Sage",
  "Aubrey", "Bellamy", "Carter", "Devon", "Ellis", "Frankie", "Greer", "Hollis",
] as const;

const LAST_NAMES = [
  "Carter", "Bennett", "Hayes", "Foster", "Brooks", "Reed", "Cole", "Hayden",
  "Spencer", "Mercer", "Sloan", "Vance", "Quincy", "Abbott", "Calloway", "Donovan",
  "Ellison", "Fairfax", "Goodwin", "Holloway", "Ingram", "Jennings", "Kingsley", "Lockhart",
  "Maddox", "Norcross", "Osborne", "Prescott", "Radcliffe", "Sterling", "Thornton", "Whitfield",
] as const;

// Synthetic-but-plausible (ZIP prefix → city/state) tuples. The ZIP body is
// generated; the prefix simply keeps city/state internally consistent.
const LOCALES: ReadonlyArray<{ zipPrefix: string; city: string; state: string }> = [
  { zipPrefix: "100", city: "New York", state: "NY" },
  { zipPrefix: "021", city: "Boston", state: "MA" },
  { zipPrefix: "191", city: "Philadelphia", state: "PA" },
  { zipPrefix: "300", city: "Atlanta", state: "GA" },
  { zipPrefix: "331", city: "Miami", state: "FL" },
  { zipPrefix: "606", city: "Chicago", state: "IL" },
  { zipPrefix: "770", city: "Houston", state: "TX" },
  { zipPrefix: "750", city: "Dallas", state: "TX" },
  { zipPrefix: "800", city: "Denver", state: "CO" },
  { zipPrefix: "850", city: "Phoenix", state: "AZ" },
  { zipPrefix: "981", city: "Seattle", state: "WA" },
  { zipPrefix: "941", city: "San Francisco", state: "CA" },
  { zipPrefix: "900", city: "Los Angeles", state: "CA" },
  { zipPrefix: "554", city: "Minneapolis", state: "MN" },
  { zipPrefix: "972", city: "Portland", state: "OR" },
  { zipPrefix: "020", city: "Cambridge", state: "MA" },
];

/** Deterministic 32-bit unsigned int from a string (FNV-ish via sha256). */
function hashToInt(input: string, salt: string): number {
  const h = createHash("sha256").update(salt).update("\x00").update(input).digest();
  // Read first 4 bytes as an unsigned 32-bit int.
  return h.readUInt32BE(0);
}

function pick<T>(arr: readonly T[], n: number): T {
  // Non-empty arrays only; all module-level lists above are non-empty.
  return arr[n % arr.length] as T;
}

/**
 * Generate the coherent persona for a given (already-canonical) domain.
 * Pure + deterministic: same domain -> same persona, forever.
 */
export function personaForDomain(domain: string): Persona {
  const key = domain.toLowerCase();

  const firstName = pick(FIRST_NAMES, hashToInt(key, "first"));
  const lastName = pick(LAST_NAMES, hashToInt(key, "last"));
  const locale = pick(LOCALES, hashToInt(key, "locale"));

  // ZIP: 3-digit synthetic-consistent prefix + 2 generated digits.
  const zipBody = (hashToInt(key, "zip") % 100).toString().padStart(2, "0");
  const postalCode = `${locale.zipPrefix}${zipBody}`;

  // DOB: adult between 22 and 59 years old, deterministic day-of-year.
  const ageYears = 22 + (hashToInt(key, "age") % 38); // 22..59
  const dayOfYear = hashToInt(key, "dob") % 365; // 0..364
  const birthYear = new Date().getUTCFullYear() - ageYears;
  const dob = new Date(Date.UTC(birthYear, 0, 1));
  dob.setUTCDate(dob.getUTCDate() + dayOfYear);
  const dateOfBirth = dob.toISOString().slice(0, 10);

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    postalCode,
    city: locale.city,
    state: locale.state,
    dateOfBirth,
  };
}

/** Size of the theoretical persona space (for docs/sanity, not load-bearing). */
export const PERSONA_SPACE = FIRST_NAMES.length * LAST_NAMES.length * LOCALES.length;
