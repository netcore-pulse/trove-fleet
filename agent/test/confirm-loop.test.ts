/**
 * A2 GATE — the confirm loop end-to-end, deterministic + offline.
 *
 * Every external boundary is stubbed exactly as A0/A1 stubbed theirs:
 *   - the queue + archive writes → a fake ArchiveClient (records every call)
 *   - the raw .eml               → fixture bytes returned from `fetchBlob`
 *   - the click                  → an injected stub `click` that RECORDS every
 *                                  URL it is asked to click (so the test can
 *                                  prove ONLY the confirm link was clicked).
 *
 * What the gate proves:
 *   - a double-opt-in confirmation → extract + click ONLY the confirm link →
 *     confirmAddress(address.id) is called;
 *   - the HOSTILE fixture (confirm + unsubscribe + product CTA) → the clicker is
 *     handed EXACTLY the confirm link and nothing else;
 *   - a no-confirm-link email → failConfirmation (graceful), never a mis-click;
 *   - a transient fetchBlob/click error → releaseConfirmation (retry), no confirm;
 *   - one item's failure never stalls the rest of the batch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  runConfirmLoop,
  processConfirmation,
  httpGetClick,
  type ClickFn,
  type ClickResult,
} from "../src/confirm-loop.ts";
import type { ConfirmationResponse } from "../src/archive-client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIRM = join(HERE, "fixtures", "confirm");
function emlBytes(name: string): Uint8Array {
  return readFileSync(join(CONFIRM, name));
}

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface ArchiveCall {
  op: string;
  args: unknown[];
}

/**
 * A fake archive client recording every call. `blobs` maps an eml key → fixture
 * file name. `blobError` / `confirmError` let a test inject transient failures.
 */
function makeArchive(opts: {
  queue?: ConfirmationResponse[];
  blobs?: Record<string, string>; // key → fixture file
  blobError?: Set<string>; // keys whose fetchBlob throws
  confirmError?: Set<number>; // address ids whose confirm throws
}) {
  const calls: ArchiveCall[] = [];
  const record = (op: string, ...args: unknown[]) => calls.push({ op, args });

  const archive = {
    async pollConfirmations(workerId: string, limit?: number) {
      record("pollConfirmations", workerId, limit);
      return opts.queue ?? [];
    },
    async fetchBlob(key: string): Promise<Uint8Array> {
      record("fetchBlob", key);
      if (opts.blobError?.has(key)) throw new Error(`blob ${key} unavailable`);
      const fixture = opts.blobs?.[key];
      if (!fixture) throw new Error(`no fixture mapped for key ${key}`);
      return emlBytes(fixture);
    },
    async confirmAddress(addressId: number) {
      record("confirmAddress", addressId);
      if (opts.confirmError?.has(addressId)) throw new Error("confirm 500");
      return { id: addressId, status: "active" } as never;
    },
    async releaseConfirmation(id: number) {
      record("releaseConfirmation", id);
      return { id, status: "pending" } as never;
    },
    async failConfirmation(id: number, note?: string) {
      record("failConfirmation", id, note);
      return { id, status: "failed" } as never;
    },
  };
  return { archive, calls };
}

/** A stub click that records every URL and returns a canned result. */
function makeClick(result: ClickResult = { ok: true, status: 200 }): {
  click: ClickFn;
  clicked: string[];
} {
  const clicked: string[] = [];
  const click: ClickFn = async (url: string) => {
    clicked.push(url);
    return result;
  };
  return { click, clicked };
}

function confirmationItem(over: Partial<ConfirmationResponse> = {}): ConfirmationResponse {
  return {
    id: 11,
    status: "claimed",
    address: { id: 7, address: "brand.nonce1@in.trove.dev", brand_slug: "brand", status: "pending_confirm" },
    raw_eml_key: "raw_eml/c1.eml",
    claimed_by: "agent-1",
    claimed_at: "2026-06-23T10:01:00Z",
    created_at: "2026-06-23T10:00:30Z",
    raw_eml_url: "/internal/blobs/raw_eml/c1.eml",
    ...over,
  };
}

// ── The gate ──────────────────────────────────────────────────────────────────

describe("A2 gate — confirm loop clicks ONLY the confirm link and confirms the address", () => {
  const espCases: Array<{ fixture: string; match: RegExp; label: string }> = [
    { fixture: "klaviyo.eml", match: /kmail-lists\.com\/subscriptions\/confirm/, label: "Klaviyo" },
    { fixture: "mailchimp.eml", match: /list-manage\.com\/subscribe\/confirm/, label: "Mailchimp" },
    { fixture: "braze.eml", match: /links\.braze\.com\/confirm\/optin/, label: "Braze" },
    { fixture: "iterable.eml", match: /links\.iterable\.com\/confirm\/optin/, label: "Iterable" },
    { fixture: "sendgrid.eml", match: /ct\.sendgrid\.net\/wf\/confirm/, label: "SendGrid" },
  ];

  for (const c of espCases) {
    it(`${c.label}: extracts + clicks the confirm link → confirmAddress(7)`, async () => {
      const item = confirmationItem();
      const { archive, calls } = makeArchive({
        queue: [item],
        blobs: { "raw_eml/c1.eml": c.fixture },
      });
      const { click, clicked } = makeClick();

      const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

      expect(result.polled).toBe(1);
      expect(result.confirmed).toBe(1);
      // Exactly one URL clicked, and it is the confirm link.
      expect(clicked).toHaveLength(1);
      expect(clicked[0]).toMatch(c.match);
      // The address was confirmed.
      expect(calls.some((k) => k.op === "confirmAddress" && k.args[0] === 7)).toBe(true);
      // No unsubscribe / product / CTA was ever clicked.
      for (const u of clicked) {
        expect(u).not.toMatch(/unsubscribe|optout|\/products\/|\/sale|\/blog\//);
      }
    });
  }

  it("HOSTILE multi-link email: the clicker is handed EXACTLY the confirm link", async () => {
    const item = confirmationItem({ id: 99, address: { id: 6, address: "brand.nonce6@in.trove.dev", brand_slug: "brand", status: "pending_confirm" } });
    const { archive, calls } = makeArchive({
      queue: [item],
      blobs: { "raw_eml/c1.eml": "hostile-multi-link.eml" },
    });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.confirmed).toBe(1);
    // THE proof: the clicker saw the confirm link and NOTHING else.
    expect(clicked).toEqual([
      "https://manage.kmail-lists.com/subscriptions/confirm?a=HOSTILE9&c=1&e=brand.nonce6%40in.trove.dev",
    ]);
    // Belt-and-braces: none of the decoys reached the clicker.
    for (const u of clicked) {
      expect(u).not.toMatch(/\/sale/);
      expect(u).not.toMatch(/\/products\//);
      expect(u).not.toMatch(/\/cart\//);
      expect(u).not.toMatch(/unsubscribe/);
      expect(u).not.toMatch(/preferences/);
      expect(u).not.toMatch(/^mailto:/);
      expect(u).not.toBe("https://brand.com/");
    }
    expect(calls.some((k) => k.op === "confirmAddress" && k.args[0] === 6)).toBe(true);
  });

  it("no-confirm-link email → failConfirmation (graceful), NOTHING clicked, NOT confirmed", async () => {
    const item = confirmationItem();
    const { archive, calls } = makeArchive({
      queue: [item],
      blobs: { "raw_eml/c1.eml": "no-confirm-link.eml" },
    });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.failed).toBe(1);
    expect(clicked).toHaveLength(0); // never clicked anything
    expect(calls.some((k) => k.op === "failConfirmation" && k.args[0] === 11)).toBe(true);
    expect(calls.some((k) => k.op === "confirmAddress")).toBe(false);
  });

  it("transient fetchBlob error → releaseConfirmation (retry), no click, no confirm", async () => {
    const item = confirmationItem();
    const { archive, calls } = makeArchive({
      queue: [item],
      blobs: {},
      blobError: new Set(["raw_eml/c1.eml"]),
    });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.released).toBe(1);
    expect(clicked).toHaveLength(0);
    expect(calls.some((k) => k.op === "releaseConfirmation" && k.args[0] === 11)).toBe(true);
    expect(calls.some((k) => k.op === "confirmAddress")).toBe(false);
    expect(calls.some((k) => k.op === "failConfirmation")).toBe(false);
  });

  it("click fails transiently → releaseConfirmation (retry), NOT failed", async () => {
    const item = confirmationItem();
    const { archive, calls } = makeArchive({
      queue: [item],
      blobs: { "raw_eml/c1.eml": "klaviyo.eml" },
    });
    const { click, clicked } = makeClick({ ok: false, status: 503 });

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.released).toBe(1);
    // We DID try to click the confirm link (once), but it failed → release.
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/kmail-lists\.com\/subscriptions\/confirm/);
    expect(calls.some((k) => k.op === "releaseConfirmation" && k.args[0] === 11)).toBe(true);
    expect(calls.some((k) => k.op === "confirmAddress")).toBe(false);
  });

  it("click succeeds but confirmAddress fails → releaseConfirmation (retry, idempotent click)", async () => {
    const item = confirmationItem();
    const { archive, calls } = makeArchive({
      queue: [item],
      blobs: { "raw_eml/c1.eml": "klaviyo.eml" },
      confirmError: new Set([7]),
    });
    const { click } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.released).toBe(1);
    expect(calls.some((k) => k.op === "confirmAddress" && k.args[0] === 7)).toBe(true);
    expect(calls.some((k) => k.op === "releaseConfirmation" && k.args[0] === 11)).toBe(true);
  });

  it("missing raw_eml_key → failConfirmation, no click", async () => {
    const item = confirmationItem({ raw_eml_key: null, raw_eml_url: null });
    const { archive, calls } = makeArchive({ queue: [item] });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });
    expect(result.failed).toBe(1);
    expect(clicked).toHaveLength(0);
    expect(calls.some((k) => k.op === "failConfirmation" && k.args[0] === 11)).toBe(true);
  });

  it("falls back to raw_eml_url when raw_eml_key is null", async () => {
    const item = confirmationItem({
      raw_eml_key: null,
      raw_eml_url: "/internal/blobs/raw_eml/c1.eml",
    });
    const { archive } = makeArchive({
      queue: [item],
      blobs: { "/internal/blobs/raw_eml/c1.eml": "klaviyo.eml" },
    });
    const { click, clicked } = makeClick();
    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });
    expect(result.confirmed).toBe(1);
    expect(clicked).toHaveLength(1);
  });

  it("drains a mixed batch — one item's failure never stalls the rest", async () => {
    const good = confirmationItem({ id: 1, raw_eml_key: "raw_eml/good.eml", address: { id: 10, address: "a@in.trove.dev", brand_slug: "a", status: "pending_confirm" } });
    const bad = confirmationItem({ id: 2, raw_eml_key: "raw_eml/none.eml", address: { id: 20, address: "b@in.trove.dev", brand_slug: "b", status: "pending_confirm" } });
    const transient = confirmationItem({ id: 3, raw_eml_key: "raw_eml/boom.eml", address: { id: 30, address: "c@in.trove.dev", brand_slug: "c", status: "pending_confirm" } });

    const { archive, calls } = makeArchive({
      queue: [good, bad, transient],
      blobs: { "raw_eml/good.eml": "mailchimp.eml", "raw_eml/none.eml": "no-confirm-link.eml" },
      blobError: new Set(["raw_eml/boom.eml"]),
    });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.polled).toBe(3);
    expect(result.confirmed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.released).toBe(1);
    // Only the good one was clicked, once, with its confirm link.
    expect(clicked).toHaveLength(1);
    expect(clicked[0]).toMatch(/list-manage\.com\/subscribe\/confirm/);
    expect(calls.some((k) => k.op === "confirmAddress" && k.args[0] === 10)).toBe(true);
    expect(calls.some((k) => k.op === "failConfirmation" && k.args[0] === 2)).toBe(true);
    expect(calls.some((k) => k.op === "releaseConfirmation" && k.args[0] === 3)).toBe(true);
  });

  it("empty queue → no-op pass", async () => {
    const { archive } = makeArchive({ queue: [] });
    const { click, clicked } = makeClick();
    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });
    expect(result.polled).toBe(0);
    expect(clicked).toHaveLength(0);
  });
});

describe("processConfirmation — single-item unit (the gate's drive unit)", () => {
  it("multiple confirm links: stops clicking at the first success", async () => {
    // sendgrid.eml has the confirm link in BOTH the text and HTML parts → the
    // extractor de-dupes to one; assert we click exactly once.
    const item = confirmationItem();
    const { archive } = makeArchive({ queue: [], blobs: { "raw_eml/c1.eml": "sendgrid.eml" } });
    const { click, clicked } = makeClick();
    const res = await processConfirmation(item, { archive, click });
    expect(res.disposition).toBe("confirmed");
    expect(clicked).toHaveLength(1);
  });
});

describe("Cloudflare contract — confirm_url pre-extracted at ingest (no blob fetch)", () => {
  // A CF-shaped queue item: flat address_id + a confirm_url the archive already
  // extracted. The loop must click it directly, never call fetchBlob, and confirm
  // the flat address_id.
  const cfItem = (over: Partial<ConfirmationResponse> = {}): ConfirmationResponse => ({
    id: 50,
    address_id: 42,
    confirm_url: "https://manage.kmail-lists.com/subscriptions/confirm?a=ABC&e=x%40actionads.in",
    ...over,
  });

  it("valid confirm_url → clicks exactly it → confirmAddress(address_id), no fetchBlob", async () => {
    const { archive, calls } = makeArchive({ queue: [cfItem()] });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.polled).toBe(1);
    expect(result.confirmed).toBe(1);
    expect(clicked).toEqual([
      "https://manage.kmail-lists.com/subscriptions/confirm?a=ABC&e=x%40actionads.in",
    ]);
    expect(calls.some((k) => k.op === "confirmAddress" && k.args[0] === 42)).toBe(true);
    // The CF path must NOT touch the blob proxy (it doesn't exist on CF).
    expect(calls.some((k) => k.op === "fetchBlob")).toBe(false);
  });

  it("confirm_url that fails the whitelist → failed, never clicked", async () => {
    const { archive, calls } = makeArchive({
      queue: [cfItem({ confirm_url: "https://brand.com/unsubscribe?u=9" })],
    });
    const { click, clicked } = makeClick();

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.confirmed).toBe(0);
    expect(result.failed).toBe(1);
    expect(clicked).toHaveLength(0);
    expect(calls.some((k) => k.op === "confirmAddress")).toBe(false);
  });

  it("click fails → released, and NO archive write (CF has no release/fail endpoint)", async () => {
    const { archive, calls } = makeArchive({ queue: [cfItem()] });
    const { click } = makeClick({ ok: false, status: 502 });

    const result = await runConfirmLoop({ workerId: "agent-1", archive, click });

    expect(result.released).toBe(1);
    expect(calls.some((k) => k.op === "releaseConfirmation")).toBe(false);
    expect(calls.some((k) => k.op === "failConfirmation")).toBe(false);
  });
});

describe("httpGetClick — default clicker (stubbed fetch, no network)", () => {
  it("returns ok on a 2xx and only ever GETs the URL it is given", async () => {
    const seen: Array<{ url: string; method: string }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const click = httpGetClick(fakeFetch);
    const r = await click("https://manage.kmail-lists.com/subscriptions/confirm?a=1");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url).toBe("https://manage.kmail-lists.com/subscriptions/confirm?a=1");
  });

  it("returns ok=false (not a throw) when the endpoint errors", async () => {
    const fakeFetch = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const r = await httpGetClick(fakeFetch)("https://brand.com/confirm/1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNRESET/);
  });
});
