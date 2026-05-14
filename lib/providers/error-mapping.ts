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

interface GaxiosLikeError {
  code?: number | string;
  status?: number;
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

export function mapError(e: unknown): ProviderError {
  // Idempotent — if we've already mapped this once, return as-is.
  if (e instanceof ProviderError) return e;

  const err = (e ?? {}) as GaxiosLikeError;
  const status = pickStatus(err);
  const message = pickMessage(err);

  if (status === 401) return new AuthError(message, { cause: e });

  if (status === 403 && /insufficientPermissions|invalid_grant/i.test(message)) {
    return new AuthError(message, { cause: e });
  }

  if (status === 404) {
    // Stale historyId (>~7 days) — Gmail returns 404 "historyId not found" /
    // "Requested entity was not found" with a `startHistoryId` mention. Per
    // spec risk #1 we map this to AuthError so the UI prompts a reconnect
    // (which runs the cold-start `getProfile().historyId` path on the next
    // sync). We deliberately do NOT introduce a `FullResyncRequiredError`
    // subclass — automatic full re-sync is out of scope for this spec.
    if (/historyId.*not found|startHistoryId|Invalid.*startHistoryId/i.test(message)) {
      return new AuthError(`Sync history expired — reconnect required: ${message}`, {
        cause: e,
      });
    }
    return new NotFoundError(message, { cause: e });
  }

  if (status === 429) {
    return new RateLimitError(message, pickRetryAfter(err), { cause: e });
  }

  if (typeof status === "number" && status >= 500 && status < 600) {
    return new TransientError(message, { cause: e });
  }

  if (status === undefined) {
    // Network / DNS / abort / non-HTTP failure. Retry is safe.
    return new TransientError(message, { cause: e });
  }

  return new UnknownProviderError(message, { cause: e });
}
