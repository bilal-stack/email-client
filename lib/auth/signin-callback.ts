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

import { readAndClearAddMailboxIntent } from "@/lib/auth/add-mailbox-cookie";
import { type SealedSecret, encrypt } from "@/lib/auth/crypto";
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
  //
  // FIRST PRIORITY — add-mailbox flow. If the /signin?add=1 Server Action
  // stashed the active session's userId in a cookie before kicking off
  // OAuth, the new MailAccount belongs to THAT user, not whichever User
  // PrismaAdapter happened to create/resolve from the new provider's
  // profile. Without this override, every "Add mailbox" with a non-
  // matching email creates a new User row (because Auth.js doesn't know
  // these are the same person) and our MailAccount upsert lands on
  // it — the active session's inbox then can't see the new mailbox.
  // The cookie is one-shot (cleared on read) and verified against the
  // DB so a stale value can't reattach a mailbox to a non-existent user.
  const intentUserId = await readAndClearAddMailboxIntent();
  let userId: string | null = null;
  if (intentUserId) {
    const intentExists = await prisma.user.findUnique({
      where: { id: intentUserId },
      select: { id: true },
    });
    if (intentExists) {
      userId = intentUserId;
      console.warn(
        "[auth.signIn] add-mailbox intent — targeting active session's user",
        { userId, providerEmail: emailAddress },
      );
    }
    // If the cookie's userId no longer exists (session expired, user
    // deleted, whatever), fall through to the standard resolution path.
  }

  // SECOND PRIORITY — standard OAuth resolution.
  //
  // Auth.js v5 + PrismaAdapter creates the User row inside its own transaction
  // during the OAuth callback and then invokes this `signIn` callback. The
  // resulting `user.id` is the ID PrismaAdapter just minted, but on SQLite in
  // WAL mode (and occasionally on Postgres under high concurrency) that write
  // may not yet be visible to a sibling Prisma connection when we ask for it.
  // The poll below rides out the visibility race before falling back to email
  // lookup / self-create.
  if (!userId) {
    let resolved = user?.id ?? null;
    if (resolved) {
      resolved = await waitForUserVisibility(resolved, emailAddress);
    }
    if (!resolved) {
      const existing = await prisma.user.findUnique({ where: { email: emailAddress } });
      resolved = existing?.id ?? null;
    }
    if (!resolved) {
      const created = await prisma.user.create({
        data: {
          email: emailAddress,
          name: typeof profile?.name === "string" ? profile.name : null,
          image: typeof profile?.picture === "string" ? profile.picture : null,
        },
      });
      resolved = created.id;
      console.warn("[auth.signIn] User row missing at callback time; created it ourselves", {
        userId: resolved,
        emailAddress,
      });
    }
    userId = resolved;
  }

  // 2. Cross-user conflict guard.
  //
  // The OAuth email might already be a `MailAccount.emailAddress` belonging
  // to a DIFFERENT User row (i.e. an unrelated identity also signed up here
  // and connected this same provider). Letting the upsert proceed in that
  // case would either (a) attach the MailAccount to the wrong User or (b)
  // hit a unique-constraint violation on `(userId, provider, emailAddress)`.
  // Neither is good UX — surface a clean error instead and back out of the
  // sign-in.
  //
  // Why we check by `emailAddress` and not by `(provider, emailAddress)`:
  // even cross-provider conflicts matter for the user's mental model
  // ("alice@gmail.com is alice, regardless of which app I authed through").
  // In practice cross-provider duplicates are rare (a Gmail address can't
  // sign in via Microsoft) but the broader check is cheap and defensive.
  const otherUserOwnsThisMailAccount = await prisma.mailAccount.findFirst({
    where: {
      emailAddress,
      userId: { not: userId },
    },
    select: { userId: true },
  });
  if (otherUserOwnsThisMailAccount) {
    console.warn(
      "[auth.signIn] OAuth email is already a MailAccount of a different user — refusing link",
      {
        emailAddress,
        resolvedUserId: userId,
        conflictingUserId: otherUserOwnsThisMailAccount.userId,
      },
    );
    return "/signin?error=AccountConflict";
  }

  // 3. Verify the OAuth grant includes the scope we need.
  // Without it, the access token is useless for our provider calls; better to
  // refuse the link than to create a half-broken MailAccount the inbox UI
  // would silently treat as "no mail yet".
  const granted = (account.scope ?? "").split(/\s+/);
  if (!granted.includes(REQUIRED_SCOPES[providerName])) {
    console.error(
      `[auth.signIn] ${account.provider} sign-in succeeded but required scope not granted`,
      { granted: account.scope, required: REQUIRED_SCOPES[providerName] },
    );
    return `/login?error=ScopeMissing&provider=${account.provider}`;
  }

  // 4. Encrypt and mirror tokens into MailAccount.
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

    await upsertMailAccountWithFkRetry({
      userId,
      providerName,
      emailAddress,
      displayName: typeof profile?.name === "string" ? profile.name : null,
      sealed,
      profileNameRaw: profile?.name,
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

/**
 * Wraps the `MailAccount.upsert` in a single-retry that handles the
 * Auth.js + PrismaAdapter + SQLite-WAL write-visibility race documented
 * in the resolve-User block above. If the FK to `User.id` fires (P2003),
 * we self-create the User row by email and retry the upsert once. After
 * the retry, any further failure propagates up to the caller and ends
 * the sign-in with AccessDenied (the intended fail-loud behavior for
 * truly broken state like a stale ENCRYPTION_KEY).
 */
async function upsertMailAccountWithFkRetry(args: {
  userId: string;
  providerName: MailProviderName;
  emailAddress: string;
  displayName: string | null;
  sealed: SealedSecret;
  profileNameRaw: unknown;
}): Promise<void> {
  const { providerName, emailAddress, displayName, sealed, profileNameRaw } = args;
  let userId = args.userId;
  const buildCreate = (uid: string) => ({
    userId: uid,
    provider: providerName,
    emailAddress,
    displayName,
    encryptedSecret: sealed.ciphertext,
    secretIv: sealed.iv,
    secretTag: sealed.tag,
  });
  const update = {
    encryptedSecret: sealed.ciphertext,
    secretIv: sealed.iv,
    secretTag: sealed.tag,
    displayName: typeof profileNameRaw === "string" ? profileNameRaw : undefined,
  };
  try {
    await prisma.mailAccount.upsert({
      where: {
        userId_provider_emailAddress: { userId, provider: providerName, emailAddress },
      },
      create: buildCreate(userId),
      update,
    });
    return;
  } catch (e) {
    // P2003 is Prisma's "Foreign key constraint failed" code. The only FK on
    // MailAccount is userId → User.id; a P2003 here means the User row we
    // resolved isn't visible at the connection that ran the upsert.
    const isFkError =
      e !== null &&
      typeof e === "object" &&
      (e as { code?: unknown }).code === "P2003";
    if (!isFkError) throw e;
  }

  // Re-resolve User by email and create if missing — same fallback chain as
  // the resolve-User block, but executed AFTER the FK rejection.
  const existing = await prisma.user.findUnique({
    where: { email: emailAddress },
    select: { id: true },
  });
  if (existing) {
    userId = existing.id;
  } else {
    const created = await prisma.user.create({
      data: {
        email: emailAddress,
        name: typeof profileNameRaw === "string" ? profileNameRaw : null,
      },
    });
    userId = created.id;
    console.warn("[auth.signIn] FK retry: self-created User after upsert FK failure", {
      userId,
      emailAddress,
    });
  }

  await prisma.mailAccount.upsert({
    where: {
      userId_provider_emailAddress: { userId, provider: providerName, emailAddress },
    },
    create: buildCreate(userId),
    update,
  });
}

/**
 * Poll the DB for a User row's visibility, waiting up to ~600ms total before
 * giving up. Used to ride out the Auth.js + PrismaAdapter transaction-commit
 * window without prematurely self-creating a User row (which would collide
 * with PrismaAdapter's pending insert on `email @unique` and force its
 * transaction to roll back — see the long comment in `handleSignIn`).
 *
 * Returns the original userId if it became visible within the budget; null
 * otherwise (so the caller falls through to email-lookup / self-create).
 */
async function waitForUserVisibility(
  userId: string,
  emailAddress: string,
): Promise<string | null> {
  // 6 attempts × 100ms = 600ms total budget. Auth.js commits in <300ms in
  // practice; the extra headroom covers GC pauses or a slow disk on Windows.
  const ATTEMPTS = 6;
  const DELAY_MS = 100;
  for (let i = 0; i < ATTEMPTS; i++) {
    const visible = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (visible) return userId;
    // Sleep before the next probe. Skip the sleep after the final probe so
    // we return as fast as possible when the wait is hopeless.
    if (i < ATTEMPTS - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, DELAY_MS));
    }
  }
  console.warn(
    "[auth.signIn] user.id from Auth.js not visible after 600ms — falling back to email lookup",
    { userIdFromAuthJs: userId, emailAddress },
  );
  return null;
}
