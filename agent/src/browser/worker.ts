/**
 * Browser worker shell — launches headless chromium and builds a
 * persona-derived browser context.
 *
 * This is the deterministic harness the handoff describes: "the deterministic
 * harness drives the browser and records state." It owns the chromium lifecycle
 * and the per-target context fingerprint (viewport / UA / locale / timezone),
 * derived from A0's persona via {@link fingerprintForPersona}.
 *
 * A1 scope: one browser, one context per target, headless. It does NOT do proxy
 * rotation or bounded-pool concurrency — that is A3. The seam is here, though:
 * `launchProxy` would slot into `chromium.launch` later.
 *
 * Testability: the heavy logic (form ranking, overlay text classification,
 * fingerprint derivation) lives in pure modules with their own unit tests. This
 * shell is exercised end-to-end by the subscribe-loop tests driving real
 * chromium against local HTML fixtures — deterministic, no network.
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Persona } from "../persona.ts";
import { fingerprintForPersona, type Fingerprint } from "./fingerprint.ts";
import { dismissOverlays, type DismissResult } from "./overlays.ts";

/**
 * How long to wait for a provoked email popup to render (env-tunable). Modest by
 * default — most delayed/exit-intent popups fire within ~1s of the trigger.
 * Bump `TROVE_POPUP_SETTLE_MS` higher to chase slower spin-to-win popups; set 0
 * to skip the wait entirely (the scroll/exit-intent nudges still fire).
 */
const POPUP_SETTLE_MS = (() => {
  const v = Number(process.env.TROVE_POPUP_SETTLE_MS);
  return Number.isFinite(v) && v >= 0 ? v : 1200;
})();

/**
 * Runs IN THE BROWSER (via page.evaluate): if Klaviyo is present, deterministically
 * open every `klaviyo-form-<id>` whose container is in the DOM, using Klaviyo's
 * documented onsite API `_klOnsite.push(['openForm', id])` — surfacing the popup
 * signup without waiting on its timer/scroll/exit-intent trigger. Returns how many
 * it opened. Must stay a standalone function (no closures) so it serializes.
 */
function triggerKlaviyoForms(): number {
  try {
    const w = window as unknown as { klaviyo?: unknown; _klOnsite?: unknown[] };
    const hasKlaviyo =
      !!w.klaviyo ||
      Array.isArray(w._klOnsite) ||
      !!document.querySelector('script[src*="static.klaviyo.com/onsite"]');
    if (!hasKlaviyo) return 0;
    const ids = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('[class*="klaviyo-form-"]'))) {
      for (const cls of Array.from(el.classList)) {
        const m = /^klaviyo-form-([A-Za-z0-9]+)$/.exec(cls);
        if (m && m[1]) ids.add(m[1]);
      }
    }
    if (!Array.isArray(w._klOnsite)) w._klOnsite = [];
    let n = 0;
    for (const id of ids) {
      try {
        (w._klOnsite as unknown[]).push(["openForm", id]);
        n++;
      } catch {
        /* a single bad id must not stop the rest */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

export interface BrowserWorkerOptions {
  /** Launch headless (default true). The live smoke may flip this. */
  headless?: boolean;
  /** Per-navigation timeout in ms (default 30s). */
  navigationTimeoutMs?: number;
  /** Extra chromium launch args (e.g. for CI sandboxing). */
  launchArgs?: string[];
  /**
   * Egress proxy server URL (the A3 footprint slot-in). When set, chromium
   * launches through this proxy so the attempt egresses from a rotated IP. The
   * string is whatever playwright/chromium accepts — `http://host:port`,
   * `socks5://host:port`, optionally with embedded creds. Omit / null = direct.
   */
  proxyServer?: string | null;
}

export interface OpenPageResult {
  page: Page;
  fingerprint: Fingerprint;
  overlays: DismissResult;
}

/**
 * Owns a single chromium instance. Build one context per target so each target
 * gets its own cookies + fingerprint (footprint hygiene). Always `close()` in a
 * `finally`.
 */
export class BrowserWorker {
  private browser: Browser | null = null;
  private readonly headless: boolean;
  private readonly navigationTimeoutMs: number;
  private readonly launchArgs: string[];
  private readonly proxyServer: string | null;

  constructor(opts: BrowserWorkerOptions = {}) {
    this.headless = opts.headless ?? true;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.launchArgs = opts.launchArgs ?? ["--no-sandbox", "--disable-dev-shm-usage"];
    this.proxyServer = opts.proxyServer ?? null;
  }

  /** Lazily launch the shared browser. */
  async launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
        args: this.launchArgs,
        // A3 footprint: egress through the rotated proxy when one is configured.
        ...(this.proxyServer ? { proxy: { server: this.proxyServer } } : {}),
      });
    }
    return this.browser;
  }

  /**
   * Build a fresh, persona-fingerprinted context. One per target.
   */
  async newContext(persona: Persona): Promise<{ context: BrowserContext; fingerprint: Fingerprint }> {
    const browser = await this.launch();
    const fingerprint = fingerprintForPersona(persona);
    const context = await browser.newContext({
      viewport: fingerprint.viewport,
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezoneId,
      deviceScaleFactor: fingerprint.deviceScaleFactor,
    });
    context.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    context.setDefaultTimeout(this.navigationTimeoutMs);
    return { context, fingerprint };
  }

  /**
   * Open `url` in a fresh persona context, wait for load, and dismiss overlays.
   *
   * Mirrors the screenshot-pipeline lesson (and the handoff): React/ESP popups
   * hydrate after `domcontentloaded`, so we wait for `load`, settle fonts, and
   * give popups a beat to appear before dismissing them — otherwise the consent
   * banner pops up *after* we've already looked for it.
   *
   * The caller owns the returned page's context and must close it (or call
   * {@link closePage}).
   */
  async openPage(url: string, persona: Persona): Promise<OpenPageResult> {
    const { context, fingerprint } = await this.newContext(persona);
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: this.navigationTimeoutMs });
    // Let fonts + late-firing popups settle (consent banners often arrive late).
    await page.evaluate(async () => {
      if (document.fonts && (document.fonts as FontFaceSet).ready) {
        await (document.fonts as FontFaceSet).ready;
      }
    }).catch(() => {});
    await page.waitForTimeout(400);
    // Surface the email-capture popup BEFORE we look for a form. On Shopify the
    // newsletter signup is very often a Privy/Klaviyo/Justuno "spin-to-win" popup
    // that fires on a delay, on scroll, or on exit-intent — not a static footer
    // form. Provoke those triggers, then let it render; dismissOverlays preserves
    // any overlay that holds an email input (it's the capture, not a nuisance).
    await this.provokePopups(page);
    const overlays = await dismissOverlays(page);
    return { page, fingerprint, overlays };
  }

  /**
   * Best-effort: provoke delayed / scroll / exit-intent email-capture popups so
   * they are in the DOM before the form-finder scans. Pure side-effects; never
   * throws (a hostile page must not break the open). Tunable settle via
   * `TROVE_POPUP_SETTLE_MS` (default 2500) — delayed popups commonly fire 2-5s in.
   */
  private async provokePopups(page: Page): Promise<void> {
    try {
      // Scroll-triggered: nudge down a screen, then back to the top.
      await page
        .evaluate(() => window.scrollTo(0, Math.min(900, document.body?.scrollHeight ?? 0)))
        .catch(() => {});
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      // Exit-intent (Privy/Justuno/OptinMonster): cursor to the top edge + a
      // synthetic mouseleave/mouseout toward the top, which most libs listen for.
      await page.mouse.move(12, 0).catch(() => {});
      await page
        .evaluate(() => {
          document.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true, clientX: 0, clientY: 0 }));
          document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, clientX: 0, clientY: 0 }));
        })
        .catch(() => {});
      // Klaviyo (the dominant ESP, ~1/3 of stores, and the weakest segment for a
      // static finder because its signup is a popup): deterministically OPEN any
      // klaviyo-form-<id> whose container is in the DOM via the documented
      // `_klOnsite.push(['openForm', id])` API — no waiting on its timer/exit-intent.
      await page.evaluate(triggerKlaviyoForms).catch(() => {});
      // Let the popup hydrate + animate in.
      await page.waitForTimeout(POPUP_SETTLE_MS);
    } catch {
      // best-effort; never block the attempt
    }
  }

  /** Close a page and its owning context. */
  async closePage(page: Page): Promise<void> {
    const context = page.context();
    try {
      await page.close();
    } catch {
      // ignore
    }
    try {
      await context.close();
    } catch {
      // ignore
    }
  }

  /** Tear down the shared browser. Idempotent. */
  async close(): Promise<void> {
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => {});
    }
  }
}
