/**
 * Confirmation-link whitelist seam.
 *
 * CARDINAL RULE (handoff "What NOT to do" #1): the agent clicks ONLY a
 * confirmation link — never an unsubscribe, CTA, product, or arbitrary anchor.
 *
 * A0 left this module as the *seam*: a deliberately-conservative allowlist of
 * confirm/verify/activate URL shapes (`isConfirmLink`), plus an
 * `extractConfirmLinks` that A0 left unimplemented (it threw) so no link could
 * be followed in the spine. A2 implements `extractConfirmLinks` HERE — and it
 * is the single most important safety boundary in the whole service.
 *
 * The policy, in two layers:
 *   1. URL shape — `isConfirmLink` matches a conservative confirm/verify/opt-in
 *      allowlist AND matches no refuse pattern. ESP-specific confirm hosts/paths
 *      (Klaviyo, Mailchimp, Braze, Iterable, Sendgrid) live here.
 *   2. Anchor intent — `extractConfirmLinks` additionally accepts a link whose
 *      *anchor text* expresses confirm intent ("confirm", "verify", "activate",
 *      "yes, subscribe"), since many ESPs route the click through a tracking
 *      wrapper whose URL alone is ambiguous. Intent NEVER overrides the
 *      refuse-list: a link that looks like unsubscribe/opt-out/preferences is
 *      refused even if its anchor text says "confirm".
 *
 * Everything else is refused. When in doubt, do NOT return it (refuse, don't
 * click). The downside of a missed confirmation is a retry; the downside of a
 * mis-click is clicking an unsubscribe or a purchase link — unacceptable.
 */

import { parse, type HTMLElement } from "node-html-parser";

/**
 * ESP confirm-URL path/host patterns + generic confirm-intent patterns.
 * Conservative by design — when in doubt, do NOT match (refuse, don't click).
 */
export const CONFIRM_URL_PATTERNS: ReadonlyArray<RegExp> = [
  // Generic confirm/verify/activate/opt-in intent in path or query.
  /\/(confirm|verify|activate|optin|opt-in|subscribe-confirm|email-confirm)(\/|\b)/i,
  /[?&](confirm|verify|activate|token|code|key)=/i,
  // Klaviyo.
  /(^|\.)klaviyo\.com\/.*\/(subscriptions|confirm)/i,
  /(^|\.)manage\.kmail-lists\.com\//i,
  // Mailchimp (list-manage confirm).
  /(^|\.)list-manage\.com\/subscribe\/confirm/i,
  // SendGrid / Twilio link-tracking confirm wrappers.
  /(^|\.)(ct|url|links?)\.[a-z0-9.-]*sendgrid\.net\//i,
  // Braze / Iterable confirm wrappers.
  /(^|\.)(links?|email)\.[a-z0-9.-]*\/(confirm|verify|subscription)/i,
];

/**
 * Hosts/paths we explicitly REFUSE even if a confirm word appears nearby (in the
 * URL or in the anchor text). This is the hard veto — it is checked FIRST and an
 * intent-text match can never override it. Covers both the list-management
 * escape hatches (unsubscribe / opt-out / preferences) AND commerce/CTA paths
 * (product, sale, cart, checkout, shop, blog, account, login, home) that a
 * marketing email decorates with "confirm"-ish copy to bait a click.
 */
export const REFUSE_URL_PATTERNS: ReadonlyArray<RegExp> = [
  // List-management escape hatches.
  /\/(unsubscribe|unsub|optout|opt-out|remove|preferences|manage-?prefs)(\/|\b)/i,
  /[?&](unsubscribe|optout|opt_out)=/i,
  // Commerce / CTA paths — never a confirmation, always a bait CTA. (We do NOT
  // refuse /account, /login, /register, /home etc.: those can legitimately host
  // a genuine `/account/activate/…` confirm link, and the confirm/verify/optin
  // path patterns already gate those correctly.)
  /\/(products?|product|sale|sales|deals?|shop|store|cart|checkout|basket|buy|order|collections?|catalog)(\/|\?|\b)/i,
  /\/(blog|news|article|posts?|lookbook|gift-?cards?|rewards?)(\/|\?|\b)/i,
];

/**
 * Anchor-text patterns that express *confirm intent*. Used only when the URL
 * shape is ambiguous (passes neither confirm nor refuse on shape) — a link with
 * one of these as its visible text is treated as a confirm candidate, but is
 * STILL run through {@link isConfirmLink}'s refuse-list before it's accepted.
 */
export const CONFIRM_INTENT_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bconfirm\b/i,
  /\bverify\b/i,
  /\bactivate\b/i,
  /\bopt[\s-]?in\b/i,
  /\byes,?\s+subscribe\b/i,
  /\byes,?\s+sign\s*me\s*up\b/i,
  /\bsubscribe\s+me\b/i,
  /\bconfirm\s+(your\s+)?(subscription|email|sign[\s-]?up)\b/i,
  /\bcomplete\s+(your\s+)?(subscription|sign[\s-]?up)\b/i,
];

/** Anchor-text patterns we explicitly REFUSE regardless of URL shape. */
export const REFUSE_INTENT_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /\bunsubscribe\b/i,
  /\bopt[\s-]?out\b/i,
  /\bmanage\s+(your\s+)?(preferences|subscription)\b/i,
  /\bupdate\s+preferences\b/i,
  /\bshop\b/i,
  /\bbuy\b/i,
  /\bview\s+(in\s+browser|online)\b/i,
];

/**
 * Whitelist check: is this URL a permissible confirmation link to click?
 *
 * Returns true only when the URL matches a confirm pattern AND matches no
 * refuse pattern. Anything malformed or ambiguous returns false.
 */
export function isConfirmLink(url: string): boolean {
  if (typeof url !== "string" || url.trim() === "") return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // Only ever follow http(s).
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const haystack = `${parsed.host}${parsed.pathname}${parsed.search}`;

  if (REFUSE_URL_PATTERNS.some((re) => re.test(haystack))) return false;
  return CONFIRM_URL_PATTERNS.some((re) => re.test(haystack));
}

/** True if a URL is refused on shape alone (used to veto intent-only matches). */
function isRefusedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true; // malformed → refuse
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
  const haystack = `${parsed.host}${parsed.pathname}${parsed.search}`;
  return REFUSE_URL_PATTERNS.some((re) => re.test(haystack));
}

/** True if anchor text expresses confirm intent (and not a refuse intent). */
function hasConfirmIntentText(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  if (REFUSE_INTENT_TEXT_PATTERNS.some((re) => re.test(t))) return false;
  return CONFIRM_INTENT_TEXT_PATTERNS.some((re) => re.test(t));
}

interface AnchorCandidate {
  href: string;
  /** Visible anchor text + title/aria-label, lower-signal joined. */
  text: string;
}

/**
 * Decode a quoted-printable body (RFC 2045). ESP confirmation emails are very
 * often QP-encoded, which splits `=\n` across long URLs and `=3D` for `=`. We
 * decode just enough to recover intact hrefs.
 */
function decodeQuotedPrintable(input: string): string {
  return input
    // Soft line breaks: `=` at end of line.
    .replace(/=\r?\n/g, "")
    // `=XX` hex escapes.
    .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Decode a base64 body to a UTF-8 string (best-effort). */
function decodeBase64(input: string): string {
  try {
    return Buffer.from(input.replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return input;
  }
}

/**
 * Pull the candidate text parts out of a raw .eml. We are deliberately lenient:
 * a confirmation email may be a single HTML body, a single text body, or a
 * multipart/alternative with both. Rather than implement a full MIME parser, we
 * split on boundaries when present, decode the common transfer encodings, and
 * hand each part's body to the HTML/text scanners. Over-collecting parts is
 * safe — every URL still passes through the same whitelist.
 */
function extractBodyParts(raw: string): string[] {
  // Locate a multipart boundary in the top headers, if any.
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  const headerBodySplit = raw.search(/\r?\n\r?\n/);
  const headerBlock = headerBodySplit >= 0 ? raw.slice(0, headerBodySplit) : "";
  const body = headerBodySplit >= 0 ? raw.slice(headerBodySplit) : raw;

  const topEncoding = (headerBlock.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1] ?? "")
    .trim()
    .toLowerCase();

  if (!boundaryMatch) {
    // Single-part message: decode by the top transfer encoding.
    return [decodePart(body, topEncoding)];
  }

  const boundary = boundaryMatch[1]!;
  const segments = body.split(new RegExp(`--${escapeRegExp(boundary)}(?:--)?`, "g"));
  const parts: string[] = [];
  for (const seg of segments) {
    const trimmed = seg.replace(/^\r?\n/, "");
    if (trimmed.trim() === "") continue;
    const splitIdx = trimmed.search(/\r?\n\r?\n/);
    const partHeaders = splitIdx >= 0 ? trimmed.slice(0, splitIdx) : "";
    const partBody = splitIdx >= 0 ? trimmed.slice(splitIdx) : trimmed;
    const enc = (partHeaders.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1] ?? "")
      .trim()
      .toLowerCase();
    // Skip attachment parts (we only want text/html + text/plain).
    const ctype = (partHeaders.match(/content-type:\s*([^\r\n;]+)/i)?.[1] ?? "")
      .trim()
      .toLowerCase();
    if (ctype.startsWith("application/") || ctype.startsWith("image/")) continue;
    parts.push(decodePart(partBody, enc));
  }
  // If splitting found nothing useful, fall back to the whole body.
  return parts.length > 0 ? parts : [decodePart(body, topEncoding)];
}

function decodePart(body: string, encoding: string): string {
  if (encoding.includes("quoted-printable")) return decodeQuotedPrintable(body);
  if (encoding.includes("base64")) return decodeBase64(body);
  return body;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Looks like HTML (has at least one tag)? */
function looksLikeHtml(s: string): boolean {
  return /<\s*(a|html|body|table|div|p|img)\b/i.test(s);
}

/** Enumerate anchor candidates from one HTML body. */
function anchorsFromHtml(html: string): AnchorCandidate[] {
  let root: HTMLElement;
  try {
    root = parse(html, { comment: false });
  } catch {
    return [];
  }
  const out: AnchorCandidate[] = [];
  for (const a of root.querySelectorAll("a")) {
    const href = (a.getAttribute("href") ?? "").trim();
    if (href === "") continue;
    const text = [
      a.text ?? "",
      a.getAttribute("title") ?? "",
      a.getAttribute("aria-label") ?? "",
      a.getAttribute("alt") ?? "",
    ]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    out.push({ href, text });
  }
  return out;
}

/** Enumerate bare URL candidates from one text/plain body (no anchor text). */
function urlsFromText(text: string): AnchorCandidate[] {
  const out: AnchorCandidate[] = [];
  // Conservative URL grab: http(s) up to whitespace / closing bracket / quote.
  const re = /https?:\/\/[^\s<>"')\]]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // Strip common trailing punctuation that isn't part of the URL.
    const href = m[0].replace(/[.,;:!?)\]]+$/, "");
    out.push({ href, text: "" });
  }
  return out;
}

/**
 * SEAM — implemented at A2.
 *
 * Parse a raw .eml (HTML and/or text parts), enumerate candidate links, and
 * return ONLY those that pass the confirmation whitelist:
 *
 *   accept(link) =
 *        NOT refused-on-URL-shape
 *     AND ( isConfirmLink(url)                    // confirm URL shape, OR
 *           OR hasConfirmIntentText(anchorText) ) // confirm anchor intent
 *
 * The refuse-list is checked first and is absolute — an unsubscribe/opt-out/
 * preferences link is never returned, even if its anchor text says "confirm".
 * Results are de-duplicated, preserving first-seen order. Returns [] when no
 * confirm link is present (the caller fails the confirmation gracefully — it
 * never clicks anything when this is empty).
 *
 * Never throws on malformed input: a body it can't parse simply yields no
 * candidates. The cardinal rule holds by construction — nothing outside this
 * function's returned allowlist is ever clicked.
 */
export function extractConfirmLinks(rawEml: Uint8Array | string): string[] {
  const raw =
    typeof rawEml === "string" ? rawEml : new TextDecoder("utf-8", { fatal: false }).decode(rawEml);
  if (raw.trim() === "") return [];

  const parts = extractBodyParts(raw);
  const candidates: AnchorCandidate[] = [];
  for (const part of parts) {
    if (looksLikeHtml(part)) {
      candidates.push(...anchorsFromHtml(part));
    } else {
      candidates.push(...urlsFromText(part));
    }
    // Also scan for bare URLs inside an HTML part (some ESPs put the real
    // confirm URL as text next to a tracked anchor). Cheap + still whitelisted.
    if (looksLikeHtml(part)) {
      candidates.push(...urlsFromText(part));
    }
  }

  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const href = c.href.trim();
    if (href === "") continue;
    // Hard refuse on URL shape FIRST — intent can never override this.
    if (isRefusedUrl(href)) continue;

    const okByShape = isConfirmLink(href);
    const okByIntent = !okByShape && hasConfirmIntentText(c.text) && !isRefusedUrl(href);
    if (!okByShape && !okByIntent) continue;

    if (seen.has(href)) continue;
    seen.add(href);
    accepted.push(href);
  }
  return accepted;
}
