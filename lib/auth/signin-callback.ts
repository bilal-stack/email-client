// OAuth signIn callback. Runs after every Google / Microsoft sign-in
// (Credentials sign-ins handle their own persistence inside `authorize()`).
//
// What this does:
//   1. Decide the userId — reuse the existing MailAccount.userId for a
//      returning (provider, email), or take it from the add-mailbox cookie
//      for the "Add mailbox" flow, or mint a fresh cuid for a brand-new
//      person.
//   2. Encrypt the OAuth tokens and upsert into MailAccount.
//   3. Mutate the `user.id` arg so the downstream `jwt` callback stashes
//      that userId into the JWT.
//
// What this DELIBERATELY does NOT do anymore:
//   - Touch User / Account / Session tables. There aren't any — Option A
//     dropped PrismaAdapter; MailAccount is the only identity record.
//   - Poll for User-row visibility. There's nothing to wait for.
//   - Self-create a fallback User. Same reason.
//
// See prisma/schema.prisma → MailAccount for the architectural rationale.

import { readAndClearAddMailboxIntent } from "@/lib/auth/add-mailbox-cookie";
import { type SealedSecret, encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { createId } from "@paralleldrive/cuid2";
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
  // Non-OAuth sign-ins (credentials/IMAP, email magic link) handle their
  // own persistence — see the IMAP `authorize()` path in lib/auth/index.ts.
  if (!account || !OAUTH_ACCOUNT_TYPES.has(account.type)) return true;

  const providerName = mapProvider(account.provider);
  if (!providerName) return true;

  const rawEmail =
    (typeof profile?.email === "string" ? profile.email : null) ?? user?.email ?? null;
  if (!rawEmail) {
    console.error("[auth.signIn] no email on profile; rejecting", {
      provider: account.provider,
    });
    return false;
  }
  // Lowercase everywhere — providers may give us mixed-case emails
  // ("Foo@bar.com" vs "foo@bar.com") and we don't want two MailAccount
  // rows for what is plainly the same address.
  const emailAddress = rawEmail.toLowerCase();

  // 1. Verify the OAuth grant includes the scope we need.
  // Without it, the access token is useless for our provider calls; better
  // to refuse the link than to create a half-broken MailAccount the inbox
  // would silently treat as "no mail yet".
  const granted = (account.scope ?? "").split(/\s+/);
  if (!granted.includes(REQUIRED_SCOPES[providerName])) {
    console.error(
      `[auth.signIn] ${account.provider} sign-in succeeded but required scope not granted`,
      { granted: account.scope, required: REQUIRED_SCOPES[providerName] },
    );
    return `/login?error=ScopeMissing&provider=${account.provider}`;
  }

  // 2. Decide the userId for this sign-in.
  //
  // Precedence (highest → lowest):
  //   a. add-mailbox-cookie: an active session kicked off /signin?add=1
  //      to connect another mailbox. Use the cookie's userId so the new
  //      MailAccount lands on the active user, not a fresh one.
  //   b. existing MailAccount for (provider, emailAddress): a returning
  //      sign-in. Reuse its userId so the same person keeps the same
  //      session id across re-auths.
  //   c. brand-new mint: first time anyone signs in with this provider+email.
  const intentUserId = await readAndClearAddMailboxIntent();
  let userId: string | null = null;
  let resolveSource: "intent" | "existing" | "mint" = "mint";
  if (intentUserId) {
    // Confirm the intent cookie's userId actually belongs to a MailAccount
    // we know about — otherwise a stale cookie from a since-purged session
    // could re-attach the new mailbox to a non-existent identity. If we
    // can't verify, fall through to the standard resolution path.
    const intentExists = await prisma.mailAccount.findFirst({
      where: { userId: intentUserId },
      select: { id: true },
    });
    if (intentExists) {
      userId = intentUserId;
      resolveSource = "intent";
    }
  }
  if (!userId) {
    const existing = await prisma.mailAccount.findFirst({
      where: { provider: providerName, emailAddress },
      select: { userId: true },
    });
    if (existing) {
      userId = existing.userId;
      resolveSource = "existing";
    }
  }
  if (!userId) {
    userId = createId();
    resolveSource = "mint";
  }

  // 3. Cross-user conflict guard.
  //
  // If THIS (provider, emailAddress) pair already belongs to a different
  // userId from the one we just resolved (only possible in the
  // add-mailbox-intent path — the lookup above would have picked up
  // matches otherwise), the user is trying to attach a mailbox someone
  // else owns. Refuse with a clean error rather than letting the upsert
  // violate the unique constraint or silently re-bind.
  if (resolveSource === "intent") {
    const owned = await prisma.mailAccount.findFirst({
      where: { provider: providerName, emailAddress, userId: { not: userId } },
      select: { userId: true },
    });
    if (owned) {
      console.warn(
        "[auth.signIn] Add-mailbox intent conflicts with an existing MailAccount under a different userId",
        {
          emailAddress,
          provider: providerName,
          intentUserId: userId,
          existingUserId: owned.userId,
        },
      );
      return "/signin?error=AccountConflict";
    }
  }

  // 4. Encrypt and upsert MailAccount. The encrypt() call is inside the
  // same try/catch as upsert so a bad ENCRYPTION_KEY surfaces as our
  // logged error, not Auth.js's opaque "AccessDenied" page.
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

    const displayName =
      typeof profile?.name === "string"
        ? profile.name
        : typeof user?.name === "string"
          ? user.name
          : null;
    const image =
      typeof profile?.picture === "string"
        ? profile.picture
        : typeof user?.image === "string"
          ? user.image
          : null;

    await upsertMailAccount({
      userId,
      providerName,
      emailAddress,
      displayName,
      image,
      sealed,
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

  // 5. Propagate the resolved userId to the JWT callback.
  //
  // Auth.js threads the same `user` object from signIn → jwt on first
  // sign-in. Mutating its id is the documented way to hand a custom value
  // to downstream callbacks without setting up a side-channel.
  if (user) user.id = userId;

  console.warn("[auth.signIn] resolved", {
    userId,
    provider: providerName,
    emailAddress,
    source: resolveSource,
  });
  return true;
}

/**
 * Upsert the MailAccount row keyed on (userId, provider, emailAddress).
 * On update we ALSO clear `needsReconnectAt` — a fresh successful sign-in
 * proves the user fixed whatever made the previous sync worker stamp the
 * flag (revoked token, scope change, etc).
 */
async function upsertMailAccount(args: {
  userId: string;
  providerName: MailProviderName;
  emailAddress: string;
  displayName: string | null;
  image: string | null;
  sealed: SealedSecret;
}): Promise<void> {
  const { userId, providerName, emailAddress, displayName, image, sealed } = args;
  await prisma.mailAccount.upsert({
    where: {
      userId_provider_emailAddress: { userId, provider: providerName, emailAddress },
    },
    create: {
      userId,
      provider: providerName,
      emailAddress,
      displayName,
      image,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    },
    update: {
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      // Only overwrite displayName / image when the OAuth profile carries
      // a value — `undefined` tells Prisma "leave the column alone".
      displayName: displayName ?? undefined,
      image: image ?? undefined,
      needsReconnectAt: null,
    },
  });
}
