// Extracted from `lib/auth/index.ts` so the signIn callback can be unit tested
// without spinning up the full NextAuth instance. `lib/auth/index.ts` imports
// `handleSignIn` and wires it into the `callbacks.signIn` slot.
//
// The callback handles three concerns:
//   1. Resolve a User row (via Auth.js `user.id` → email lookup → self-create).
//   2. Verify the OAuth grant includes the scope we need to actually call the
//      provider; reject with a redirect if not.
//   3. Mirror the encrypted provider tokens into our own `MailAccount` table
//      (Auth.js's `Account` row keeps the plaintext OAuth tokens for its
//      session machinery; we never read those — we use the encrypted copy).

import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import type { Account, Profile, User } from "next-auth";

export type MailProviderName = "gmail" | "graph";

export function mapProvider(authProvider: string): MailProviderName | null {
  if (authProvider === "google") return "gmail";
  if (authProvider === "microsoft-entra-id") return "graph";
  return null;
}

const REQUIRED_SCOPES: Record<MailProviderName, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.modify",
  // Microsoft scopes are in the same space; both Mail.ReadWrite and Mail.Send
  // are required. We only assert one here — the consent screen surfaces both.
  graph: "Mail.ReadWrite",
};

export interface SignInArgs {
  user?: (User & { id?: string }) | null;
  account: Account | null | undefined;
  profile?: Profile | null;
}

// Auth.js v5 reports OpenID Connect providers (Google, Microsoft Entra) with
// `account.type === "oidc"`. Pure OAuth 2.0 providers use `"oauth"`. We treat
// both the same — they both yield the access/refresh tokens we need to mirror
// into MailAccount. Credentials and Email providers are not mail providers.
const OAUTH_ACCOUNT_TYPES: ReadonlySet<string> = new Set(["oauth", "oidc"]);

export async function handleSignIn({
  user,
  account,
  profile,
}: SignInArgs): Promise<boolean | string> {
  // Non-OAuth sign-ins (credentials/IMAP stub, email magic link) bypass
  // MailAccount linkage.
  if (!account || !OAUTH_ACCOUNT_TYPES.has(account.type)) return true;

  const providerName = mapProvider(account.provider);
  if (!providerName) return true;

  const emailAddress =
    (typeof profile?.email === "string" ? profile.email : null) ?? user?.email ?? null;
  if (!emailAddress) {
    console.error("[auth.signIn] no email on profile; rejecting", {
      provider: account.provider,
    });
    return false;
  }

  // 1. Resolve the User row.
  // Auth.js v5 + PrismaAdapter passes `user.id` after the adapter created or
  // linked the row. We treat that as authoritative; if missing (race during
  // first sign-in, or non-database adapter mode), fall back to an email
  // lookup, then to self-creating the row.
  let userId = user?.id ?? null;
  if (!userId) {
    const existing = await prisma.user.findUnique({ where: { email: emailAddress } });
    userId = existing?.id ?? null;
  }
  if (!userId) {
    const created = await prisma.user.create({
      data: {
        email: emailAddress,
        name: typeof profile?.name === "string" ? profile.name : null,
        image: typeof profile?.picture === "string" ? profile.picture : null,
      },
    });
    userId = created.id;
    console.warn("[auth.signIn] User row missing at callback time; created it ourselves", {
      userId,
      emailAddress,
    });
  }

  // 2. Verify the OAuth grant includes the scope we need.
  // Without it, the access token is useless for our provider calls; better to
  // refuse the link than to create a half-broken MailAccount the inbox UI
  // would silently treat as "no mail yet".
  const granted = (account.scope ?? "").split(/\s+/);
  if (!granted.includes(REQUIRED_SCOPES[providerName])) {
    console.error(
      `[auth.signIn] ${account.provider} sign-in succeeded but required scope not granted`,
      { granted: account.scope, required: REQUIRED_SCOPES[providerName] },
    );
    return `/signin?error=ScopeMissing&provider=${account.provider}`;
  }

  // 3. Encrypt and mirror tokens into MailAccount.
  // The encrypt() call is inside the same try/catch as upsert so a bad
  // ENCRYPTION_KEY surfaces as our logged error, not Auth.js's opaque
  // "AccessDenied" page.
  try {
    const secretJson = JSON.stringify({
      accessToken: account.access_token ?? null,
      refreshToken: account.refresh_token ?? null,
      expiresAt: account.expires_at ?? null,
      scope: account.scope ?? null,
      tokenType: account.token_type ?? null,
      idToken: account.id_token ?? null,
    });
    const sealed = encrypt(secretJson);

    await prisma.mailAccount.upsert({
      where: {
        userId_provider_emailAddress: {
          userId,
          provider: providerName,
          emailAddress,
        },
      },
      create: {
        userId,
        provider: providerName,
        emailAddress,
        displayName: typeof profile?.name === "string" ? profile.name : null,
        encryptedSecret: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
      },
      update: {
        encryptedSecret: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
        displayName: typeof profile?.name === "string" ? profile.name : undefined,
      },
    });
  } catch (e) {
    const isCryptoError = e instanceof Error && /ENCRYPTION_KEY/.test(e.message);
    console.error(
      isCryptoError
        ? "[auth.signIn] Failed to encrypt provider tokens — check ENCRYPTION_KEY env var"
        : "[auth.signIn] MailAccount upsert failed",
      e,
    );
    return false;
  }
  return true;
}
