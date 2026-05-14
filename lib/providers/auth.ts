// Centralized token-refresh helper for provider adapters.
//
// Adapter code never refreshes tokens inline — they call `getMailboxSecret`
// which:
//   1. Reads the `MailAccount` row.
//   2. Decrypts `encryptedSecret` via `lib/auth/crypto.ts`.
//   3. If the access token is still valid (more than REFRESH_SKEW_SECONDS
//      from now), returns the decrypted secret unchanged.
//   4. Otherwise calls Google's OAuth token endpoint with the stored refresh
//      token, re-encrypts the new secret, persists it on the `MailAccount`
//      row, and returns the fresh secret.
//
// We deliberately do NOT coalesce concurrent refreshes within a single Node
// process (per spec risk #3). Google's refresh endpoint is idempotent — two
// concurrent refreshes are benign; the loser overwrites with an equivalent
// secret. Adding an in-process mutex is premature optimization for an MVP.

import { decrypt, encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "@/lib/providers/errors";

export interface MailboxSecret {
  accessToken: string;
  refreshToken: string;
  /** Epoch seconds. */
  expiresAt: number;
  scope: string;
}

interface GoogleRefreshResponse {
  access_token: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

const REFRESH_SKEW_SECONDS = 60;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export async function getMailboxSecret(accountId: string): Promise<MailboxSecret> {
  const row = await prisma.mailAccount.findUniqueOrThrow({
    where: { id: accountId },
  });

  const plaintext = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
  const secret = JSON.parse(plaintext) as MailboxSecret;

  const now = Math.floor(Date.now() / 1000);
  if (secret.expiresAt - REFRESH_SKEW_SECONDS > now) return secret;

  if (row.provider !== "gmail") {
    throw new Error(`Unsupported provider for refresh: ${row.provider}`);
  }

  const refreshed = await refreshGoogleToken(secret.refreshToken);
  const next: MailboxSecret = {
    // Google does not always rotate the refresh token; keep the existing one
    // if a new one was not returned (the common case).
    accessToken: refreshed.access_token,
    refreshToken: secret.refreshToken,
    expiresAt: now + refreshed.expires_in,
    scope: refreshed.scope ?? secret.scope,
  };

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

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

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
