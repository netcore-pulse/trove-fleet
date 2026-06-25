/**
 * Registrable-domain canonicalization — "one door" for seed ingest.
 *
 * Per the handoff: `nike.com` == `www.nike.com` == `nike.com/uk`. We collapse
 * any raw input (bare domain, URL, host with subdomain/path/port/query) down to
 * its registrable domain (eTLD+1) using the public suffix list via `tldts`.
 *
 *   https://www.nike.com/uk/  -> nike.com
 *   WWW.NIKE.COM              -> nike.com
 *   shop.example.co.uk        -> example.co.uk   (multi-part eTLD honored)
 *
 * Returns null for inputs with no registrable domain (IPs, localhost, garbage),
 * so the validator can reject them rather than queueing junk.
 */

import { getDomain, parse } from "tldts";

export interface SeedRow {
  domain: string;
  brand_name?: string | undefined;
  category?: string | undefined;
}

/**
 * Collapse a raw domain/URL string to its registrable domain, lowercased.
 * @returns the eTLD+1, or null if the input has no valid registrable domain.
 */
export function canonicalizeDomain(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  // tldts handles bare hosts and full URLs. Force a scheme-less host through a
  // URL-ish parse by letting tldts do the work directly — it tolerates both.
  const info = parse(trimmed, { allowPrivateDomains: false });

  // Reject IPs and anything without a usable hostname.
  if (info.isIp) return null;

  const domain = info.domain ?? getDomain(trimmed, { allowPrivateDomains: false });
  if (!domain) return null;

  return domain.toLowerCase();
}

/**
 * Parse newline / CSV seed text into raw rows (NOT yet canonicalized).
 *
 * Accepted shapes per line:
 *   nike.com
 *   nike.com,Nike
 *   nike.com,Nike,Apparel
 *   https://www.nike.com/uk, Nike , Apparel
 *
 * - Blank lines and lines starting with `#` are skipped.
 * - A header line (first cell literally `domain`, case-insensitive) is skipped.
 * - Extra columns beyond the first three are ignored.
 * - Surrounding double-quotes on a cell are stripped.
 */
export function parseSeedText(text: string): SeedRow[] {
  const rows: SeedRow[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const cells = trimmed.split(",").map((c) => stripQuotes(c.trim()));
    const domain = cells[0] ?? "";
    if (domain === "") continue;

    // Skip a header row.
    if (domain.toLowerCase() === "domain") continue;

    rows.push({
      domain,
      brand_name: cells[1] || undefined,
      category: cells[2] || undefined,
    });
  }

  return rows;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Derive a stable brand slug from a registrable domain.
 * `nike.com` -> `nike`, `example.co.uk` -> `example`. Used as the `brand.slug`
 * the mint API keys on. Falls back to the full domain (dots -> dashes) if the
 * label is empty for any reason.
 */
export function brandSlugFromDomain(domain: string): string {
  const label = domain.split(".")[0]?.trim().toLowerCase() ?? "";
  if (label !== "") return label;
  return domain.replace(/\./g, "-");
}
