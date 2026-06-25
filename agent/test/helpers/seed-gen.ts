/**
 * Synthetic seed-list generator for tests + the gate.
 *
 * Produces N *distinct* registrable brands, then deliberately injects dup
 * variants (`www.X.com`, `X.com/uk`, `HTTPS://X.com`, subdomains) so the gate
 * can prove registrable canonicalization collapses them to one row.
 */

import { brandSlugFromDomain } from "../../src/canonical.ts";
import type { SeedRow } from "../../src/canonical.ts";

const TLDS = ["com", "co", "io", "shop", "store"] as const;
const CATEGORIES = ["Apparel", "Beauty", "Home", "Food", "Electronics", "Fitness"] as const;

/** Generate `n` distinct base registrable domains like `brand0001.com`. */
export function distinctDomains(n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const tld = TLDS[i % TLDS.length];
    out.push(`brand${String(i).padStart(5, "0")}.${tld}`);
  }
  return out;
}

export interface SyntheticSeed {
  /** Rows to feed the ingester (includes dup variants + a couple of junk rows). */
  rows: SeedRow[];
  /** The count of distinct registrable domains the rows should collapse to. */
  expectedDistinct: number;
  /** The count of rows that are invalid (no registrable domain). */
  expectedInvalid: number;
}

/**
 * Build a seed with `distinct` unique brands plus injected duplicate variants.
 *
 * For a slice of the brands we add www / path / scheme / subdomain variants —
 * all of which MUST canonicalize to the same registrable domain. We also add a
 * few junk rows (IP, localhost, empty) to exercise the invalid path.
 */
export function syntheticSeed(distinct: number): SyntheticSeed {
  const bases = distinctDomains(distinct);
  const rows: SeedRow[] = [];

  bases.forEach((domain, i) => {
    const slug = brandSlugFromDomain(domain);
    const brand_name = `Brand ${slug}`;
    const category = CATEGORIES[i % CATEGORIES.length];

    // Canonical row.
    rows.push({ domain, brand_name, category });

    // For every 3rd brand, inject duplicate variants that must collapse.
    if (i % 3 === 0) {
      rows.push({ domain: `www.${domain}`, brand_name, category });
      rows.push({ domain: `https://www.${domain}/uk/`, brand_name, category });
      rows.push({ domain: `HTTP://${domain.toUpperCase()}/en?ref=x`, brand_name, category });
      rows.push({ domain: `shop.${domain}`, brand_name, category });
    }
  });

  // Junk rows that have no registrable domain → must be counted invalid.
  const junk: SeedRow[] = [
    { domain: "" },
    { domain: "   " },
    { domain: "127.0.0.1" },
    { domain: "localhost" },
    { domain: "http://192.168.0.1/path" },
  ];
  rows.push(...junk);

  return {
    rows,
    expectedDistinct: distinct,
    expectedInvalid: junk.length,
  };
}

/** Serialize synthetic rows to seed-file text (CSV) for end-to-end CLI/parse tests. */
export function toSeedCsv(rows: SeedRow[]): string {
  const lines = ["domain,brand_name,category"];
  for (const r of rows) {
    lines.push([r.domain, r.brand_name ?? "", r.category ?? ""].join(","));
  }
  return lines.join("\n");
}
