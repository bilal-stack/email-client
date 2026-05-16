// Pure header / subject / quote builders for the compose flow. No DB, no
// TipTap, no provider SDK imports — these are pure functions exercised by
// unit tests and consumed by the reply / forward route loaders.

import type { CanonicalAddress } from "@/lib/providers/types";

export interface ParentForHeaders {
  providerMessageId: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * RFC 5322 §3.6.4: References = parent's References + parent's Message-ID.
 * If parent had no References, fall back to its In-Reply-To then its own
 * Message-ID. The returned `inReplyTo` is always the parent's Message-ID.
 */
export function buildReplyHeaders(parent: ParentForHeaders): {
  inReplyTo: string;
  references: string[];
} {
  const prior =
    parent.references.length > 0 ? parent.references : parent.inReplyTo ? [parent.inReplyTo] : [];
  return {
    inReplyTo: parent.providerMessageId,
    references: [...prior, parent.providerMessageId],
  };
}

const RE_PREFIX = /^\s*re\s*:\s*/i;
const FWD_PREFIX = /^\s*(fwd?|forward)\s*:\s*/i;

export function prefixReplySubject(subject: string): string {
  const cleaned = subject.replace(RE_PREFIX, "").trim();
  return cleaned.length > 0 ? `Re: ${cleaned}` : "Re:";
}

export function prefixForwardSubject(subject: string): string {
  const cleaned = subject.replace(FWD_PREFIX, "").trim();
  return cleaned.length > 0 ? `Fwd: ${cleaned}` : "Fwd:";
}

export interface ParentForForward {
  from: CanonicalAddress;
  receivedAt: Date;
  subject: string;
  to: CanonicalAddress[];
  bodyHtml: string | null;
  bodyText: string | null;
}

/**
 * Build the quoted-forward HTML block. `parent.bodyHtml` is interpolated
 * directly (not re-sanitized here) because the inbound sync pipeline already
 * ran it through `sanitizeEmailHtml`, and the outbound `sendDraft` will
 * sanitize the final composer output one more time before handing to the
 * provider — defense-in-depth at both ends.
 */
export function buildForwardQuote(parent: ParentForForward): string {
  const fromLabel = parent.from.name
    ? `${escapeHtml(parent.from.name)} &lt;${escapeHtml(parent.from.email)}&gt;`
    : escapeHtml(parent.from.email);
  const toLabel = parent.to
    .map((a) =>
      a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.email)}&gt;` : escapeHtml(a.email),
    )
    .join(", ");
  const date = parent.receivedAt.toUTCString();
  const subject = escapeHtml(parent.subject || "(no subject)");
  const body = parent.bodyHtml ?? `<pre>${escapeHtml(parent.bodyText ?? "")}</pre>`;

  return [
    "<br><br>",
    '<div style="border-left:2px solid #999;padding-left:1em;margin-top:1em;">',
    '<p style="margin:0 0 .5em 0;font-size:.875em;color:#555;">',
    "---------- Forwarded message ----------<br>",
    `<strong>From:</strong> ${fromLabel}<br>`,
    `<strong>Date:</strong> ${date}<br>`,
    `<strong>Subject:</strong> ${subject}<br>`,
    `<strong>To:</strong> ${toLabel}`,
    "</p>",
    body,
    "</div>",
  ].join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
