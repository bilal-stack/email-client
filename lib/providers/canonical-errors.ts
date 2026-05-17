// Canonical user-facing strings for ProviderError subtypes.
//
// The error-mapping module (`error-mapping.ts`) preserves the provider's
// original message on the ProviderError instance — useful for debugging via
// Inngest run logs and `Error.cause`, but unsafe to surface to the browser.
// Graph's `error.message` envelope can carry tenant ids, request ids, and
// other operator-visible details; Gmail's is mostly canonical but not
// guaranteed; IMAP raw responses can contain host/username substrings.
//
// Server Actions that catch a `ProviderError` MUST funnel it through this
// helper before returning the message to the client. The fixed allow-list
// keeps the public surface bounded regardless of which adapter threw.

import {
  AuthError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  TransientError,
} from "./errors";

/**
 * Action context lets the canonical message stay slightly action-specific for
 * the user without leaking which provider threw or what their raw error said.
 * "send" / "markRead" / etc. correspond to user-visible verbs in the UI.
 */
export type CanonicalAction =
  | "send"
  | "markRead"
  | "archive"
  | "trash"
  | "setLabels"
  | "search"
  | "sync"
  | "generic";

/** Generic action-flavored fallback strings — used for Transient / unknown ProviderError. */
const FAILED_BY_ACTION: Record<CanonicalAction, string> = {
  send: "Failed to send. Please try again.",
  markRead: "Failed to mark as read. Please try again.",
  archive: "Failed to archive. Please try again.",
  trash: "Failed to move to trash. Please try again.",
  setLabels: "Failed to update labels. Please try again.",
  search: "Search failed. Please try again.",
  sync: "Mailbox sync failed. Please try again.",
  generic: "Something went wrong. Please try again.",
};

/**
 * Map a thrown error to a fixed user-facing string. Never echoes the
 * original `e.message`. AuthError always maps to a reconnect prompt — the UI
 * uses the canonical phrase to surface a reconnect button.
 */
export function canonicalizeProviderError(
  e: unknown,
  action: CanonicalAction = "generic",
): string {
  if (e instanceof AuthError) {
    // Single message regardless of underlying cause (revoked token / stale
    // history id / expired delta link / IMAP UIDVALIDITY flip / invalid
    // credentials). All require the same user action: reconnect the account.
    return "Please reconnect this account to continue.";
  }
  if (e instanceof RateLimitError) {
    return "Too many requests. Please wait a moment and try again.";
  }
  if (e instanceof NotFoundError) {
    return "Item not found.";
  }
  if (e instanceof TransientError) {
    return FAILED_BY_ACTION[action];
  }
  if (e instanceof ProviderError) {
    return FAILED_BY_ACTION[action];
  }
  // Non-ProviderError fall-through — the caller is responsible for not
  // surfacing arbitrary thrown values to the client, but we play defense.
  return FAILED_BY_ACTION[action];
}

/**
 * Returns `true` if the error signals an auth issue that needs the user to
 * reconnect the account. The UI uses this to decide whether to render the
 * reconnect button alongside the canonical message.
 */
export function isReconnectRequired(e: unknown): boolean {
  return e instanceof AuthError;
}
