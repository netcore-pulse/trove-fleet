/**
 * Submission-outcome detection — pure heuristics over a page snapshot.
 *
 * After we submit a signup form, we must classify what happened (handoff "The
 * subscribe loop" step 4):
 *   success / "check your email"   -> submitted
 *   validation error               -> retry once, then needs_attention
 *   CAPTCHA / anti-bot wall         -> needs_solver (detect, do NOT solve)
 *
 * The classification is a PURE function ({@link classifyOutcome}) over a plain
 * {@link PageSnapshot}, so every branch is unit-tested without a browser. The
 * subscribe loop takes the live page snapshot and feeds it through here.
 */

export type Outcome = "success" | "validation_error" | "captcha" | "unknown";

/** Serializable snapshot of post-submit page signals. */
export interface PageSnapshot {
  /** Visible body text (lowercased), trimmed to a sane length upstream. */
  bodyText: string;
  /** True if a CAPTCHA / anti-bot widget is present (Turnstile/hCaptcha/reCAPTCHA). */
  hasCaptchaWidget: boolean;
  /** True if a visible inline validation/error message is present. */
  hasValidationError: boolean;
  /** True if the email input we filled is still present + visible on the page. */
  emailFieldStillPresent: boolean;
}

// Success copy the major ESPs and DIY forms show after a double-opt-in signup.
const SUCCESS_TEXT =
  /check\s+your\s+(e-?mail|inbox)|confirm\s+your\s+subscription|confirm\s+your\s+(e-?mail|sign[\s_-]?up)|almost\s+(there|done)|one\s+more\s+step|we['’]?ve\s+sent|just\s+sent\s+you|please\s+confirm|verification\s+(e-?mail|link)\s+sent|thanks?\s+for\s+(subscribing|signing\s+up)|you['’]?re\s+(almost\s+)?(subscribed|signed\s+up|on\s+the\s+list)|successfully\s+subscribed|subscription\s+confirmed|welcome\s+to\s+(the\s+)?(list|family|club)|check\s+your\s+email\s+to\s+confirm/i;

// Validation / error copy.
const VALIDATION_TEXT =
  /please\s+enter\s+a\s+valid|invalid\s+e-?mail|enter\s+a\s+valid\s+e-?mail|valid\s+email\s+address|this\s+field\s+is\s+required|required\s+field|please\s+fill|isn['’]?t\s+valid|not\s+a\s+valid|please\s+provide|enter\s+your\s+email|email\s+is\s+required|whoops|something\s+went\s+wrong/i;

// CAPTCHA / anti-bot copy (a textual backstop to the widget flag).
const CAPTCHA_TEXT =
  /are\s+you\s+(a\s+)?human|verify\s+you\s+are\s+(a\s+)?human|i['’]?m\s+not\s+a\s+robot|complete\s+the\s+captcha|security\s+check|cloudflare|turnstile|hcaptcha|recaptcha|prove\s+you['’]?re\s+(not\s+)?(a\s+)?(robot|bot)/i;

/**
 * Classify the post-submit outcome. PURE + DETERMINISTIC.
 *
 * Precedence is deliberate:
 *  1. CAPTCHA/anti-bot first — if a wall is up, that's the story regardless of
 *     any leftover copy; we must park, not retry (handoff: detect → move on).
 *  2. Success — explicit confirmation/“check your email” copy.
 *  3. Validation error — error copy, OR the email field still sitting there
 *     un-consumed (a strong "it didn't take" signal) with no success copy.
 *  4. Unknown — none of the above; the caller treats this like a soft failure
 *     (retry once, then needs_attention) rather than a false success.
 */
export function classifyOutcome(snap: PageSnapshot): Outcome {
  const text = snap.bodyText ?? "";

  if (snap.hasCaptchaWidget || CAPTCHA_TEXT.test(text)) return "captcha";
  if (SUCCESS_TEXT.test(text)) return "success";
  if (snap.hasValidationError || VALIDATION_TEXT.test(text)) return "validation_error";

  // No explicit success copy and the field is still there → it didn't take.
  if (snap.emailFieldStillPresent) return "validation_error";

  return "unknown";
}
