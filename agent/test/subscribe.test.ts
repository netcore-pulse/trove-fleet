/**
 * A1 GATE — the subscribe loop against local HTML fixtures, driving REAL
 * headless chromium (Playwright). Deterministic: no network, no live archive.
 *
 * The external boundaries are stubbed exactly as A0 stubbed the archive:
 *   - the web (DOM)  → local fixture pages under fixtures/pages/ (file://)
 *   - mintAddress    → an injected stub MintFn (no HTTP)
 *
 * What the gate proves:
 *   - the loop finds the correct newsletter email field on the Klaviyo /
 *     Mailchimp / Omnisend / Privy / generic-footer / modal fixtures, fills it
 *     with the minted address + persona, submits, and resolves to `submitted`;
 *   - the login + search decoy pages resolve to `no_form_found` (the decoys are
 *     rejected, not chosen);
 *   - the CAPTCHA-walled fixture resolves to `needs_solver` (detected, not
 *     solved);
 *   - the no-form fixture resolves to `no_form_found`;
 *   - the cookie/consent overlay (and a popup) is dismissed first.
 *   - the full store-leased orchestration drives the A0 state machine.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { BrowserWorker } from "../src/browser/worker.ts";
import { subscribeOnPage, runSubscribe, type MintFn } from "../src/subscribe.ts";
import { TargetStore } from "../src/store.ts";
import { personaForDomain } from "../src/persona.ts";
import type { AddressResponse, BrandInput } from "../src/archive-client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES = join(HERE, "fixtures", "pages");

function fixtureUrl(name: string): string {
  return pathToFileURL(join(PAGES, name)).href;
}

/** A stub mint that records calls and returns a canned registered address. */
function makeMint(): { mint: MintFn; calls: BrandInput[] } {
  const calls: BrandInput[] = [];
  const mint: MintFn = async (brand: BrandInput): Promise<AddressResponse> => {
    calls.push(brand);
    return {
      id: 100 + calls.length,
      address: `${brand.slug}.nonce${calls.length}@in.trove.dev`,
      status: "pending_confirm",
      brand_id: 1,
      brand_slug: brand.slug,
      minted_at: "2026-06-23T10:00:00Z",
      confirm_deadline: "2026-06-30T10:00:00Z",
      confirmed_at: null,
    };
  };
  return { mint, calls };
}

// One chromium for the whole file (fast). Each case opens its own context.
let worker: BrowserWorker;
beforeAll(async () => {
  worker = new BrowserWorker({ headless: true, navigationTimeoutMs: 20_000 });
  await worker.launch();
}, 60_000);
afterAll(async () => {
  await worker.close();
});

/** Open a fixture, run the loop with a stub mint, return the outcome + mint calls. */
async function runFixture(file: string, domain = "brand.com") {
  const persona = personaForDomain(domain);
  const { page } = await worker.openPage(fixtureUrl(file), persona);
  const { mint, calls } = makeMint();
  try {
    const outcome = await subscribeOnPage(page, { mint, persona, domain });
    return { outcome, calls };
  } finally {
    await worker.closePage(page);
  }
}

describe("A1 gate — ESP + generic + modal fixtures resolve to submitted", () => {
  const cases: Array<{ file: string; esp: string; label: string }> = [
    { file: "klaviyo.html", esp: "klaviyo", label: "Klaviyo embed (behind a cookie banner)" },
    { file: "mailchimp.html", esp: "mailchimp", label: "Mailchimp embed (with login + honeypot decoys)" },
    { file: "omnisend.html", esp: "omnisend", label: "Omnisend embed (with a search decoy)" },
    { file: "privy.html", esp: "privy", label: "Privy modal (with a login decoy)" },
    { file: "generic-footer.html", esp: "generic", label: "generic DIY footer form (with a search decoy)" },
    { file: "modal-popup.html", esp: "generic", label: "popup modal (behind a cookie banner)" },
  ];

  for (const c of cases) {
    it(`${c.label} → submitted, ESP=${c.esp}, minted address filled`, async () => {
      const { outcome, calls } = await runFixture(c.file);
      expect(outcome.status).toBe("submitted");
      expect(outcome.esp).toBe(c.esp);
      // Minted exactly one address, keyed on the brand slug.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.slug).toBe("brand");
      expect(calls[0]!.primary_domain).toBe("brand.com");
      // The minted address (NOT persona PII) was used as the email.
      expect(outcome.address).toBe("brand.nonce1@in.trove.dev");
    }, 30_000);
  }
});

describe("A1 gate — decoys are rejected (no false positives)", () => {
  it("login-only page → no_form_found (never picks the login email)", async () => {
    const { outcome, calls } = await runFixture("login-decoy.html");
    expect(outcome.status).toBe("no_form_found");
    expect(calls).toHaveLength(0); // never minted — we found no real form
  }, 30_000);

  it("search-only page → no_form_found (never picks the search box)", async () => {
    const { outcome, calls } = await runFixture("search-decoy.html");
    expect(outcome.status).toBe("no_form_found");
    expect(calls).toHaveLength(0);
  }, 30_000);
});

describe("A1 gate — anti-bot wall + no form", () => {
  it("CAPTCHA-walled page → needs_solver (detected, NOT solved)", async () => {
    const { outcome, calls } = await runFixture("captcha-wall.html");
    expect(outcome.status).toBe("needs_solver");
    // We park BEFORE minting (the wall is detected up front).
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("no-form page → no_form_found", async () => {
    const { outcome } = await runFixture("no-form.html");
    expect(outcome.status).toBe("no_form_found");
  }, 30_000);
});

describe("A1 gate — the minted address is used, persona is synthetic (no PII in email)", () => {
  it("the email used is the minted address, not any persona field", async () => {
    const persona = personaForDomain("brand.com");
    const { outcome } = await runFixture("generic-footer.html");
    expect(outcome.address).toBe("brand.nonce1@in.trove.dev");
    // The minted address must not be derived from real-looking persona PII.
    expect(outcome.address).not.toContain(persona.firstName.toLowerCase());
    expect(outcome.address).not.toContain(persona.lastName.toLowerCase());
    expect(outcome.address).not.toContain(persona.postalCode);
  }, 30_000);

  it("the field carries the minted value at fill time (captured pre-submit)", async () => {
    // Drive the open page directly and read the value BEFORE the form consumes
    // itself on submit, by snapshotting on the 'submit' event.
    const persona = personaForDomain("brand.com");
    const { page } = await worker.openPage(fixtureUrl("generic-footer.html"), persona);
    try {
      await page.evaluate(() => {
        (window as unknown as { __filled?: string }).__filled = "";
        document.addEventListener(
          "submit",
          () => {
            const el = document.querySelector("input[type='email']") as HTMLInputElement | null;
            (window as unknown as { __filled?: string }).__filled = el ? el.value : "";
          },
          true,
        );
      });
      const { mint } = makeMint();
      await subscribeOnPage(page, { mint, persona, domain: "brand.com" });
      const filled = await page.evaluate(() => (window as unknown as { __filled?: string }).__filled);
      expect(filled).toBe("brand.nonce1@in.trove.dev");
    } finally {
      await worker.closePage(page);
    }
  }, 30_000);
});

describe("A1 gate — full store-leased orchestration drives the A0 state machine", () => {
  it("runSubscribe leases the target, subscribes, transitions queued → submitted", async () => {
    const store = new TargetStore(":memory:");
    try {
      store.ingest([{ domain: "brand.com", brand_name: "Brand", category: "Apparel" }]);
      const { mint, calls } = makeMint();

      const result = await runSubscribe({
        store,
        mint,
        workerId: "worker-test",
        domain: "brand.com",
        urlForDomain: () => fixtureUrl("klaviyo.html"),
        worker, // reuse the shared chromium
      });

      expect(result.domain).toBe("brand.com");
      expect(result.status).toBe("submitted");
      const row = store.get("brand.com");
      expect(row?.status).toBe("submitted");
      expect(row?.address).toBe("brand.nonce1@in.trove.dev");
      expect(row?.address_id).toBe(101);
      // Lease cleared on leaving `attempting`.
      expect(row?.lease_owner).toBeNull();
      expect(calls).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 30_000);

  it("runSubscribe parks a CAPTCHA-walled target as needs_solver", async () => {
    const store = new TargetStore(":memory:");
    try {
      store.ingest([{ domain: "walled.com" }]);
      const { mint } = makeMint();
      const result = await runSubscribe({
        store,
        mint,
        workerId: "worker-test",
        domain: "walled.com",
        urlForDomain: () => fixtureUrl("captcha-wall.html"),
        worker,
      });
      expect(result.status).toBe("needs_solver");
      expect(store.get("walled.com")?.status).toBe("needs_solver");
    } finally {
      store.close();
    }
  }, 30_000);

  it("runSubscribe marks a no-form target no_form_found", async () => {
    const store = new TargetStore(":memory:");
    try {
      store.ingest([{ domain: "empty.com" }]);
      const { mint } = makeMint();
      const result = await runSubscribe({
        store,
        mint,
        workerId: "worker-test",
        domain: "empty.com",
        urlForDomain: () => fixtureUrl("no-form.html"),
        worker,
      });
      expect(result.status).toBe("no_form_found");
      expect(store.get("empty.com")?.status).toBe("no_form_found");
    } finally {
      store.close();
    }
  }, 30_000);

  it("a CONFIRMED domain is never re-leased (no double-subscribe)", async () => {
    const store = new TargetStore(":memory:");
    try {
      store.ingest([{ domain: "done.com" }]);
      store.setStatus("done.com", "attempting");
      store.setStatus("done.com", "submitted");
      store.setStatus("done.com", "confirmed");
      const { mint, calls } = makeMint();

      const result = await runSubscribe({
        store,
        mint,
        workerId: "worker-test",
        domain: "done.com",
        urlForDomain: () => fixtureUrl("klaviyo.html"),
        worker,
      });
      // Not leasable → no attempt, no mint, status untouched.
      expect(result.domain).toBeNull();
      expect(calls).toHaveLength(0);
      expect(store.get("done.com")?.status).toBe("confirmed");
    } finally {
      store.close();
    }
  }, 30_000);
});
