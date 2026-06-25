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

  // Two submit attempts max: a validation error gets ONE corrected retry.
  let lastOutcome: Outcome = "unknown";
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 3. Fill — email = minted address; required persona fields; required consent.
    await fillEmail(page, pick.candidate.id, address);
    await fillSiblings(page, pick.siblings, persona);
    await tickRequiredConsent(page, pick.candidate.id);

    // 4. Submit + settle, then classify.
    await submitForm(page, pick.candidate.id);
    await page.waitForTimeout(600);

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
  await page.fill(sel, address, { timeout: 5_000 }).catch(async () => {
    // Some inputs reject .fill (custom widgets) — fall back to type.
    await page.click(sel, { timeout: 3_000 }).catch(() => {});
    await page.type(sel, address, { timeout: 3_000 }).catch(() => {});
  });
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
      if (!form) return false;
      const btn = form.querySelector(
        "button[type='submit'], input[type='submit'], button:not([type])",
      ) as HTMLElement | null;
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
