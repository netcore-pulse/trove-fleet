/**
 * Cookie-consent + popup overlay dismissal.
 *
 * Handoff "The subscribe loop" step 1: "Dismiss cookie/popup overlays" before
 * interacting. A consent banner or a marketing interstitial sitting over the
 * page blocks clicks on the real signup form, so we clear it first.
 *
 * Two kinds of overlay, two strategies:
 *  - Cookie/consent banners → click an *accept/agree/got-it* control. (Clicking
 *    "accept" is the least-surprising dismissal; we never click "reject" paths
 *    that might trigger extra flows, and we touch nothing beyond dismissal.)
 *  - Marketing popups / dialogs → click a *close/dismiss/×* control, or press
 *    Escape.
 *
 * IMPORTANT scope: dismissal here is NOT "click anything". It is a narrow,
 * allow-listed set of dismissal controls. We never tick a marketing checkbox or
 * follow a link — that would violate the "only the newsletter" rule. This is
 * the same conservative posture as the confirm-link whitelist in A0.
 *
 * The button-text matching is a pure function ({@link looksLikeDismissControl})
 * so it is unit-testable without a browser; the Playwright driver
 * ({@link dismissOverlays}) just feeds candidate controls through it.
 */

import type { Page } from "playwright";

/** Accept/agree-style text for cookie/consent banners. */
const ACCEPT_TEXT =
  /\b(accept(\s+all)?|agree|i\s+agree|got\s+it|allow(\s+all)?|ok(ay)?|continue|understand|consent)\b/i;

/** Close/dismiss-style text (or glyphs) for marketing popups/dialogs. */
const CLOSE_TEXT =
  /\b(close|dismiss|no\s+thanks?|maybe\s+later|not\s+now|skip|×|✕|✖|⨯)\b|^\s*[x×]\s*$/i;

/** Classify a control's accessible text/label into a dismissal kind, or null. */
export function looksLikeDismissControl(text: string): "accept" | "close" | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  // Close first: "no thanks" / "skip" should never be read as accept.
  if (CLOSE_TEXT.test(t)) return "close";
  if (ACCEPT_TEXT.test(t)) return "accept";
  return null;
}

/** Selectors for likely cookie/consent + popup containers (broad but bounded). */
const OVERLAY_CONTAINER_SEL = [
  "[id*='cookie']",
  "[class*='cookie']",
  "[id*='consent']",
  "[class*='consent']",
  "[aria-label*='cookie' i]",
  "[class*='gdpr']",
  "#onetrust-banner-sdk",
  ".ot-sdk-container",
  "#CybotCookiebotDialog",
  "[role='dialog']",
  "dialog[open]",
  "[aria-modal='true']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='overlay']",
  "[class*='lightbox']",
].join(", ");

export interface DismissResult {
  /** Number of overlays we clicked/closed. */
  dismissed: number;
  /** Kinds dismissed, for diagnostics. */
  kinds: Array<"accept" | "close" | "escape">;
}

/**
 * Best-effort: dismiss visible cookie/consent banners and popup overlays.
 *
 * Strategy per overlay container found:
 *  1. Look for a button / link / [role=button] whose text classifies via
 *     {@link looksLikeDismissControl}; click the first match (close beats accept
 *     inside a marketing popup; accept is fine for a cookie banner).
 *  2. If none, press Escape (closes many dialogs).
 *
 * Always swallows errors — a missing/unclickable overlay must never fail the
 * subscribe attempt. Returns a small summary for logging.
 */
export async function dismissOverlays(page: Page, maxOverlays = 4): Promise<DismissResult> {
  const result: DismissResult = { dismissed: 0, kinds: [] };

  for (let pass = 0; pass < maxOverlays; pass++) {
    const containers = await page.$$(OVERLAY_CONTAINER_SEL);
    let actedThisPass = false;

    for (const container of containers) {
      let containerVisible = false;
      try {
        containerVisible = await container.isVisible();
      } catch {
        containerVisible = false;
      }
      if (!containerVisible) continue;

      // CRITICAL: never dismiss a container that IS the signup. A newsletter
      // popup/modal often matches our broad overlay selectors (it's a dialog),
      // but it holds the email field we came for — closing it would defeat the
      // whole attempt. If the container has an email input, skip it; the
      // form-finder will pick it up. (Cookie banners have no email input.)
      let isSignup = false;
      try {
        const emailInput = await container.$("input[type='email'], input[name*='email' i], input[autocomplete='email']");
        isSignup = !!emailInput;
      } catch {
        isSignup = false;
      }
      if (isSignup) continue;

      // Enumerate candidate dismissal controls within this overlay.
      let controls: Awaited<ReturnType<Page["$$"]>> = [];
      try {
        controls = await container.$$("button, a, [role='button'], input[type='button'], input[type='submit']");
      } catch {
        controls = [];
      }

      let clicked = false;
      for (const ctrl of controls) {
        let label = "";
        try {
          label =
            (await ctrl.getAttribute("aria-label")) ??
            (await ctrl.textContent()) ??
            (await ctrl.getAttribute("value")) ??
            "";
        } catch {
          label = "";
        }
        const kind = looksLikeDismissControl(label);
        if (!kind) continue;
        try {
          let visible = false;
          try {
            visible = await ctrl.isVisible();
          } catch {
            visible = false;
          }
          if (!visible) continue;
          await ctrl.click({ timeout: 1500 });
          result.dismissed++;
          result.kinds.push(kind);
          clicked = true;
          actedThisPass = true;
          break;
        } catch {
          // try the next control
        }
      }

      if (!clicked) {
        // Fallback: Escape can close many dialogs/popups.
        try {
          await page.keyboard.press("Escape");
          // Re-check: only count if the container is now hidden.
          let stillVisible = true;
          try {
            stillVisible = await container.isVisible();
          } catch {
            stillVisible = false;
          }
          if (!stillVisible) {
            result.dismissed++;
            result.kinds.push("escape");
            actedThisPass = true;
          }
        } catch {
          // ignore
        }
      }
    }

    if (!actedThisPass) break; // nothing left to dismiss
  }

  return result;
}
