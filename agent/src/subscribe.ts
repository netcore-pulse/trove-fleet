/**
 * The per-target subscribe loop (A1).
 *
 * Orchestrates one subscription attempt for one registrable domain:
 *
 *   lease (A0 store) → open page + dismiss overlays (browser worker)
 *     → detect anti-bot wall (park if walled)
 *     → find the newsletter email field (form-finder)
 *     → mint a fresh address (A0 archive client)
 *     → fill email = minted address + only required persona/consent fields
 *     → submit → classify outcome → drive the A0 state machine.
 *
 * Outcome → state (handoff "The subscribe loop" + "Blocked-handling"):
 *   success / "check your email"        → submitted
 *   validation error                    → retry once; still failing → needs_attention
 *   CAPTCHA / Turnstile / honeypot       → needs_solver  (detect, do NOT solve)
 *   no email field found                 → no_form_found
 *
 * Cardinal rules baked in:
 *   - email is ALWAYS the minted address; persona never carries real PII.
 *   - only *required* consent checkboxes are ticked; never opt into extras.
 *   - exactly one in-flight attempt per registrable domain (A0 lease).
 *   - never try to defeat a CAPTCHA — detect and park.
 *   - A1 never clicks confirmation links — that's A2.
 *
 * Testability: `subscribeOnPage` operates on an already-open Playwright `Page`
 * and an injected `mintAddress`, so the gate drives it against local HTML
 * fixtures with a stubbed mint — deterministic, no live network. `runSubscribe`
 * adds the full store-leased orchestration around it.
 */

import type { Page } from "playwright";
import type { TargetStore, TargetRow } from "./store.ts";
import type { Status } from "./state.ts";
import { personaForDomain, type Persona } from "./persona.ts";
import { brandSlugFromDomain } from "./canonical.ts";
import type { AddressResponse, BrandInput } from "./archive-client.ts";
import { extractCandidates, rankCandidates, type FieldCandidate, type Esp } from "./form-finder.ts";
import { classifyOutcome, type Outcome } from "./outcome.ts";
import { BrowserWorker } from "./browser/worker.ts";

/** Injected mint boundary — stubbed in tests, ArchiveClient.mintAddress in prod. */
export type MintFn = (brand: BrandInput, personaHandle?: string) => Promise<AddressResponse>;

/** Slugified persona handle → the persona-flavored, brand-keyed mint (oliviasmith). */
export function personaHandle(p: Persona): string {
  return (p.firstName + p.lastName).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface SubscribeOnPageOptions {
  /** Mint a fresh address for the target's brand. */
  mint: MintFn;
  /** The synthetic persona for this target (A0, deterministic by domain). */
  persona: Persona;
  /** Registrable domain (for brand slug + diagnostics). */
  domain: string;
  /** Brand metadata to pass to mint, if known. */
  brandName?: string | undefined;
  category?: string | undefined;
}

export interface SubscribeOutcome {
  /** The state we resolved to (a legal A0 transition target from `attempting`). */
  status: Extract<Status, "submitted" | "needs_solver" | "no_form_found" | "needs_attention">;
  /** Why, for logging / last_error. */
  reason: string;
  /** ESP detected on the chosen form (when a form was found). */
  esp?: Esp;
  /** The minted address (when we got far enough to mint). */
  address?: string | undefined;
  addressId?: number | undefined;
  /** Raw outcome classification of the final submit (when we submitted). */
  outcome?: Outcome;
  /** How many submit attempts were made (1 or 2). */
  attempts?: number;
}

// ── In-page snapshot scripts (serializable, no closures) ───────────────────────

/** Detect a CAPTCHA / anti-bot widget in the page. Runs in-page. */
function detectCaptchaWidget(): boolean {
  const SEL = [
    ".cf-turnstile",
    "[data-sitekey]",
    ".h-captcha",
    "iframe[src*='hcaptcha.com']",
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='recaptcha']",
    "iframe[src*='google.com/recaptcha']",
    ".g-recaptcha",
    "#g-recaptcha",
    "[class*='turnstile']",
    "[id*='turnstile']",
  ].join(", ");
  const els = Array.from(document.querySelectorAll(SEL));
  return els.length > 0;
}

/** Build the post-submit page snapshot for outcome classification. Runs in-page. */
function pageSnapshot(filledFieldId: string): {
  bodyText: string;
  hasCaptchaWidget: boolean;
  hasValidationError: boolean;
  emailFieldStillPresent: boolean;
} {
  const lc = (s: string | null | undefined): string => (s ?? "").toLowerCase();

  // Visible body text (cap length so classification stays cheap + deterministic).
  const bodyText = lc(document.body ? document.body.innerText : "").slice(0, 5000);

  const captchaSel = [
    ".cf-turnstile",
    "[data-sitekey]",
    ".h-captcha",
    "iframe[src*='hcaptcha.com']",
    "iframe[src*='challenges.cloudflare.com']",
    "iframe[src*='recaptcha']",
    ".g-recaptcha",
    "[class*='turnstile']",
    "[id*='turnstile']",
  ].join(", ");
  const hasCaptchaWidget = document.querySelectorAll(captchaSel).length > 0;

  // Visible validation/error nodes.
  const errSel = [
    "[role='alert']",
    "[aria-invalid='true']",
    ".error",
    ".invalid",
    ".field-error",
    "[class*='error']",
    "[class*='invalid']",
    ".mce_inline_error",
    ".validation-message",
  ].join(", ");
  let hasValidationError = false;
  for (const el of Array.from(document.querySelectorAll(errSel))) {
    const he = el as HTMLElement;
    const style = window.getComputedStyle(he);
    const rect = he.getBoundingClientRect();
    const visible =
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0;
    if (visible && (he.innerText ?? "").trim() !== "") {
      hasValidationError = true;
      break;
    }
  }

  // Is the field we filled still present + visible (i.e. the form didn't advance)?
  let emailFieldStillPresent = false;
  const field = document.querySelector(`[data-trove-fc='${filledFieldId}']`) as HTMLElement | null;
  if (field) {
    const style = window.getComputedStyle(field);
    const rect = field.getBoundingClientRect();
    emailFieldStillPresent =
      style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  return { bodyText, hasCaptchaWidget, hasValidationError, emailFieldStillPresent };
}

// ── Fill helpers ────────────────────────────────────────────────────────────────

/**
 * Map a sibling field to the persona value it should receive, or null to leave
 * it blank. We fill ONLY required persona fields the form actually asks for —
 * never volunteering data (handoff step 3: "Fill required persona fields only;
 * leave optional fields blank").
 *
 * Pure + exported for unit testing.
 */
export function personaValueForField(field: FieldCandidate, persona: Persona): string | null {
  const hint = `${field.name} ${field.elementId} ${field.placeholder} ${field.ariaLabel} ${field.labelText} ${field.autocomplete}`;
  if (/first[\s_-]?name|fname|given/.test(hint)) return persona.firstName;
  if (/last[\s_-]?name|lname|surname|family/.test(hint)) return persona.lastName;
  if (/full[\s_-]?name|your[\s_-]?name|^name$|\bname\b/.test(hint)) return persona.fullName;
  if (/zip|postal|post[\s_-]?code/.test(hint)) return persona.postalCode;
  if (/city|town/.test(hint)) return persona.city;
  if (/state|province|region/.test(hint)) return persona.state;
  if (/birth|dob|bday/.test(hint)) return persona.dateOfBirth;
  return null;
}

// ── The core loop on an open page ───────────────────────────────────────────────

/**
 * Run the subscribe attempt against an already-open page. Returns the resolved
 * status + diagnostics. Does NOT touch the store (the caller owns that), so this
 * is the unit the gate drives against fixtures.
 */
export async function subscribeOnPage(
  page: Page,
  opts: SubscribeOnPageOptions,
): Promise<SubscribeOutcome> {
  const { mint, persona, domain } = opts;

  // 0. Anti-bot wall up front — if we're walled before we even find a form,
  //    park immediately (do not fight it).
  const walledEarly = await page.evaluate(detectCaptchaWidget).catch(() => false);
  if (walledEarly) {
    return { status: "needs_solver", reason: "captcha/anti-bot wall detected (pre-form)" };
  }

  // 1. Find the newsletter email field (pure ranking over the DOM snapshot).
  const candidates = await page.evaluate(extractCandidates).catch(() => [] as FieldCandidate[]);
  const pick = rankCandidates(candidates);
  if (!pick) {
    return { status: "no_form_found", reason: "no newsletter email field found" };
  }

  // 2. Mint a fresh address (one per subscription).
  const brand: BrandInput = {
    slug: brandSlugFromDomain(domain),
    name: opts.brandName,
    primary_domain: domain,
    category: opts.category,
  };
  const minted = await mint(brand, personaHandle(persona));
  const address = minted.address;

  // Ground-truth success signal: watch the ESP's subscribe-request RESPONSE. Page-copy
  // heuristics are unreliable — popups close on success with no persistent "check your
  // email" text (→ a real 2xx looks like `unknown` → needs_attention), and a silently
  // dropped submit looks identical to one the server 403'd. The network verdict is
  // authoritative: a 2xx on a subscribe endpoint = submitted; 401/403/429 = a bot wall.
  // Scoped to real subscribe endpoints (NOT analytics pings like /onsite/track-analytics).
  const SUBSCRIBE_RE =
    /\/client\/subscriptions|kmail-lists\.com\/ajax\/subscriptions|list-manage\.com\/subscribe|omnisend\.com\/.*subscri|attentivemobile\.com\/.*(subscri|signup)|sendlane\.com\/.*subscri|\/forms\/[^/]+\/submit|\/subscribe(?:\b|\/|\?)/i;
  let netVerdict: "success" | "blocked" | null = null;
  page.on("response", (resp) => {
    try {
      if (!SUBSCRIBE_RE.test(resp.url())) return;
      const s = resp.status();
      if (s >= 200 && s < 300) netVerdict = "success";
      else if (s === 401 || s === 403 || s === 429) netVerdict = netVerdict ?? "blocked";
    } catch {
      /* never let an observer break the attempt */
    }
  });

  // Two submit attempts max: a validation error gets ONE corrected retry.
  let lastOutcome: Outcome = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 3. Fill — email = minted address; required persona fields; required consent.
    await fillEmail(page, pick.candidate.id, address);
    await fillSiblings(page, pick.siblings, persona);
    await tickRequiredConsent(page, pick.candidate.id);

    // 4. Submit + settle. Give the subscribe XHR a beat to land before we judge.
    await submitForm(page, pick.candidate.id);
    await page.waitForTimeout(600);
    if (netVerdict === null) await page.waitForTimeout(1_200);

    // Network verdict wins when we have it (authoritative over page copy).
    if (netVerdict === "success") {
      return {
        status: "submitted",
        reason: "subscribe request acknowledged (2xx)",
        esp: pick.esp,
        address,
        addressId: minted.id,
        outcome: "success",
        attempts: attempt,
      };
    }
    if (netVerdict === "blocked") {
      return {
        status: "needs_solver",
        reason: "subscribe request blocked (bot wall: 401/403/429)",
        esp: pick.esp,
        address,
        addressId: minted.id,
        outcome: "captcha",
        attempts: attempt,
      };
    }

    const snap = await page.evaluate(pageSnapshot, pick.candidate.id).catch(() => ({
      bodyText: "",
      hasCaptchaWidget: false,
      hasValidationError: false,
      emailFieldStillPresent: true,
    }));
    lastOutcome = classifyOutcome(snap);

    if (lastOutcome === "captcha") {
      return {
        status: "needs_solver",
        reason: "captcha/anti-bot wall detected (post-submit)",
        esp: pick.esp,
        address,
        addressId: minted.id,
        outcome: lastOutcome,
        attempts: attempt,
      };
    }
    if (lastOutcome === "success") {
      return {
        status: "submitted",
        reason: "submitted; confirmation expected",
        esp: pick.esp,
        address,
        addressId: minted.id,
        outcome: lastOutcome,
        attempts: attempt,
      };
    }
    // validation_error / unknown → retry once (attempt 1), else fall through.
  }

  // Still not successful after the retry → park for attention.
  return {
    status: "needs_attention",
    reason: `submit did not confirm after retry (last outcome: ${lastOutcome})`,
    esp: pick.esp,
    address,
    addressId: minted.id,
    outcome: lastOutcome,
    attempts: 2,
  };
}

async function fillEmail(page: Page, fieldId: string, address: string): Promise<void> {
  const sel = `[data-trove-fc='${fieldId}']`;
  const loc = page.locator(sel);
  // Real keystrokes first. React-controlled inputs (Klaviyo & most modern ESP popups)
  // IGNORE a programmatic value set (page.fill): React's own value setter shadows it, so
  // the component's state stays empty and the submit handler silently no-ops — no
  // subscription request fires, the field persists → needs_attention. pressSequentially
  // dispatches trusted per-key events React honors. Plain inputs accept this fine too.
  // (Measured: a store that no-opped under page.fill POSTed /subscribe → 200 under typing.)
  try {
    await loc.click({ timeout: 3_000 });
    await loc.fill("", { timeout: 2_000 }).catch(() => {}); // clear any prefill
    await loc.pressSequentially(address, { delay: 12, timeout: 8_000 });
  } catch {
    // Custom widget that rejects focus/typing → fall back to a plain value set.
    await page.fill(sel, address, { timeout: 5_000 }).catch(() => {});
  }
}

async function fillSiblings(page: Page, siblings: FieldCandidate[], persona: Persona): Promise<void> {
  for (const sib of siblings) {
    const value = personaValueForField(sib, persona);
    if (value === null) continue; // leave optional/unknown fields blank
    const sel = `[data-trove-fc='${sib.id}']`;
    await page.fill(sel, value, { timeout: 3_000 }).catch(() => {});
  }
}

/**
 * Tick ONLY *required* consent checkboxes inside the chosen form. Never tick an
 * optional box (that would opt into more than the newsletter — cardinal rule).
 *
 * "Required" = the checkbox carries `required` / `aria-required=true`. We do
 * this in-page in one pass to keep it atomic + cheap.
 */
async function tickRequiredConsent(page: Page, fieldId: string): Promise<void> {
  await page
    .evaluate((fid: string) => {
      const field = document.querySelector(`[data-trove-fc='${fid}']`);
      const form = field ? field.closest("form") : null;
      const scope: ParentNode = form ?? document;
      const boxes = Array.from(scope.querySelectorAll("input[type='checkbox']")) as HTMLInputElement[];
      for (const box of boxes) {
        const required =
          box.required ||
          box.getAttribute("aria-required") === "true" ||
          box.hasAttribute("required");
        if (required && !box.checked) {
          box.checked = true;
          box.dispatchEvent(new Event("change", { bubbles: true }));
          box.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }, fieldId)
    .catch(() => {});
}

/**
 * Submit the chosen form: prefer clicking its submit control; fall back to
 * pressing Enter in the email field (covers single-input footer forms).
 */
async function submitForm(page: Page, fieldId: string): Promise<void> {
  const submitted = await page
    .evaluate((fid: string) => {
      const field = document.querySelector(`[data-trove-fc='${fid}']`) as HTMLElement | null;
      const form = field ? field.closest("form") : null;
      // Scope: the form, else the enclosing ESP popup container (Klaviyo/Privy popups
      // sometimes wrap the input in a div, not a <form>).
      const container =
        form ||
        (field &&
          (field.closest('[class*="klaviyo-form-"], [class*="needsclick"]') ||
            field.closest("[role='dialog'], [class*='modal'], [class*='popup']"))) ||
        null;
      // 1) A native submit control.
      let btn =
        (form &&
          (form.querySelector(
            "button[type='submit'], input[type='submit'], button:not([type])",
          ) as HTMLElement | null)) ||
        null;
      // 2) Else a submit-INTENT button in the container (Klaviyo & co. use JS-handled
      //    buttons with no type='submit'). Pick the last intent-match, exclude close/dismiss.
      if (!btn && container) {
        const cands = Array.from(
          container.querySelectorAll("button, input[type='submit'], [role='button']"),
        ) as HTMLElement[];
        const intent =
          /subscribe|sign\s?up|join|notify|continue|submit|count me|claim|unlock|get\b|yes\b|→|›|»/i;
        const close = /close|no thanks|dismiss|skip|cancel|maybe later|×|✕|✖/i;
        const txt = (b: HTMLElement): string =>
          `${b.textContent ?? ""} ${(b as HTMLInputElement).value ?? ""} ${b.getAttribute("aria-label") ?? ""}`;
        btn =
          cands.reverse().find((b) => intent.test(txt(b)) && !close.test(txt(b))) ||
          cands.find((b) => !close.test(txt(b))) ||
          null;
      }
      if (btn) {
        btn.setAttribute("data-trove-submit", "1");
        return true;
      }
      return false;
    }, fieldId)
    .catch(() => false);

  if (submitted) {
    await page.click("[data-trove-submit='1']", { timeout: 5_000 }).catch(async () => {
      await page.press(`[data-trove-fc='${fieldId}']`, "Enter", { timeout: 3_000 }).catch(() => {});
    });
  } else {
    await page.press(`[data-trove-fc='${fieldId}']`, "Enter", { timeout: 3_000 }).catch(() => {});
  }
}

// ── Full store-leased orchestration ──────────────────────────────────────────────

export interface RunSubscribeOptions {
  store: TargetStore;
  mint: MintFn;
  workerId: string;
  /**
   * Target a SPECIFIC domain (the single-target manual path). When omitted, the
   * loop leases the next queued target. Either way the same one-in-flight rule
   * applies.
   */
  domain?: string;
  /** Resolve a target domain to its page URL. Defaults to `https://<domain>/`. */
  urlForDomain?: (domain: string) => string;
  /** Inject a pre-built worker (tests reuse one chromium across cases). */
  worker?: BrowserWorker;
  /** Lease TTL (ms). */
  leaseTtlMs?: number;
  /** Override the per-domain persona (e.g. a single fixed identity for a smoke run). */
  persona?: Persona;
}

export interface RunSubscribeResult {
  /** null when there was nothing queued to lease. */
  domain: string | null;
  status?: TargetRow["status"];
  reason?: string;
  esp?: Esp;
  address?: string | undefined;
}

/**
 * Lease the next queued target and run the full subscribe loop end-to-end,
 * persisting the resolved status to the store. This is what the CLI
 * `subscribe`/`subscribe:live` commands call.
 *
 * Single-target: leases ONE target (respecting A0's one-in-flight-per-domain),
 * runs it, releases via a state transition. A transient/unexpected error falls
 * the lease back to `queued` (legal transition) so it can be retried later —
 * never leaves a target stranded in `attempting`.
 */
export async function runSubscribe(opts: RunSubscribeOptions): Promise<RunSubscribeResult> {
  const { store, mint, workerId } = opts;
  const urlFor = opts.urlForDomain ?? ((d: string) => `https://${d}/`);

  const leased = opts.domain
    ? store.leaseDomain(opts.domain, workerId, opts.leaseTtlMs)
    : store.leaseNext(workerId, opts.leaseTtlMs);
  if (!leased) return { domain: null };

  const domain = leased.domain;
  const persona = opts.persona ?? personaForDomain(domain);
  const ownWorker = opts.worker ?? new BrowserWorker();
  const ownsWorker = !opts.worker;

  try {
    const { page } = await ownWorker.openPage(urlFor(domain), persona);
    try {
      const result = await subscribeOnPage(page, {
        mint,
        persona,
        domain,
        brandName: leased.brand_name ?? undefined,
        category: leased.category ?? undefined,
      });

      store.setStatus(domain, result.status, {
        lastError: result.status === "submitted" ? null : result.reason,
        address: result.address ?? null,
        addressId: result.addressId ?? null,
      });

      return {
        domain,
        status: result.status,
        reason: result.reason,
        esp: result.esp,
        address: result.address,
      };
    } finally {
      await ownWorker.closePage(page);
    }
  } catch (err) {
    // Transient/unexpected failure: fall the lease back to queued for a later
    // attempt (legal attempting → queued). Never strand the target.
    const message = err instanceof Error ? err.message : String(err);
    try {
      store.setStatus(domain, "queued", { lastError: `subscribe error: ${message}` });
    } catch {
      // if even that fails, the lease TTL will auto-release the row
    }
    return { domain, status: "queued", reason: `error: ${message}` };
  } finally {
    if (ownsWorker) await ownWorker.close();
  }
}
