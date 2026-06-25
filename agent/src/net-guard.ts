/**
 * SSRF guard for the confirm clicker (forward-pass H2 / L22).
 *
 * The agent clicks confirm links lifted from confirmation emails — i.e. from
 * hostile, attacker-controlled HTML. A confirm-shaped URL could point at an
 * internal address (cloud metadata 169.254.169.254, localhost, RFC1918) and the
 * clicker would fetch it from inside the agent's infra. The confirm-link
 * whitelist only checks URL *shape*; this adds the host-safety layer:
 *
 *   - http(s) only
 *   - reject IP-literal hosts in private/reserved ranges
 *   - resolve DNS names and reject if ANY resolved address is private/reserved
 *     (closes the rebinding gap at click time)
 *
 * Used on the initial URL AND every redirect hop (the http clicker follows
 * redirects manually so each Location is re-validated).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Private / reserved CIDR ranges, IPv4 + IPv6. Stored as [networkBigInt, bits, v6].
type Range = { net: bigint; bits: number; v6: boolean };

function ipToBigInt(ip: string, v6: boolean): bigint {
  if (!v6) {
    const parts = ip.split(".").map((p) => BigInt(parseInt(p, 10)));
    return (parts[0]! << 24n) | (parts[1]! << 16n) | (parts[2]! << 8n) | parts[3]!;
  }
  // Expand an IPv6 address (handles :: and embedded IPv4) to a 128-bit BigInt.
  let s = ip;
  const v4Embed = s.match(/(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Embed) {
    const v4 = ipToBigInt(v4Embed[2]!, false);
    const hi = (v4 >> 16n) & 0xffffn;
    const lo = v4 & 0xffffn;
    s = `${v4Embed[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const headGroups = head ? head.split(":").filter(Boolean) : [];
  const tailGroups = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(Math.max(0, missing)).fill("0"), ...tailGroups];
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g || "0", 16));
  return n;
}

function cidr(ip: string, bits: number, v6: boolean): Range {
  return { net: ipToBigInt(ip, v6), bits, v6 };
}

const BLOCKED: Range[] = [
  cidr("0.0.0.0", 8, false),
  cidr("10.0.0.0", 8, false),
  cidr("100.64.0.0", 10, false),
  cidr("127.0.0.0", 8, false),
  cidr("169.254.0.0", 16, false), // link-local incl. cloud metadata
  cidr("172.16.0.0", 12, false),
  cidr("192.0.0.0", 24, false),
  cidr("192.168.0.0", 16, false),
  cidr("198.18.0.0", 15, false),
  cidr("224.0.0.0", 4, false),
  cidr("240.0.0.0", 4, false),
  cidr("::1", 128, true),
  cidr("::", 128, true),
  cidr("fc00::", 7, true),
  cidr("fe80::", 10, true),
];

function ipBlocked(ip: string): boolean {
  const v6 = isIP(ip) === 6;
  let n: bigint;
  try {
    n = ipToBigInt(ip, v6);
  } catch {
    return true; // unparseable → fail closed
  }
  const total = v6 ? 128 : 32;
  for (const r of BLOCKED) {
    if (r.v6 !== v6) continue;
    const shift = BigInt(total - r.bits);
    if (n >> shift === r.net >> shift) return true;
  }
  return false;
}

/** True if the host is missing, an IP-literal in a blocked range, or resolves to one. */
export async function isHostBlocked(hostname: string): Promise<boolean> {
  const h = (hostname ?? "").trim().replace(/^\[|\]$/g, "");
  if (h === "") return true;
  if (h.toLowerCase() === "localhost" || h.toLowerCase().endsWith(".local")) return true;
  if (isIP(h)) return ipBlocked(h);
  try {
    const addrs = await lookup(h, { all: true });
    if (addrs.length === 0) return true;
    return addrs.some((a) => ipBlocked(a.address));
  } catch {
    return true; // unresolvable → fail closed
  }
}

/**
 * Validate a URL is safe to fetch: http(s) and a non-private host. Returns the
 * parsed URL or null (caller refuses on null). Never throws.
 */
export async function safeFetchTarget(url: string): Promise<URL | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (await isHostBlocked(u.hostname)) return null;
  return u;
}
