// SSRF guard for user-supplied IMAP/SMTP hostnames.
//
// The Credentials provider's `authorize` callback accepts arbitrary host
// strings from the sign-in form. An attacker could supply `127.0.0.1`,
// `169.254.169.254` (AWS metadata), or an internal hostname to coerce the
// server into scanning or fetching from places it shouldn't. We reject those
// up front — both for literal IPs and for hostnames that DNS-resolve to
// private ranges.
//
// In production we enforce strict rules; in dev/test we allow loopback
// (`localhost`, `127.0.0.1`, `::1`) so the build agent can run against a
// local IMAP server. RFC1918 / link-local / ULA ranges are rejected in every
// environment so we don't drift between behaviors.
//
// Called from two sites:
//   1. `lib/auth/index.ts` Credentials `authorize` — before any socket open.
//   2. `lib/providers/imap.ts` `openClient` — defense-in-depth on every call,
//      in case the stored host was tampered with after sign-in.

import { promises as dns, type LookupAddress } from "node:dns";
import net from "node:net";

const PROD = process.env.NODE_ENV === "production";
const ALLOW_DEV_LOOPBACK = !PROD;

const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((re) => re.test(ip));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  // fc00::/7 — unique local addresses
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  // fe80::/10 — link-local
  if (lower.startsWith("fe80:")) return true;
  return false;
}

export async function assertHostAllowed(host: string, port: number): Promise<void> {
  if (!host || typeof host !== "string" || host.length > 253) {
    throw new Error("IMAP host not allowed", { cause: "invalid host string" });
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("IMAP host not allowed", { cause: "invalid port" });
  }

  // Literal IP path
  if (net.isIP(host)) {
    if (ALLOW_DEV_LOOPBACK && (host === "127.0.0.1" || host === "::1")) return;
    if (net.isIPv4(host) && isPrivateV4(host)) {
      throw new Error("IMAP host not allowed", { cause: "private v4 literal" });
    }
    if (net.isIPv6(host) && isPrivateV6(host)) {
      throw new Error("IMAP host not allowed", { cause: "private v6 literal" });
    }
    return;
  }

  if (ALLOW_DEV_LOOPBACK && host === "localhost") return;

  // Hostname — resolve and check every record.
  let addrs: LookupAddress[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error("IMAP host not allowed", { cause: e });
  }
  for (const a of addrs) {
    if (a.family === 4 && isPrivateV4(a.address)) {
      throw new Error("IMAP host not allowed", { cause: `resolves to ${a.address}` });
    }
    if (a.family === 6 && isPrivateV6(a.address)) {
      throw new Error("IMAP host not allowed", { cause: `resolves to ${a.address}` });
    }
  }
}
