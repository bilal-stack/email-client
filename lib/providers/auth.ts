// Centralized token-refresh helper for provider adapters.
//
// Adapter code never refreshes tokens inline — they call `getMailboxSecret`
// which:
//   1. Reads the `MailAccount` row.
//   2. Decrypts `encryptedSecret` via `lib/auth/crypto.ts`.
//   3. If the access token is still valid (more than REFRESH_SKEW_SECONDS
//      from now), returns the decrypted secret unchanged.
//   4. Otherwise dispatches by `MailAccount.provider`:
//        - "gmail" → POSTs to Google's token endpoint. Google rarely rotates
//          refresh tokens; we PRESERVE the stored one on every refresh.
//        - "graph" → POSTs to Microsoft's token endpoint. MS ALWAYS rotates
//          the refresh token; we PERSIST the new one returned in the response.
//        - "imap"  → throws (no OAuth refresh; IMAP credentials are static).
//
// We deliberately do NOT coalesce concurrent refreshes within a single Node
// process (per spec risk #3). For Google this is benign (idempotent endpoint).
// For Microsoft the second concurrent refresh can hit `invalid_grant` because
// the first call already rotated the token; that surfaces as `AuthError` and
// the next sync tick succeeds. A per-account async lock is a future follow-up.

import { decrypt, encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "@/lib/providers/errors";

export type MailboxSecret = OAuthMailboxSecret | ImapMailboxSecret;

export interface OAuthMailboxSecret {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  scope: string;
}

export interface ImapMailboxSecret {
  kind: "imap";
  password: string;
  imapHost: string;
  /** Defaults to 993 when omitted. */
  imapPort?: number;
  smtpHost: string;
  /** Defaults to 465 when omitted. */
  smtpPort?: number;
}

interface GoogleRefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

interface MicrosoftRefreshResponse {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token: string; // MS ALWAYS returns a fresh one
}

const REFRESH_SKEW_SECONDS = 60;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Hard ceiling on how long we'll wait for an OAuth token refresh. Without
// this, an upstream Google / Microsoft outage can hang a Server Action
// indefinitely — the request keeps a Prisma connection AND the user-facing
// HTTP socket open, which is the root of the "page still loading 20
// minutes in" failure mode reported during manual testing. 15s is well
// above the p99 for both providers but short enough that a hung dependency
// surfaces as an `AuthError` (which the UI already maps to a reconnect
// prompt) instead of an infinite spinner.
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Race a fetch against a setTimeout-driven `TimeoutError`. We deliberately
 * do NOT pass an AbortSignal through to fetch — under Vitest the global
 * `AbortSignal` constructor user code receives is different from the one
 * MSW captured at module-load time, which makes MSW's
 * `recordRawHeaders` reject any signal we hand it as "not an instance of
 * AbortSignal". `Promise.race` against a timer is the portable workaround.
 *
 * Trade-off: a fetch that doesn't resolve within `timeoutMs` keeps running
 * in the background until Node's HTTP keepalive eventually closes it.
 * Acceptable for OAuth refresh — these calls are infrequent and small,
 * and the failure mode we care about is "user request returns fast" not
 * "request leak is impossible". The caller treats `TimeoutError` the
 * same way it would treat an `AbortError`.
 */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`fetch timed out after ${timeoutMs}ms`) as Error & {
        name: string;
      };
      err.name = "TimeoutError";
      reject(err);
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, init), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Match the timeout/abort error shapes that `AbortSignal.timeout` can
 * raise across Node versions. Either name is "we hit the wall, give up".
 */
function isAbortLike(e: unknown): boolean {
  const err = e as { name?: string } | null | undefined;
  return err?.name === "AbortError" || err?.name === "TimeoutError";
}

export async function getMailboxSecret(accountId: string): Promise<MailboxSecret> {
  const row = await prisma.mailAccount.findUniqueOrThrow({
    where: { id: accountId },
  });

  const plaintext = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
  // Backward-compat: rows written before the discriminated-union refactor
  // have no `kind` field. Treat them as OAuth (the only shape that existed).
  // The next refresh writes back the migrated shape with `kind: "oauth"`.
  const raw = JSON.parse(plaintext) as Partial<MailboxSecret> & Record<string, unknown>;
  const secret: MailboxSecret =
    "kind" in raw && raw.kind
      ? (raw as MailboxSecret)
      : ({ kind: "oauth", ...raw } as OAuthMailboxSecret);

  // IMAP secrets never expire — passwords are static. Return unchanged.
  if (secret.kind === "imap") return secret;

  const now = Math.floor(Date.now() / 1000);
  if (secret.expiresAt - REFRESH_SKEW_SECONDS > now) return secret;

  let next: OAuthMailboxSecret;
  switch (row.provider) {
    case "gmail": {
      const r = await refreshGoogleToken(secret.refreshToken);
      next = {
        kind: "oauth",
        accessToken: r.access_token,
        // Google rarely rotates; keep the stored refresh token.
        refreshToken: secret.refreshToken,
        expiresAt: now + r.expires_in,
        scope: r.scope ?? secret.scope,
      };
      break;
    }
    case "graph": {
      const r = await refreshMicrosoftToken(secret.refreshToken, secret.scope);
      // MS rotates on every refresh; r already carries the new refreshToken.
      next = { kind: "oauth", ...r };
      break;
    }
    case "imap":
      throw new Error("Unsupported provider for refresh: imap");
    default:
      throw new Error(`Unsupported provider for refresh: ${row.provider}`);
  }

  const sealed = encrypt(JSON.stringify(next));
  await prisma.mailAccount.update({
    where: { id: accountId },
    data: {
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    },
  });

  return next;
}

async function refreshGoogleToken(refreshToken: string): Promise<GoogleRefreshResponse> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured");
  }

  let res: Response;
  try {
    res = await fetchWithTimeout(
      GOOGLE_TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      },
      REFRESH_TIMEOUT_MS,
    );
  } catch (e) {
    // Timeout / abort from `AbortSignal.timeout` above, or any transport
    // failure. Surface as transient AuthError so the canonicalizer maps
    // it to "try again in a moment" rather than the reconnect prompt —
    // the user's refresh token is presumably fine; Google's token
    // endpoint just didn't respond inside our budget.
    if (isAbortLike(e)) {
      throw new AuthError("Google token refresh timed out", { transient: true });
    }
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();
    // A revoked / expired refresh token returns `400 invalid_grant`. We do
    // NOT auto-delete the MailAccount row — the reconnect flow (in
    // `unified-inbox-ui`) will overwrite the row when the user re-auths.
    if (body.includes("invalid_grant")) {
      throw new AuthError("Refresh token revoked");
    }
    // Do not interpolate the raw response body into the error message — it
    // can flow into logs verbatim. Status code is sufficient for the
    // public message; the body lives on `error.cause` for runtime inspection
    // by Inngest's error surface.
    throw new Error(`Google token refresh failed: HTTP ${res.status}`, { cause: body });
  }

  return (await res.json()) as GoogleRefreshResponse;
}

async function refreshMicrosoftToken(
  refreshToken: string,
  scope: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: string }> {
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  const clientSecret = process.env.AZURE_AD_CLIENT_SECRET;
  const tenantId = process.env.AZURE_AD_TENANT_ID;
  if (!clientId || !clientSecret || !tenantId) {
    throw new Error(
      "AZURE_AD_CLIENT_ID / AZURE_AD_CLIENT_SECRET / AZURE_AD_TENANT_ID not configured",
    );
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  let res: Response;
  try {
    res = await fetchWithTimeout(
      tokenUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope,
        }),
      },
      REFRESH_TIMEOUT_MS,
    );
  } catch (e) {
    if (isAbortLike(e)) {
      throw new AuthError("Microsoft token refresh timed out", { transient: true });
    }
    throw e;
  }

  if (!res.ok) {
    const body = await res.text();
    // Same shape as the Google helper: revoked / expired tokens surface as
    // `invalid_grant`. Do NOT delete the row — the reconnect flow handles it.
    if (body.includes("invalid_grant")) {
      throw new AuthError("Refresh token revoked");
    }
    // Keep the raw body off the public message; attach as `cause` for runtime
    // inspection (Graph error bodies can contain tenant identifiers).
    throw new Error(`Microsoft token refresh failed: HTTP ${res.status}`, { cause: body });
  }

  const data = (await res.json()) as MicrosoftRefreshResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // MS rotates; persist the new one
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    scope: data.scope ?? scope,
  };
}
