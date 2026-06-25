import { describe, it, expect } from "vitest";
import {
  rankCandidates,
  detectEsp,
  type FieldCandidate,
} from "../src/form-finder.ts";

/**
 * Build a FieldCandidate with sane defaults so each test states only the fields
 * it cares about. These are the PURE-logic tests for the disambiguation core:
 * no browser, no Playwright — just the ranker over hand-built snapshots.
 */
function field(over: Partial<FieldCandidate> = {}): FieldCandidate {
  return {
    id: over.id ?? "fc-0",
    type: "email",
    name: "",
    elementId: "",
    placeholder: "",
    ariaLabel: "",
    autocomplete: "",
    labelText: "",
    visible: true,
    regionTag: "form",
    regionContext: "",
    hasPasswordSibling: false,
    hasOtherEmailSibling: false,
    looksLikeSearch: false,
    inFooter: false,
    inModal: false,
    contextBlob: "",
    isHoneypot: false,
    ...over,
  };
}

describe("detectEsp — recognizes the four common embeds", () => {
  it("Klaviyo", () => {
    expect(detectEsp("klaviyo-form-Vn3 kl_field needsclick")).toBe("klaviyo");
    expect(detectEsp("action=https://manage.kmail-lists.com/x")).toBe("klaviyo");
  });
  it("Mailchimp", () => {
    expect(detectEsp("mc-field-group id=mce-email")).toBe("mailchimp");
    expect(detectEsp("brand.us1.list-manage.com/subscribe/post")).toBe("mailchimp");
    expect(detectEsp("mc4wp-form")).toBe("mailchimp");
  });
  it("Omnisend", () => {
    expect(detectEsp("omnisend-form omnisend-snippet")).toBe("omnisend");
    expect(detectEsp("data-omnisend-form=footer")).toBe("omnisend");
  });
  it("Privy", () => {
    expect(detectEsp("privy-widget-container data-privy-campaign=welcome")).toBe("privy");
  });
  it("generic when no signature present", () => {
    expect(detectEsp("newsletter-form footer subscribe")).toBe("generic");
  });
});

describe("rankCandidates — picks the newsletter email field", () => {
  it("chooses a footer newsletter email over a header search box", () => {
    const search = field({
      id: "search",
      type: "search",
      name: "q",
      placeholder: "search products",
      looksLikeSearch: true,
    });
    const newsletter = field({
      id: "nl",
      name: "email",
      placeholder: "email",
      autocomplete: "email",
      inFooter: true,
      regionContext: "newsletter-form",
      contextBlob: "subscribe newsletter get 10% off",
    });
    const pick = rankCandidates([search, newsletter]);
    expect(pick?.candidate.id).toBe("nl");
    expect(pick?.esp).toBe("generic");
  });

  it("recognizes a Klaviyo embed and scores it as subscribe intent", () => {
    const c = field({
      id: "kl",
      name: "email",
      autocomplete: "email",
      inFooter: true,
      regionContext: "klaviyo-form klaviyo-form-vn3",
      contextBlob: "klaviyo-form kl_field subscribe get 10% off your first order",
    });
    const pick = rankCandidates([c]);
    expect(pick?.candidate.id).toBe("kl");
    expect(pick?.esp).toBe("klaviyo");
  });

  it("recognizes a Mailchimp embed", () => {
    const c = field({
      id: "mc",
      name: "email",
      elementId: "mce-email",
      contextBlob: "mc-field-group list-manage.com/subscribe join our newsletter",
    });
    const pick = rankCandidates([c]);
    expect(pick?.esp).toBe("mailchimp");
  });

  it("recognizes an Omnisend embed", () => {
    const c = field({
      id: "om",
      name: "email",
      contextBlob: "omnisend-form omnisend-snippet subscribe and save newsletter",
    });
    expect(rankCandidates([c])?.esp).toBe("omnisend");
  });

  it("recognizes a Privy modal embed", () => {
    const c = field({
      id: "pv",
      name: "email",
      inModal: true,
      contextBlob: "privy-widget-container join our list be the first to know",
    });
    const pick = rankCandidates([c]);
    expect(pick?.esp).toBe("privy");
    expect(pick?.candidate.inModal).toBe(true);
  });
});

describe("rankCandidates — rejects the decoys (the hard part)", () => {
  it("REJECTS a login email (has a password sibling) → null", () => {
    const login = field({
      id: "login",
      name: "email",
      autocomplete: "username",
      hasPasswordSibling: true,
      contextBlob: "sign in to your account password",
    });
    expect(rankCandidates([login])).toBeNull();
  });

  it("REJECTS a search box (looksLikeSearch) → null", () => {
    const search = field({
      id: "search",
      type: "text",
      name: "search_query",
      placeholder: "search for products",
      ariaLabel: "search the store",
      looksLikeSearch: true,
    });
    expect(rankCandidates([search])).toBeNull();
  });

  it("REJECTS a login email even without a password sibling when only login words present", () => {
    // 2-step login: email step has no password field yet, but the copy is login.
    const login = field({
      id: "login2",
      name: "email",
      contextBlob: "sign in log in to your account",
    });
    expect(rankCandidates([login])).toBeNull();
  });

  it("REJECTS a honeypot field even if it looks like an email", () => {
    const trap = field({
      id: "hp",
      name: "email",
      isHoneypot: true,
      contextBlob: "subscribe newsletter",
    });
    expect(rankCandidates([trap])).toBeNull();
  });

  it("REJECTS an invisible field", () => {
    const hidden = field({
      id: "hidden",
      name: "email",
      visible: false,
      inFooter: true,
      contextBlob: "subscribe newsletter",
    });
    expect(rankCandidates([hidden])).toBeNull();
  });

  it("REJECTS a bare email input with zero subscribe/ESP/placement signal (too ambiguous)", () => {
    const bare = field({ id: "bare", type: "email", name: "email" });
    expect(rankCandidates([bare])).toBeNull();
  });

  it("from a page with login + search + newsletter, picks ONLY the newsletter", () => {
    const login = field({
      id: "login",
      name: "email",
      hasPasswordSibling: true,
      contextBlob: "log in password account",
    });
    const search = field({
      id: "search",
      type: "search",
      name: "q",
      looksLikeSearch: true,
      contextBlob: "search products",
    });
    const honeypot = field({ id: "hp", name: "email", isHoneypot: true });
    const newsletter = field({
      id: "nl",
      name: "email",
      autocomplete: "email",
      inFooter: true,
      regionContext: "newsletter signup",
      contextBlob: "subscribe to our newsletter for updates",
    });
    const pick = rankCandidates([login, search, honeypot, newsletter]);
    expect(pick?.candidate.id).toBe("nl");
  });
});

describe("rankCandidates — sibling collection", () => {
  it("collects same-region non-email fields (name/zip) as siblings, skips honeypots", () => {
    const region = "newsletter-signup";
    const email = field({
      id: "email",
      name: "email",
      autocomplete: "email",
      regionContext: region,
      inFooter: true,
      contextBlob: "subscribe newsletter",
    });
    const fname = field({ id: "fname", type: "text", name: "first_name", regionContext: region });
    const zip = field({ id: "zip", type: "text", name: "zip", regionContext: region });
    const trap = field({ id: "trap", type: "text", name: "website", regionContext: region, isHoneypot: true });
    const elsewhere = field({ id: "other", type: "text", name: "first_name", regionContext: "different-region" });

    const pick = rankCandidates([email, fname, zip, trap, elsewhere]);
    expect(pick?.candidate.id).toBe("email");
    const sibIds = (pick?.siblings ?? []).map((s) => s.id).sort();
    expect(sibIds).toEqual(["fname", "zip"]); // not the honeypot, not the other-region field
  });
});

describe("rankCandidates — tie-breaks deterministically", () => {
  it("prefers a footer field over a modal field on an equal base score", () => {
    const modal = field({
      id: "modal",
      name: "email",
      inModal: true,
      contextBlob: "subscribe newsletter",
    });
    const footer = field({
      id: "footer",
      name: "email",
      inFooter: true,
      contextBlob: "subscribe newsletter",
    });
    // footer(+25) beats modal(+20) on placement, so footer wins outright; assert it.
    const pick = rankCandidates([modal, footer]);
    expect(pick?.candidate.id).toBe("footer");
  });
});
