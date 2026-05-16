// RFC 5322 address-list parser used by the composer's recipient inputs.
// Copied from `lib/providers/gmail.ts` to keep the dependency direction clean
// (UI must not import provider adapters). Handles the three common shapes:
//   - `bare@example.com`
//   - `Name <addr@example.com>`
//   - `"Quoted Name" <addr@example.com>`
// Returns `[]` for empty / unparseable input rather than throwing.

import type { CanonicalAddress } from "@/lib/providers/types";

export function parseAddressList(header: string): CanonicalAddress[] {
  if (!header) return [];
  const out: CanonicalAddress[] = [];
  const parts: string[] = [];
  let depthAngle = 0;
  let inQuotes = false;
  let buf = "";
  for (const ch of header) {
    if (ch === "\\") {
      buf += ch;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") depthAngle++;
    else if (!inQuotes && ch === ">") depthAngle = Math.max(0, depthAngle - 1);
    if (!inQuotes && depthAngle === 0 && ch === ",") {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  for (const raw of parts) {
    if (!raw) continue;
    const angleStart = raw.lastIndexOf("<");
    const angleEnd = raw.lastIndexOf(">");
    if (angleStart !== -1 && angleEnd > angleStart) {
      const email = raw.slice(angleStart + 1, angleEnd).trim();
      const name = raw
        .slice(0, angleStart)
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      if (email) out.push(name ? { name, email } : { email });
    } else if (raw.includes("@")) {
      out.push({ email: raw.trim() });
    }
  }
  return out;
}

// Minimal RFC 5322-ish email check used to flag chips as invalid in the
// recipient input. Not exhaustive — Server Action also Zod-validates with
// `z.string().email()`.
const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

/** Keep the first occurrence of each `email` (case-insensitive). */
export function dedupeByEmail(addresses: CanonicalAddress[]): CanonicalAddress[] {
  const seen = new Set<string>();
  const out: CanonicalAddress[] = [];
  for (const a of addresses) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export function formatAddressList(addresses: CanonicalAddress[]): string {
  return addresses.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
}
