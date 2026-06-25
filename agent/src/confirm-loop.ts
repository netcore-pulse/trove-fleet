/**
 * The confirm loop (A2) — the keystone closed loop that makes Trove autonomous.
 *
 * Per the handoff "The confirm loop":
 *
 *   1. Brand's ESP sends a double-opt-in confirmation to the minted address.
 *   2. The archive classifier routes it to the CONFIRMATIONS QUEUE (NOT archived
 *      as a campaign).
 *   3. The agent polls GET /internal/confirmations?status=pending  (claims a batch).
 *   4. For each: extract the confirmation link(s) from the raw .eml.
 *   5. CLICK IT — and ONLY it.
 *   6. On success → POST /internal/addresses/{id}/confirm → address flips active.
 *   7. From now on, that brand's campaigns flow straight into the archive.
 *
 * Cardinal rule (the single most important in this service): click ONLY the
 * confirmation link. The whitelist lives in {@link extractConfirmLinks}; this
 * loop clicks EXACTLY the links it returns, nothing else. If extraction returns
 * no links, we FAIL the confirmation (archive-side it times out to
 * needs_attention) — we never click a fallback / "best guess" link.
 *
 * Disposition of each queue item:
 *   - confirm link(s) found + at least one click succeeds → confirmAddress(addr.id)
 *   - no confirm link found                               → failConfirmation(id, note)
 *   - transient error (fetchBlob/click/network)           → releaseConfirmation(id)
 *
 * One item's failure never stalls the rest: each is wrapped so the loop drains
 * the whole batch.
 *
 * Testability: every external boundary is injected — `archive` (the Archive
 * client, itself stubbable at fetch), and `click` (the link clicker). The gate
 * stubs the archive + click and drives fixture .eml bytes through
 * `fetchBlob`, proving ONLY the confirm link is ever clicked.
 */

import type { Page } from "playwright";
import type { ArchiveClient, ConfirmationResponse } from "./archive-client.ts";
import { extractConfirmLinks, isConfirmLink } from "./confirm-link.ts";
import type { BrowserWorker } from "./browser/worker.ts";
import { safeFetchTarget } from "./net-guard.ts";

/**
 * The click boundary. Given a (whitelisted) confirmation URL, "click" it.
 *
 * Most double-opt-in confirmations resolve on a plain GET; some require a real
 * browser. Two implementations satisfy this same interface:
 *   - {@link httpGetClick}        — a plain HTTPS GET (default, no browser).
 *   - {@link playwrightClick}     — drives a real chromium page (for links that
 *                                   need JS / cookies to register the confirm).
 *
 * Returns ok=true on a 2xx/3xx (the confirm registered). The clicker NEVER
 * decides *which* URL to click — it only ever receives links the whitelist
 * already approved.
 */
export type ClickFn = (url: string) => Promise<ClickResult>;

export interface ClickResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Disposition of a single confirmation queue item. */
export type ConfirmDisposition = "confirmed" | "failed" | "released" | "error";

export interface ConfirmItemResult {
  confirmationId: number;
  addressId: number;
  disposition: ConfirmDisposition;
  /** The confirm links the whitelist extracted (the ONLY URLs ever clicked). */
  clickedLinks: string[];
  reason: string;
}

export interface RunConfirmLoopResult {
  /** How many queue items were polled this pass. */
  polled: number;
  confirmed: number;
  failed: number;
  released: number;
  errored: number;
  items: ConfirmItemResult[];
}

export interface RunConfirmLoopOptions {
  /** Worker id used to claim the confirmations lease. */
  workerId: string;
  /** Archive client (the only writer: confirm / release / fail). */
  archive: Pick<
    ArchiveClient,
    "pollConfirmations" | "confirmAddress" | "releaseConfirmation" | "failConfirmation" | "fetchBlob"
  >;
  /** The injected clicker (default {@link httpGetClick}). */
  click?: ClickFn;
  /** Max items to claim this pass. */
  limit?: number;
}

// ── Clickers ────────────────────────────────────────────────────────────────

/**
 * Default clicker: a plain HTTPS GET, no browser. Follows redirects (the ESP's
 * tracking wrapper → the real confirm endpoint). A 2xx OR 3xx counts as the
 * confirm having registered. Times out so a hung endpoint can't stall the loop.
 *
 * NOTE: this is a NAVIGATION, not a form post — it only ever receives a URL the
 * confirm whitelist already approved.
 */
export function httpGetClick(
  fetchImpl: typeof fetch = (...a) => globalThis.fetch(...a),
  timeoutMs = 15_000,
  maxRedirects = 5,
): ClickFn {
  return async (url: string): Promise<ClickResult> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // Follow redirects MANUALLY (forward-pass H2/L22): the ESP wrapper → real
      // confirm endpoint can 30x-bounce, and an attacker confirm link could bounce
      // to an internal host. Re-validate EVERY hop through the SSRF guard before
      // fetching it; never auto-follow into an unvetted host.
      let current = url;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const safe = await safeFetchTarget(current);
        if (!safe) return { ok: false, error: `refused unsafe confirm target: ${current}` };

        const res = await fetchImpl(safe.toString(), {
          method: "GET",
          redirect: "manual",
          signal: ctrl.signal,
          headers: {
            // A plausible browser-ish UA; many ESP confirm endpoints 403 a bare client.
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,*/*",
          },
        });

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return { ok: true, status: res.status }; // 3xx w/o Location: treat as registered
          current = new URL(loc, safe).toString();
          continue;
        }
        return { ok: res.ok, status: res.status };
      }
      return { ok: false, error: "too many redirects" };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(t);
    }
  };
}

/**
 * Playwright-backed clicker for confirm links that need a real browser (JS /
 * cookies must run for the click to register). Same injectable interface as
 * {@link httpGetClick}: it receives only whitelisted URLs and navigates to each.
 *
 * Reuses a {@link BrowserWorker} (so the caller controls lifecycle). We navigate
 * with a synthetic persona context — the confirm endpoint doesn't care, and it
 * keeps fingerprint hygiene consistent with the subscribe loop.
 */
export function playwrightClick(
  worker: BrowserWorker,
  opts: { navigationTimeoutMs?: number } = {},
): ClickFn {
  const navTimeout = opts.navigationTimeoutMs ?? 30_000;
  return async (url: string): Promise<ClickResult> => {
    // Pre-validate the initial host (forward-pass H2). The route guard below then
    // re-checks every request the page makes — including redirect hops the browser
    // would otherwise follow internally — and aborts any that resolve to a private/
    // internal address.
    if (!(await safeFetchTarget(url))) {
      return { ok: false, error: `refused unsafe confirm target: ${url}` };
    }
    let page: Page | null = null;
    try {
      const browser = await worker.launch();
      const context = await browser.newContext();
      context.setDefaultNavigationTimeout(navTimeout);
      // SSRF guard for in-browser redirects: abort any request to a blocked host.
      await context.route("**/*", async (route) => {
        const safe = await safeFetchTarget(route.request().url());
        if (safe) return route.continue();
        return route.abort("blockedbyclient");
      });
      page = await context.newPage();
      const res = await page.goto(url, { waitUntil: "load", timeout: navTimeout });
      const status = res?.status();
      const ok = status === undefined ? true : status >= 200 && status < 400;
      await context.close();
      return { ok, status };
    } catch (err) {
      if (page) await page.context().close().catch(() => {});
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

// ── The loop ────────────────────────────────────────────────────────────────

/**
 * Process ONE confirmation queue item end-to-end. Pure of the polling, so the
 * gate can drive a single hand-built item. Returns the disposition; performs the
 * archive write (confirm / fail / release) itself.
 */
export async function processConfirmation(
  item: ConfirmationResponse,
  opts: {
    archive: RunConfirmLoopOptions["archive"];
    click: ClickFn;
  },
): Promise<ConfirmItemResult> {
  const { archive, click } = opts;
  const confirmationId = item.id;
  // Both archive contracts: Rails nests `address.id`, Cloudflare gives `address_id`.
  const addressId = item.address?.id ?? item.address_id ?? -1;
  if (addressId < 0) {
    return {
      confirmationId,
      addressId,
      disposition: "failed",
      clickedLinks: [],
      reason: "no address id on confirmation",
    };
  }

  // ── Cloudflare contract: the confirm link was extracted at ingest. We just
  //    navigate it — no blob fetch, no client-side parse. The cardinal rule is
  //    STILL enforced agent-side (isConfirmLink) so we never click a link the
  //    whitelist would refuse, even one the archive handed us. ───────────────
  if (typeof item.confirm_url === "string" && item.confirm_url.trim() !== "") {
    return processConfirmUrl(item.confirm_url, confirmationId, addressId, archive, click);
  }

  const key = item.raw_eml_key ?? item.raw_eml_url;
  if (!key) {
    // No blob to read → nothing to extract → fail (note it).
    await archive
      .failConfirmation(confirmationId, "no raw_eml_key on confirmation")
      .catch(() => {});
    return {
      confirmationId,
      addressId,
      disposition: "failed",
      clickedLinks: [],
      reason: "no raw_eml_key",
    };
  }

  // 1. Read the raw .eml bytes (transient-failable → release).
  let raw: Uint8Array;
  try {
    raw = await archive.fetchBlob(key);
  } catch (err) {
    await archive.releaseConfirmation(confirmationId).catch(() => {});
    return {
      confirmationId,
      addressId,
      disposition: "released",
      clickedLinks: [],
      reason: `fetchBlob failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Extract ONLY confirm links (the cardinal whitelist). Never throws.
  const links = extractConfirmLinks(raw);

  // 3. No confirm link → fail gracefully (do NOT click a fallback). Archive-side
  //    the address times out to needs_attention.
  if (links.length === 0) {
    await archive
      .failConfirmation(confirmationId, "no confirmation link found in email")
      .catch(() => {});
    return {
      confirmationId,
      addressId,
      disposition: "failed",
      clickedLinks: [],
      reason: "no confirm link",
    };
  }

  // 4. Click ONLY the whitelisted confirm link(s). Stop at the first success —
  //    one registered confirm is enough; we never click more than we must.
  let clickedAny = false;
  const clicked: string[] = [];
  let lastClickError = "";
  for (const link of links) {
    clicked.push(link);
    let result: ClickResult;
    try {
      result = await click(link);
    } catch (err) {
      lastClickError = err instanceof Error ? err.message : String(err);
      continue;
    }
    if (result.ok) {
      clickedAny = true;
      break;
    }
    lastClickError = result.error ?? `status ${result.status ?? "?"}`;
  }

  // 5a. A click registered → confirm the address (archive flips it active).
  if (clickedAny) {
    try {
      await archive.confirmAddress(addressId);
      return {
        confirmationId,
        addressId,
        disposition: "confirmed",
        clickedLinks: clicked,
        reason: "confirm link clicked; address confirmed",
      };
    } catch (err) {
      // We clicked successfully but couldn't tell the archive — transient.
      // Release so the item is retried (the click was idempotent ESP-side).
      await archive.releaseConfirmation(confirmationId).catch(() => {});
      return {
        confirmationId,
        addressId,
        disposition: "released",
        clickedLinks: clicked,
        reason: `confirmAddress failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 5b. We had a confirm link but every click failed → transient; release for
  //     a retry (the link may be a flaky endpoint, not a missing one).
  await archive.releaseConfirmation(confirmationId).catch(() => {});
  return {
    confirmationId,
    addressId,
    disposition: "released",
    clickedLinks: clicked,
    reason: `confirm link click failed: ${lastClickError || "unknown"}`,
  };
}

/**
 * Cloudflare-contract item: the archive already extracted the confirm link at
 * ingest, so there is nothing to fetch/parse — we re-validate it through the
 * cardinal whitelist (defense in depth) and navigate it. The CF archive has no
 * release/fail endpoints: on any failure we report the disposition but make no
 * archive write — the confirmation's lease TTL + the cron sweep re-pend it for a
 * later pass, and the click is idempotent ESP-side.
 */
async function processConfirmUrl(
  url: string,
  confirmationId: number,
  addressId: number,
  archive: RunConfirmLoopOptions["archive"],
  click: ClickFn,
): Promise<ConfirmItemResult> {
  // Cardinal rule, enforced agent-side even on a link the archive handed us:
  // never click anything the confirm whitelist refuses.
  if (!isConfirmLink(url)) {
    return {
      confirmationId,
      addressId,
      disposition: "failed",
      clickedLinks: [],
      reason: "confirm_url refused by whitelist",
    };
  }

  let result: ClickResult;
  try {
    result = await click(url);
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    try {
      await archive.confirmAddress(addressId);
      return {
        confirmationId,
        addressId,
        disposition: "confirmed",
        clickedLinks: [url],
        reason: "confirm link clicked; address confirmed",
      };
    } catch (err) {
      // Clicked, but couldn't tell the archive — lease TTL re-pends it (no
      // release endpoint on CF; the ESP-side click is idempotent).
      return {
        confirmationId,
        addressId,
        disposition: "released",
        clickedLinks: [url],
        reason: `confirmAddress failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    confirmationId,
    addressId,
    disposition: "released",
    clickedLinks: [url],
    reason: `confirm link click failed: ${result.error ?? `status ${result.status ?? "?"}`}`,
  };
}

/**
 * Run ONE poll → click → confirm pass over the confirmations queue.
 *
 * Claims a batch under `workerId`, processes each item independently (one
 * failure never stalls the batch), and returns a per-item disposition summary.
 * The injected `click` defaults to the plain HTTPS GET clicker.
 */
export async function runConfirmLoop(
  opts: RunConfirmLoopOptions,
): Promise<RunConfirmLoopResult> {
  const { workerId, archive } = opts;
  const click = opts.click ?? httpGetClick();
  const limit = opts.limit ?? 20;

  const queue = await archive.pollConfirmations(workerId, limit);

  const items: ConfirmItemResult[] = [];
  for (const item of queue) {
    try {
      items.push(await processConfirmation(item, { archive, click }));
    } catch (err) {
      // Last-resort guard so a thrown handler can't stall the whole batch.
      const reason = err instanceof Error ? err.message : String(err);
      await archive.releaseConfirmation(item.id).catch(() => {});
      items.push({
        confirmationId: item.id,
        addressId: item.address?.id ?? item.address_id ?? -1,
        disposition: "error",
        clickedLinks: [],
        reason: `unexpected: ${reason}`,
      });
    }
  }

  return {
    polled: queue.length,
    confirmed: items.filter((i) => i.disposition === "confirmed").length,
    failed: items.filter((i) => i.disposition === "failed").length,
    released: items.filter((i) => i.disposition === "released").length,
    errored: items.filter((i) => i.disposition === "error").length,
    items,
  };
}
