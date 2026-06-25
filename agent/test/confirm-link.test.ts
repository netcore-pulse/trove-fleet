import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isConfirmLink, extractConfirmLinks } from "../src/confirm-link.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIRM = join(HERE, "fixtures", "confirm");
function eml(name: string): Uint8Array {
  return readFileSync(join(CONFIRM, name));
}

describe("isConfirmLink — whitelist (cardinal rule #1)", () => {
  it("accepts generic confirm/verify/activate intent", () => {
    expect(isConfirmLink("https://brand.com/newsletter/confirm/abc")).toBe(true);
    expect(isConfirmLink("https://brand.com/verify?token=xyz")).toBe(true);
    expect(isConfirmLink("https://brand.com/email-confirm/123")).toBe(true);
    expect(isConfirmLink("https://brand.com/account/activate/9")).toBe(true);
  });

  it("accepts known ESP confirm shapes", () => {
    expect(isConfirmLink("https://manage.kmail-lists.com/subscriptions/confirm?x=1")).toBe(true);
    expect(isConfirmLink("https://brand.us1.list-manage.com/subscribe/confirm?u=1&id=2")).toBe(true);
  });

  it("REFUSES unsubscribe / preferences even when confirm-ish words are near", () => {
    expect(isConfirmLink("https://brand.com/unsubscribe?token=xyz")).toBe(false);
    expect(isConfirmLink("https://brand.com/email/preferences/confirm")).toBe(false);
    expect(isConfirmLink("https://brand.com/optout?confirm=1")).toBe(false);
  });

  it("REFUSES arbitrary CTAs / product / home links", () => {
    expect(isConfirmLink("https://brand.com/")).toBe(false);
    expect(isConfirmLink("https://brand.com/products/cool-shoe")).toBe(false);
    expect(isConfirmLink("https://brand.com/sale")).toBe(false);
    expect(isConfirmLink("https://brand.com/cart/checkout")).toBe(false);
  });

  it("REFUSES non-http(s) schemes and malformed URLs", () => {
    expect(isConfirmLink("mailto:confirm@brand.com")).toBe(false);
    expect(isConfirmLink("javascript:alert(1)//confirm")).toBe(false);
    expect(isConfirmLink("not a url at all /confirm")).toBe(false);
    expect(isConfirmLink("")).toBe(false);
  });
});

describe("extractConfirmLinks — A2 whitelist over raw .eml (cardinal rule #1)", () => {
  it("never throws (A2 implements the seam; malformed input yields [])", () => {
    expect(extractConfirmLinks("")).toEqual([]);
    expect(extractConfirmLinks("garbage with no links")).toEqual([]);
    expect(extractConfirmLinks(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual([]);
  });

  it("extracts the Klaviyo confirm link (quoted-printable HTML), drops the unsubscribe", () => {
    const links = extractConfirmLinks(eml("klaviyo.eml"));
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links.some((l) => /kmail-lists\.com\/subscriptions\/confirm/.test(l))).toBe(true);
    expect(links.some((l) => /unsubscribe/.test(l))).toBe(false);
  });

  it("extracts the Mailchimp confirm link, drops the product CTA + unsubscribe", () => {
    const links = extractConfirmLinks(eml("mailchimp.eml"));
    expect(links.some((l) => /list-manage\.com\/subscribe\/confirm/.test(l))).toBe(true);
    expect(links.some((l) => /\/products\//.test(l))).toBe(false);
    expect(links.some((l) => /unsubscribe/.test(l))).toBe(false);
  });

  it("extracts the Braze confirm/optin link (base64 HTML), drops the unsubscribe", () => {
    const links = extractConfirmLinks(eml("braze.eml"));
    expect(links.some((l) => /links\.braze\.com\/confirm\/optin/.test(l))).toBe(true);
    expect(links.some((l) => /unsubscribe/.test(l))).toBe(false);
  });

  it("extracts the Iterable confirm/optin link, drops the blog CTA + optout", () => {
    const links = extractConfirmLinks(eml("iterable.eml"));
    expect(links.some((l) => /links\.iterable\.com\/confirm\/optin/.test(l))).toBe(true);
    expect(links.some((l) => /\/blog\//.test(l))).toBe(false);
    expect(links.some((l) => /optout/.test(l))).toBe(false);
  });

  it("extracts the SendGrid wf/confirm link, drops the wf/unsubscribe", () => {
    const links = extractConfirmLinks(eml("sendgrid.eml"));
    expect(links.some((l) => /ct\.sendgrid\.net\/wf\/confirm/.test(l))).toBe(true);
    expect(links.some((l) => /\/wf\/unsubscribe/.test(l))).toBe(false);
  });

  it("HOSTILE fixture: returns ONLY the confirm link — no CTA, no sale, no unsubscribe, no mailto", () => {
    const links = extractConfirmLinks(eml("hostile-multi-link.eml"));
    // Exactly the single genuine confirm link.
    expect(links).toEqual([
      "https://manage.kmail-lists.com/subscriptions/confirm?a=HOSTILE9&c=1&e=brand.nonce6%40in.trove.dev",
    ]);
    // And prove every decoy is absent — including the unsubscribe whose anchor
    // text deceptively says "confirm", and the /sale CTA with utm=confirm-email.
    for (const l of links) {
      expect(l).not.toMatch(/\/products\//);
      expect(l).not.toMatch(/\/sale/);
      expect(l).not.toMatch(/\/cart\//);
      expect(l).not.toMatch(/unsubscribe/);
      expect(l).not.toMatch(/preferences/);
      expect(l).not.toMatch(/^mailto:/);
      expect(l).not.toBe("https://brand.com/");
    }
  });

  it("no-confirm-link fixture: returns [] (a pure marketing email)", () => {
    expect(extractConfirmLinks(eml("no-confirm-link.eml"))).toEqual([]);
  });

  it("intent text can promote an ambiguous URL, but NEVER overrides the refuse-list", () => {
    // Ambiguous URL shape + 'confirm' anchor text → accepted.
    const ok = extractConfirmLinks(
      '<a href="https://brand.com/c/9a8b">Confirm your subscription</a>',
    );
    expect(ok).toEqual(["https://brand.com/c/9a8b"]);

    // Same intent text, but the URL is an unsubscribe → refused on shape.
    const refused = extractConfirmLinks(
      '<a href="https://brand.com/unsubscribe/9a8b">Confirm your subscription</a>',
    );
    expect(refused).toEqual([]);
  });
});
