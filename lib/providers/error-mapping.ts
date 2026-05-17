// Canonical error mapping for Gmail / googleapis errors.
//
// `googleapis` surfaces HTTP failures as gaxios errors with either `.code`
// (the numeric HTTP status) or a nested `.response.status`. The OAuth refresh
// endpoint (which we call directly via fetch in `lib/providers/auth.ts`) does
// not use gaxios but throws our own `AuthError` on `invalid_grant`; if any
// caller passes through a raw `Response`-style error we still want a sensible
// canonical mapping here.
//
// Mapping rules (per the spec):
//   401            → AuthError
//   403 + insufficientPermissions / invalid_grant → AuthError
//   404            → NotFoundError, *unless* the message indicates a stale
//                    history cursor (Gmail's History API returns 404
//                    "historyId not found" when the cursor is older than ~7d)
//                    in which case → AuthError with a "reconnect required"
//                    message so the UI can prompt re-auth.
//   429            → RateLimitError (parses `Retry-After`)
//   5xx            → TransientError
//   no status      → TransientError (network / DNS / abort)
//   anything else  → UnknownProviderError
//
// In every case, the original error is preserved on the `cause` property.

import {
  AuthError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  TransientError,
  UnknownProviderError,
} from "./errors";

// ─── IMAP (imapflow) error shape ──────────────────────────────────────────
// imapflow surfaces errors with distinctive properties — `responseStatus`
// ("NO" / "BAD") or `authenticationFailed` — that no Gmail/Graph error
// shape carries. We detect with a presence check on those keys and never
// interpolate the host/username into the canonical message (per spec risk
// #4 — app-password leakage in error messages).
interface ImapflowLikeError {
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseStatus?: "NO" | "BAD" | "OK" | "BYE" | "PREAUTH";
  /** Raw response text from the server. May contain host/user — never log. */
  response?: string;
  /** Node `net` error codes: ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT, ETLS. */
  code?: string | number;
  message?: string;
}

function looksLikeImapflowError(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return "responseStatus" in o || "authenticationFailed" in o;
}

interface GaxiosLikeError {
  code?: number | string;
  status?: number;
  // `@microsoft/microsoft-graph-client`'s GraphError class exposes the HTTP
  // status here, not in `status` or `response.status`. Probed against the real
  // SDK to confirm — see commit history for `probe-graph-error.mjs`.
  statusCode?: number;
  message?: string;
  response?: {
    status?: number;
    headers?: Record<string, string | string[] | undefined>;
    data?: { error?: { message?: string; errors?: Array<{ reason?: string }> } };
  };
}

function pickStatus(err: GaxiosLikeError): number | undefined {
  const fromResponse = err.response?.status;
  if (typeof fromResponse === "number") return fromResponse;
  if (typeof err.status === "number") return err.status;
  if (typeof err.statusCode === "number") return err.statusCode;
  if (typeof err.code === "number") return err.code;
  // gaxios sometimes serializes the numeric status as a string in `.code`.
  if (typeof err.code === "string") {
    const parsed = Number(err.code);
    if (Number.isInteger(parsed) && parsed >= 100 && parsed < 600) return parsed;
  }
  return undefined;
}

function pickMessage(err: GaxiosLikeError): string {
  return err.response?.data?.error?.message ?? err.message ?? "Provider call failed";
}

function pickRetryAfter(err: GaxiosLikeError): number | undefined {
  const raw = err.response?.headers?.["retry-after"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Flatten a gaxios / fetch error into a safely-serializable object before we
 * attach it as `.cause`. Raw gaxios errors carry circular references between
 * `config` ↔ `response` ↔ `request`; when Inngest serializes a step's thrown
 * error for the run log it `JSON.stringify`s the cause chain, and the circular
 * refs surface as a `SyntaxError: Unexpected end of JSON input` in the Next.js
 * terminal. Keeping only the fields we'd actually inspect during debugging
 * (status, code, message, response data) sidesteps that without losing signal.
 */
function sanitizeCause(e: unknown): unknown {
  if (e === null || e === undefined) return e;
  if (typeof e !== "object") return e;
  const src = e as GaxiosLikeError & { name?: string; stack?: string };
  return {
    name: src.name,
    message: src.message,
    code: src.code,
    status: pickStatus(src),
    responseData: src.response?.data,
    // Keep stack as a string — already serializable.
    stack: src.stack,
  };
}

export function mapError(e: unknown): ProviderError {
  // Idempotent — if we've already mapped this once, return as-is.
  if (e instanceof ProviderError) return e;

  // ─── imapflow path ───────────────────────────────────────────────────
  // Must run before the gaxios/Graph paths — imapflow errors don't carry
  // an HTTP status so they'd otherwise fall through to the "no status →
  // TransientError" branch and lose their auth/protocol distinction.
  if (looksLikeImapflowError(e)) {
    const ie = e as ImapflowLikeError;
    const imapCause = sanitizeCause(e);
    if (
      ie.authenticationFailed === true ||
      (ie.responseStatus === "NO" &&
        /auth(entication)?|credentials|invalid/i.test(ie.response ?? ""))
    ) {
      // Fixed canonical message — no host, no username.
      return new AuthError(
        "Invalid IMAP credentials — please re-check your app-password",
        { cause: imapCause },
      );
    }
    if (ie.responseStatus === "BAD") {
      return new UnknownProviderError("IMAP protocol error", { cause: imapCause });
    }
    if (
      typeof ie.code === "string" &&
      /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ETLS/.test(ie.code)
    ) {
      return new TransientError("IMAP connection failed", { cause: imapCause });
    }
    // Any other imapflow error falls through to the generic path below.
  }

  const err = (e ?? {}) as GaxiosLikeError;
  const status = pickStatus(err);
  const message = pickMessage(err);
  const cause = sanitizeCause(e);

  if (status === 401) return new AuthError(message, { cause });

  if (status === 403 && /insufficientPermissions|invalid_grant/i.test(message)) {
    return new AuthError(message, { cause });
  }

  if (status === 404) {
    // Stale historyId (>~7 days) — Gmail returns 404 "historyId not found" /
    // "Requested entity was not found" with a `startHistoryId` mention. Per
    // spec risk #1 we map this to AuthError so the UI prompts a reconnect
    // (which runs the cold-start `getProfile().historyId` path on the next
    // sync). We deliberately do NOT introduce a `FullResyncRequiredError`
    // subclass — automatic full re-sync is out of scope for this spec.
    if (/historyId.*not found|startHistoryId|Invalid.*startHistoryId/i.test(message)) {
      return new AuthError(`Sync history expired — reconnect required: ${message}`, { cause });
    }
    return new NotFoundError(message, { cause });
  }

  if (status === 410) {
    // Graph returns 410 Gone when a saved `@odata.deltaLink` has expired
    // (typically after ~30 days of inactivity, sometimes sooner under tenant
    // compaction). Map to AuthError so the UI prompts a reconnect; the next
    // sync runs the cold-start path (no cursor → fresh delta link). Parallels
    // the Gmail stale-historyId 404 branch above.
    if (/delta.?link|deltaToken|resync required/i.test(message)) {
      return new AuthError(`Sync delta expired — reconnect required: ${message}`, { cause });
    }
    // Other 410s (non-delta) most closely resemble a "gone" target — treat
    // as NotFound. A bare 410 from any other Graph endpoint is rare.
    return new NotFoundError(message, { cause });
  }

  if (status === 429) {
    return new RateLimitError(message, pickRetryAfter(err), { cause });
  }

  if (typeof status === "number" && status >= 500 && status < 600) {
    return new TransientError(message, { cause });
  }

  if (status === undefined) {
    // Network / DNS / abort / non-HTTP failure. Retry is safe.
    return new TransientError(message, { cause });
  }

  return new UnknownProviderError(message, { cause });
}
