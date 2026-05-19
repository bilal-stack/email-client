// @vitest-environment node
import { describe, expect, it } from "vitest";
import { canonicalizeProviderError, isReconnectRequired } from "./canonical-errors";
import {
  AuthError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  TransientError,
  UnknownProviderError,
} from "./errors";

describe("canonicalizeProviderError", () => {
  it("AuthError → reconnect prompt regardless of cause-flavoured message", () => {
    // Each AuthError below carries a message that COULD leak provider detail
    // (tenant ids, hostnames, raw envelope strings). The canonical layer must
    // strip all of that and emit the fixed reconnect prompt.
    const tenantFlavoured = new AuthError(
      "Access is denied due to invalid credentials in tenant 11111111-2222-3333-4444-555555555555",
    );
    const imapFlavoured = new AuthError("Invalid IMAP credentials for u@example.com on imap.example.com:993");
    const stale = new AuthError("Sync history expired — reconnect required: historyId not found");

    for (const e of [tenantFlavoured, imapFlavoured, stale]) {
      expect(canonicalizeProviderError(e, "send")).toBe(
        "Please reconnect this account to continue.",
      );
      expect(canonicalizeProviderError(e, "markRead")).toBe(
        "Please reconnect this account to continue.",
      );
    }

    // Crucially, NONE of the original flavour leaks.
    expect(canonicalizeProviderError(tenantFlavoured, "send")).not.toContain("tenant");
    expect(canonicalizeProviderError(imapFlavoured, "send")).not.toContain("imap.example.com");
    expect(canonicalizeProviderError(stale, "send")).not.toContain("historyId");
  });

  it("AuthError(transient: true) → 'try again in a moment' (NOT the reconnect prompt)", () => {
    // The OAuth refresh-timeout path throws AuthError with transient=true.
    // The user's refresh token is presumably fine; the right affordance is
    // RETRY, not reconnect. The canonicalizer keys off the flag.
    const transient = new AuthError("Google token refresh timed out", { transient: true });
    expect(canonicalizeProviderError(transient, "send")).toBe(
      "Authentication is slow right now. Please try again in a moment.",
    );
    expect(canonicalizeProviderError(transient, "send")).not.toContain("reconnect");

    // Default AuthError (transient=false) still maps to the reconnect prompt
    // — confirms the new branch hasn't regressed the existing case.
    const persistent = new AuthError("Refresh token revoked");
    expect(canonicalizeProviderError(persistent, "send")).toBe(
      "Please reconnect this account to continue.",
    );
  });

  it("RateLimitError → fixed wait-and-retry string", () => {
    expect(canonicalizeProviderError(new RateLimitError("retry after 30"), "send")).toBe(
      "Too many requests. Please wait a moment and try again.",
    );
  });

  it("NotFoundError → fixed item-not-found string (no raw message echo)", () => {
    expect(canonicalizeProviderError(new NotFoundError("Resource 12345 not found"), "send")).toBe(
      "Item not found.",
    );
  });

  it("TransientError → action-flavoured retry message", () => {
    const e = new TransientError("HTTP 503 Service Unavailable from upstream-x.example.com");
    expect(canonicalizeProviderError(e, "send")).toBe("Failed to send. Please try again.");
    expect(canonicalizeProviderError(e, "markRead")).toBe(
      "Failed to mark as read. Please try again.",
    );
    expect(canonicalizeProviderError(e, "archive")).toBe("Failed to archive. Please try again.");
    expect(canonicalizeProviderError(e, "search")).toBe("Search failed. Please try again.");
  });

  it("UnknownProviderError → action-flavoured generic message", () => {
    expect(canonicalizeProviderError(new UnknownProviderError("weird thing"), "send")).toBe(
      "Failed to send. Please try again.",
    );
  });

  it("plain ProviderError → action-flavoured generic message", () => {
    expect(canonicalizeProviderError(new ProviderError("some plain pe"), "trash")).toBe(
      "Failed to move to trash. Please try again.",
    );
  });

  it("non-ProviderError values map to the generic action message", () => {
    expect(canonicalizeProviderError(new Error("random"), "send")).toBe(
      "Failed to send. Please try again.",
    );
    expect(canonicalizeProviderError("a string", "send")).toBe(
      "Failed to send. Please try again.",
    );
    expect(canonicalizeProviderError(undefined, "generic")).toBe(
      "Something went wrong. Please try again.",
    );
  });
});

describe("isReconnectRequired", () => {
  it("true only for AuthError", () => {
    expect(isReconnectRequired(new AuthError("x"))).toBe(true);
    expect(isReconnectRequired(new RateLimitError("x"))).toBe(false);
    expect(isReconnectRequired(new TransientError("x"))).toBe(false);
    expect(isReconnectRequired(new Error("x"))).toBe(false);
  });
});
