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
 * How long triggerKlaviyoForms polls for the Klaviyo SDK to become ready before
 * giving up. klaviyo.js loads its bundles AFTER `load` and, in a headless /
 * datacenter context, can take 7s+ to populate its form registry — far past the
 * generic POPUP_SETTLE_MS. Measured: a real popup-only store populated at ~7.5s.
 * Only Klaviyo-present pages pay this (we early-exit the moment a form id +
 * a ready openForm() appear); env-tunable via `TROVE_KLAVIYO_WAIT_MS`.
 */
const KLAVIYO_WAIT_MS = (() => {
  const v = Number(process.env.TROVE_KLAVIYO_WAIT_MS);
  return Number.isFinite(v) && v >= 0 ? v : 9000;
})();

/**
 * Runs IN THE BROWSER (via page.evaluate): if Klaviyo is present, deterministically
 * open every form the account has registered — using Klaviyo's documented onsite API
 * `_klOnsite.push(['openForm', id])` — surfacing the signup without waiting on its
 * timer/scroll/exit-intent trigger. Returns how many it opened. Must stay a standalone
 * function (no closures) so it serializes into page.evaluate. Takes `maxWaitMs`.
 *
 * Form-ID discovery uses two sources, because the DOM alone misses popup-only forms:
 *   1. DOM: `klaviyo-form-<id>` class tokens — finds EMBEDS (their container is in the
 *      initial HTML). Misses popups: their container isn't injected until triggered.
 *   2. `localStorage.klaviyoOnsite` — klaviyo.js seeds this with EVERY registered form's
 *      ID (embeds AND popups) at init, before any trigger fires and before injection.
 *      This is the lever that surfaces the popup-only tail.
 * Form IDs are 6-char alnum; the regexes exclude Klaviyo's component classes
 * (`klaviyo-form-richtext|button|image|version-…`) which share the prefix.
 *
 * CRITICAL — timing: klaviyo.js loads its bundles AFTER `load` and, headless/datacenter,
 * can take 7s+ to populate the registry (measured ~7.5s on a real popup-only store). A
 * single shot at provoke time fires into an EMPTY registry → 0 forms found → the store
 * dead-ends at no_form_found (this is exactly what sank a 20-shard drain: 228/228 Klaviyo
 * stores → no_form). So we POLL for readiness (SDK's openForm fn + ≥1 discoverable id)
 * up to `maxWaitMs`, early-exiting the moment both appear, then openForm and let the
 * injected popup render before the finder scans.
 */
async function triggerKlaviyoForms(maxWaitMs: number): Promise<number> {
  try {
    const w = window as unknown as {
      klaviyo?: { openForm?: (id: string) => void };
      _klOnsite?: unknown[];
    };
    const klaviyoPresent = (): boolean =>
      !!w.klaviyo ||
      Array.isArray(w._klOnsite) ||
      !!document.querySelector('script[src*="static.klaviyo.com/onsite"]') ||
      !!localStorage.getItem("klaviyoOnsite");
    if (!klaviyoPresent()) return 0;

    const COMPONENT = /^(richtext|button|image|version)$/i;
    const FORM_ID = /^[A-Za-z0-9]{5,8}$/;
    // Collect form ids from both sources (DOM embeds + the localStorage registry).
    const discover = (): Set<string> => {
      const ids = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('[class*="klaviyo-form-"]'))) {
        for (const cls of Array.from(el.classList)) {
          const m = /^klaviyo-form-([A-Za-z0-9]{5,8})$/.exec(cls);
          if (m && m[1] && !COMPONENT.test(m[1])) ids.add(m[1]);
        }
      }
      try {
        const onsite = JSON.parse(localStorage.getItem("klaviyoOnsite") || "{}") as {
          viewedForms?: Record<string, { viewedForms?: Record<string, unknown>; disabledForms?: Record<string, unknown> }>;
        };
        for (const bucket of Object.values(onsite.viewedForms ?? {})) {
          for (const id of [
            ...Object.keys(bucket?.viewedForms ?? {}),
            ...Object.keys(bucket?.disabledForms ?? {}),
          ]) {
            if (FORM_ID.test(id) && !COMPONENT.test(id)) ids.add(id);
          }
        }
      } catch {
        /* malformed/absent registry — fall back to the DOM ids */
      }
      return ids;
    };

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const deadline = performance.now() + (maxWaitMs > 0 ? maxWaitMs : 9000);
    // Poll until the SDK can open forms AND we have at least one id, or we time out.
    let ids = new Set<string>();
    for (;;) {
      const ready = typeof w.klaviyo?.openForm === "function";
      ids = discover();
      if (ready && ids.size > 0) break;
      if (performance.now() >= deadline) break;
      await sleep(300);
    }
    if (ids.size === 0) return 0;

    if (!Array.isArray(w._klOnsite)) w._klOnsite = [];
    let n = 0;
    for (const id of ids) {
      try {
        // openForm directly when the SDK is ready; the queue push is the fallback
        // Klaviyo drains once klaviyo.js finishes loading.
        w.klaviyo?.openForm?.(id);
        (w._klOnsite as unknown[]).push(["openForm", id]);
        n++;
      } catch {
        /* a single bad id must not stop the rest */
      }
    }
    // Let the injected popup hydrate + animate in before the finder scans the DOM.
    await sleep(1500);
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
      // static finder because its signup is a popup): WAIT for the SDK to populate
      // its form registry (headless/datacenter init is slow — ~7.5s observed), then
      // deterministically OPEN every registered form via the documented
      // `_klOnsite.push(['openForm', id])` API — no waiting on its timer/exit-intent.
      // The poll early-exits the instant a form id + ready openForm() appear, so only
      // slow-loading Klaviyo pages pay the full budget; it renders the popup itself.
      await page.evaluate(triggerKlaviyoForms, KLAVIYO_WAIT_MS).catch(() => {});
      // Let any non-Klaviyo provoked popup (Privy/Justuno spin-to-win) hydrate.
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
