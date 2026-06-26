/**
 * Newsletter form finder — find the email input with *subscribe intent*.
 *
 * The hard part of A1 is disambiguation: a homepage often has several email-ish
 * inputs (a login box, a search field, a footer newsletter signup, a popup
 * modal). We must pick the newsletter signup and REJECT the login + search
 * decoys (handoff "The subscribe loop" step 1).
 *
 * Design for testability:
 *  - The browser-dependent part is a single pure extraction script
 *    ({@link EXTRACT_CANDIDATES_SCRIPT}) run via `page.evaluate`. It walks the
 *    DOM into plain, serializable {@link FieldCandidate} objects.
 *  - The decision is {@link rankCandidates}, a PURE function over those objects.
 *    No browser, no Playwright — so the heuristics are unit-tested directly
 *    against hand-built candidate snapshots, deterministically.
 *
 * This split mirrors how A0 made the archive boundary testable: isolate the
 * external, flaky surface (the DOM) behind a plain data shape, then unit-test
 * the logic over that shape.
 *
 * ESP embeds (Klaviyo, Mailchimp, Omnisend, Privy) are the common real cases;
 * their markup carries signature classes / attributes / iframes that we score
 * as strong subscribe-intent signals.
 */

// ── ESP signatures ────────────────────────────────────────────────────────────

export type Esp = "klaviyo" | "mailchimp" | "omnisend" | "privy" | "generic";

/**
 * Per-ESP regexes over a candidate's *context blob* (its own attrs + ancestor
 * form/section attrs + nearby text). Conservative: only well-known markers.
 *  - Klaviyo: `klaviyo-form-*`, `kl_*` ids, `klaviyoForms`, kmail-lists action.
 *  - Mailchimp: `mc-field-group`, `mc4wp`, `id="mce-EMAIL"`, list-manage action.
 *  - Omnisend: `omnisend`, `omnisendSnippet`, `soundest` (legacy), `data-omni*`.
 *  - Privy: `privy`, `data-privy*`, `privy-` widget classes.
 */
export const ESP_SIGNATURES: ReadonlyArray<{ esp: Esp; re: RegExp }> = [
  { esp: "klaviyo", re: /klaviyo|kmail-lists|kl_-?\w*foreign|kl-private|klaviyoforms/i },
  { esp: "mailchimp", re: /mailchimp|mc4wp|mc-field-group|mce-email|list-manage\.com/i },
  { esp: "omnisend", re: /omnisend|omnisendsnippet|soundest|data-omni/i },
  { esp: "privy", re: /\bprivy\b|data-privy|privy-/i },
];

/** Detect the ESP from a free-text context blob (lowercased internally). */
export function detectEsp(contextBlob: string): Esp {
  for (const { esp, re } of ESP_SIGNATURES) {
    if (re.test(contextBlob)) return esp;
  }
  return "generic";
}

// ── Candidate shape (the serializable DOM snapshot) ─────────────────────────────

/**
 * A flattened, serializable description of one email-capable input on the page,
 * plus the contextual signals we score. Produced in-page by the extraction
 * script; consumed by the pure ranker. Everything here must survive
 * `JSON`-style structured cloning across the `page.evaluate` boundary.
 */
export interface FieldCandidate {
  /** Stable per-extraction id, used to re-find the element to fill it. */
  id: string;
  /** `<input type=...>` (lowercased) or "" if absent. */
  type: string;
  /** input name attr (lowercased). */
  name: string;
  /** input id attr (lowercased). */
  elementId: string;
  /** placeholder text (lowercased). */
  placeholder: string;
  /** aria-label / aria-labelledby resolved text (lowercased). */
  ariaLabel: string;
  /** autocomplete attr (lowercased). */
  autocomplete: string;
  /** Visible label text associated with the field (lowercased). */
  labelText: string;
  /** True if the input is visible (non-zero box, not display:none/hidden). */
  visible: boolean;
  /** Tag name of the closest landmark/section ancestor (lowercased). */
  regionTag: string;
  /** role / id / class of the closest section/landmark ancestor (lowercased). */
  regionContext: string;
  /** True if the field's enclosing form ALSO contains a password input. */
  hasPasswordSibling: boolean;
  /** True if the field's enclosing form ALSO contains another email input. */
  hasOtherEmailSibling: boolean;
  /** True if the field looks like a search box (type=search / role=search / name~=search). */
  looksLikeSearch: boolean;
  /** True if the field sits inside a footer landmark. */
  inFooter: boolean;
  /** True if the field sits inside a modal/dialog/popup container. */
  inModal: boolean;
  /** Free-text blob of nearby attrs/text used for ESP + intent detection. */
  contextBlob: string;
  /**
   * True if the input is flagged as a honeypot (anti-bot): hidden input that a
   * bot would fill, e.g. name~=(honeypot|hp|bot|gotcha) or a visually-hidden
   * email that's offscreen. We never fill these.
   */
  isHoneypot: boolean;
}

export interface FormPick {
  candidate: FieldCandidate;
  /** ESP detected from the chosen candidate's context. */
  esp: Esp;
  /** Numeric score (higher = stronger subscribe intent). For diagnostics. */
  score: number;
  /** Other candidate fields inside the SAME form (name/zip/etc.) to fill. */
  siblings: FieldCandidate[];
}

// ── Intent vocabulary ───────────────────────────────────────────────────────────

const SUBSCRIBE_WORDS =
  /subscribe|newsletter|sign[\s_-]?up|join|email[\s_-]?list|mailing[\s_-]?list|stay[\s_-]?in[\s_-]?touch|get[\s_-]?(the[\s_-]?)?(updates|offers|deals|news)|keep[\s_-]?up|notify|10%|15%|20%|first[\s_-]?to[\s_-]?know|be[\s_-]?the[\s_-]?first/i;

const LOGIN_WORDS = /\b(log[\s_-]?in|sign[\s_-]?in|password|forgot|account|my[\s_-]?account|credentials)\b/i;

const SEARCH_WORDS = /\bsearch\b|search[\s_-]?(site|store|products?)|what[\s_-]?are[\s_-]?you[\s_-]?looking/i;

// ── The pure ranker ─────────────────────────────────────────────────────────────

/**
 * Rank candidate fields and pick the best newsletter email input, or null.
 *
 * PURE + DETERMINISTIC over the snapshot — no DOM, no browser. This is the
 * unit-tested decision core.
 *
 * Hard rejections (never chosen, regardless of score):
 *  - not an email-capable field (type must be email/text/"" with email-ish hints)
 *  - a password sibling in the same form  → it's a login form
 *  - looks like a search box               → it's site search
 *  - honeypot                              → anti-bot trap, never touch
 *  - not visible                           → can't be a real signup target
 *
 * Scoring (among survivors): subscribe-intent words in context/label/placeholder,
 * ESP signature present, footer or modal placement, autocomplete=email, an
 * explicit type=email. Login-word context is penalized. Highest score wins;
 * ties break toward footer, then modal, then DOM order (the snapshot's order).
 */
export function rankCandidates(candidates: readonly FieldCandidate[]): FormPick | null {
  let best: { c: FieldCandidate; score: number } | null = null;

  for (const c of candidates) {
    if (!isEmailCapable(c)) continue;
    // Hard rejections.
    if (c.isHoneypot) continue;
    if (!c.visible) continue;
    if (c.hasPasswordSibling) continue; // login form
    if (c.looksLikeSearch) continue; // site search

    const blob = `${c.name} ${c.elementId} ${c.placeholder} ${c.ariaLabel} ${c.labelText} ${c.autocomplete} ${c.regionContext} ${c.contextBlob}`;

    // A field whose ONLY intent signal is login-ish is a login email (no
    // password sibling, e.g. a 2-step login). Reject when login words present
    // and no subscribe intent anywhere.
    const hasSubscribe = SUBSCRIBE_WORDS.test(blob);
    const hasLogin = LOGIN_WORDS.test(blob);
    if (hasLogin && !hasSubscribe) continue;

    // A field is only a *candidate newsletter* if it carries POSITIVE intent:
    // subscribe wording, an ESP signature, or a footer/modal signup placement.
    // Email-ness alone (type=email, name=email) is NOT enough — a bare email box
    // could be anything (login, checkout, account). Don't guess; refuse.
    const hasEspSig = detectEsp(blob) !== "generic";
    const hasIntent = hasSubscribe || hasEspSig || c.inFooter || c.inModal;
    if (!hasIntent) continue;

    let score = 0;
    if (hasSubscribe) score += 50;
    if (hasEspSig) score += 40;
    if (c.inFooter) score += 25;
    if (c.inModal) score += 20;
    if (c.type === "email") score += 15;
    if (c.autocomplete.includes("email")) score += 10;
    if (/email/.test(`${c.name} ${c.elementId} ${c.placeholder} ${c.ariaLabel} ${c.labelText}`)) score += 8;
    if (hasLogin) score -= 40;

    // After the login penalty a field can net out non-positive → refuse.
    if (score <= 0) continue;

    if (
      best === null ||
      score > best.score ||
      (score === best.score && tieBreakPreferred(c, best.c))
    ) {
      best = { c, score };
    }
  }

  if (!best) return null;

  const blob = `${best.c.name} ${best.c.elementId} ${best.c.placeholder} ${best.c.ariaLabel} ${best.c.labelText} ${best.c.autocomplete} ${best.c.regionContext} ${best.c.contextBlob}`;
  const esp = detectEsp(blob);

  // Sibling fields = other visible, non-honeypot, non-email inputs in the same
  // region (name/zip/etc.). We deliberately scope by region context so we don't
  // drag in unrelated page inputs.
  const siblings = candidates.filter(
    (s) =>
      s.id !== best!.c.id &&
      s.visible &&
      !s.isHoneypot &&
      s.regionContext === best!.c.regionContext &&
      s.type !== "email" &&
      s.type !== "password" &&
      s.type !== "search",
  );

  return { candidate: best.c, esp, score: best.score, siblings };
}

/** Email-capable: type=email, or a text/blank input with email hints. */
function isEmailCapable(c: FieldCandidate): boolean {
  if (c.type === "email") return true;
  if (c.type === "password" || c.type === "search" || c.type === "tel" || c.type === "number") {
    return false;
  }
  if (c.type === "text" || c.type === "") {
    const hints = `${c.name} ${c.elementId} ${c.placeholder} ${c.ariaLabel} ${c.labelText} ${c.autocomplete}`;
    return /email|e-mail|\bmail\b/.test(hints);
  }
  return false;
}

/** Tie-break: prefer footer, then modal, then keep the earlier (incumbent). */
function tieBreakPreferred(challenger: FieldCandidate, incumbent: FieldCandidate): boolean {
  if (challenger.inFooter !== incumbent.inFooter) return challenger.inFooter;
  if (challenger.inModal !== incumbent.inModal) return challenger.inModal;
  return false; // keep incumbent on a true tie (stable, DOM order)
}

// ── The in-page extraction script ───────────────────────────────────────────────

/**
 * Source of the function evaluated IN the page to produce FieldCandidate[].
 *
 * Kept as a self-contained function (no closure over module scope) so it can be
 * passed straight to Playwright's `page.evaluate`. It tags each input with a
 * `data-trove-fc` id so the caller can re-find and fill it deterministically.
 *
 * Exported as a function reference (not a string) — Playwright serializes it.
 */
export function extractCandidates(): FieldCandidate[] {
  // Robust lower-case: most callers pass string|null, but `element.className` is an
  // SVGAnimatedString (not a string) on SVG nodes — calling .toLowerCase() on it throws,
  // which (swallowed by the caller's catch) silently dead-ends the store at no_form_found.
  // Coerce: real string → use it; SVGAnimatedString → its baseVal; anything else → "".
  const lc = (s: unknown): string => {
    if (typeof s === "string") return s.toLowerCase().trim();
    if (s && typeof s === "object" && typeof (s as { baseVal?: unknown }).baseVal === "string") {
      return ((s as { baseVal: string }).baseVal).toLowerCase().trim();
    }
    return "";
  };

  const FOOTER_SEL = "footer, [role='contentinfo'], [class*='footer'], [id*='footer']";
  const MODAL_SEL =
    "[role='dialog'], dialog, [aria-modal='true'], [class*='modal'], [class*='popup'], [class*='dialog'], [class*='overlay'], [class*='lightbox']";

  function closest(el: Element, sel: string): Element | null {
    return el.closest(sel);
  }

  function isVisible(el: Element): boolean {
    const he = el as HTMLElement;
    const style = window.getComputedStyle(he);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = he.getBoundingClientRect();
    // Zero-box OR pushed far offscreen (a common visually-hidden honeypot trick).
    if (rect.width <= 1 || rect.height <= 1) return false;
    if (rect.left < -2000 || rect.top < -2000) return false;
    return true;
  }

  function labelFor(input: HTMLInputElement): string {
    // Wrapped label, explicit for=, or aria-labelledby.
    const byFor = input.id ? document.querySelector(`label[for='${CSS.escape(input.id)}']`) : null;
    if (byFor && byFor.textContent) return byFor.textContent;
    const wrap = input.closest("label");
    if (wrap && wrap.textContent) return wrap.textContent;
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const ref = document.getElementById(labelledBy);
      if (ref && ref.textContent) return ref.textContent;
    }
    return "";
  }

  function regionOf(input: HTMLInputElement): Element {
    return (
      input.closest("form") ||
      input.closest("section, [role='region'], aside, footer, [role='dialog'], dialog, [class*='newsletter'], [class*='signup'], [class*='subscribe']") ||
      input.parentElement ||
      input
    );
  }

  const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
  const out: FieldCandidate[] = [];
  let counter = 0;

  for (const input of inputs) {
    const type = lc(input.getAttribute("type")) || "text";
    // Skip obviously irrelevant control types early.
    if (["checkbox", "radio", "submit", "button", "file", "range", "color"].includes(type)) {
      continue;
    }

    const id = `fc-${counter++}`;
    input.setAttribute("data-trove-fc", id);

    const form = input.closest("form");
    const passwordSibling = !!form && !!form.querySelector("input[type='password']");
    const emailSiblings = form
      ? (Array.from(form.querySelectorAll("input")) as HTMLInputElement[]).filter(
          (e) => lc(e.getAttribute("type")) === "email" && e !== input,
        ).length
      : 0;

    const name = lc(input.getAttribute("name"));
    const elementId = lc(input.getAttribute("id"));
    const placeholder = lc(input.getAttribute("placeholder"));
    const ariaLabel = lc(input.getAttribute("aria-label")) || lc(labelFor(input));
    const labelText = lc(labelFor(input));
    const autocomplete = lc(input.getAttribute("autocomplete"));

    const region = regionOf(input);
    const regionTag = lc(region.tagName);
    const regionContext = lc(
      `${region.getAttribute("role") ?? ""} ${region.id} ${region.className} ${region.getAttribute("action") ?? ""}`,
    );

    const inFooter = !!closest(input, FOOTER_SEL);
    const inModalEl = closest(input, MODAL_SEL);
    const inModal = !!inModalEl && isVisible(inModalEl);

    const looksLikeSearch =
      type === "search" ||
      /search/.test(`${name} ${elementId} ${placeholder} ${ariaLabel}`) ||
      !!input.closest("[role='search'], form[role='search'], [class*='search']");

    // Honeypot heuristics: trap-named hidden inputs, or an email input that the
    // page has hidden (display:none / visually-hidden offscreen).
    const trapNamed = /honeypot|hp_|_hp|\bbot\b|gotcha|trap|confirm[_-]?email|website|url[_-]?field/.test(
      `${name} ${elementId}`,
    );
    const hidden = type === "hidden" || !isVisible(input);
    const isHoneypot = (trapNamed && hidden) || (trapNamed && type === "hidden");

    // A wide context blob: ancestors up to 4 levels carry ESP + intent markers.
    let ctx = `${name} ${elementId} ${placeholder} ${ariaLabel} ${regionContext}`;
    let node: Element | null = input;
    for (let depth = 0; depth < 4 && node; depth++) {
      ctx += ` ${lc(node.className)} ${lc(node.id)} ${lc(node.getAttribute("data-testid") ?? "")} ${lc(
        node.getAttribute("class") ?? "",
      )}`;
      // Pull a little nearby text (headings/buttons) for intent.
      node = node.parentElement;
    }
    // Add nearby button/heading text within the region for subscribe intent.
    const regionText = lc(region.textContent ?? "").slice(0, 400);
    ctx += ` ${regionText}`;

    out.push({
      id,
      type,
      name,
      elementId,
      placeholder,
      ariaLabel,
      autocomplete,
      labelText,
      visible: isVisible(input),
      regionTag,
      regionContext,
      hasPasswordSibling: passwordSibling,
      hasOtherEmailSibling: emailSiblings > 0,
      looksLikeSearch,
      inFooter,
      inModal,
      contextBlob: ctx,
      isHoneypot,
    });
  }

  return out;
}
