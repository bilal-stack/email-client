// @vitest-environment node
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Account, Profile } from "next-auth";
import { afterEach, describe, expect, it } from "vitest";
import { decrypt } from "./crypto";
import { handleSignIn, mapProvider } from "./signin-callback";

// Helpers ------------------------------------------------------------------

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_FULL_SCOPES = `openid email profile ${GMAIL_SCOPE}`;

interface ProfileOverrides {
  email?: string | undefined;
  name?: string | null;
  picture?: string | null;
}

function makeAccount(overrides: Partial<Account> & Record<string, unknown> = {}): Account {
  return {
    // Auth.js v5 reports Google/Microsoft as "oidc", not "oauth" — use the
    // real value here so the test reflects production behavior.
    type: "oidc",
    provider: "google",
    providerAccountId: `paid-${randomUUID()}`,
    access_token: "ya29.access-token-value",
    refresh_token: "1//refresh-token-value",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    scope: GMAIL_FULL_SCOPES,
    token_type: "Bearer",
    id_token: "id-token",
    ...overrides,
  } as Account;
}

interface TestProfile extends Profile {
  email: string;
  name: string;
  picture: string;
}

function makeProfile(overrides: ProfileOverrides = {}): TestProfile {
  return {
    email: overrides.email ?? `user-${randomUUID()}@example.com`,
    name: overrides.name ?? "Test User",
    picture: overrides.picture ?? "https://example.com/pic.png",
  } as TestProfile;
}

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUser(email: string): Promise<string> {
  const u = await prisma.user.create({ data: { email } });
  createdUserIds.push(u.id);
  return u.id;
}

// Tests --------------------------------------------------------------------

describe("mapProvider", () => {
  it("maps google → gmail and microsoft-entra-id → graph", () => {
    expect(mapProvider("google")).toBe("gmail");
    expect(mapProvider("microsoft-entra-id")).toBe("graph");
    expect(mapProvider("github")).toBe(null);
    expect(mapProvider("")).toBe(null);
  });
});

describe("handleSignIn", () => {
  it("happy path: writes a MailAccount row with encrypted tokens and returns true", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    const result = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount(),
      profile,
    });

    expect(result).toBe(true);
    const row = await prisma.mailAccount.findUnique({
      where: {
        userId_provider_emailAddress: { userId, provider: "gmail", emailAddress: profile.email },
      },
    });
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.displayName).toBe("Test User");

    const plain = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
    const parsed = JSON.parse(plain) as { accessToken: string; scope: string };
    expect(parsed.accessToken).toBe("ya29.access-token-value");
    expect(parsed.scope).toBe(GMAIL_FULL_SCOPES);
  });

  it("returns the ScopeMissing redirect when Gmail scope was not granted", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    const result = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ scope: "openid email profile" }),
      profile,
    });

    // The scope-missing redirect points at /login (the primary entry for
    // anonymous visitors); /signin is now reserved for the add-mailbox flow.
    expect(result).toBe("/login?error=ScopeMissing&provider=google");
    const row = await prisma.mailAccount.findFirst({ where: { userId } });
    expect(row).toBeNull();
  });

  it("returns false when the profile has no email", async () => {
    const profileNoEmail = { name: "Anon", picture: null } as Profile;
    const result = await handleSignIn({
      user: { id: "u-stub", email: null },
      account: makeAccount(),
      profile: profileNoEmail,
    });
    expect(result).toBe(false);
  });

  it("accepts both oauth and oidc account types (Auth.js v5 reports Google/Microsoft as oidc)", async () => {
    for (const accountType of ["oauth", "oidc"] as const) {
      const profile = makeProfile();
      const userId = await createUser(profile.email);
      const result = await handleSignIn({
        user: { id: userId, email: profile.email },
        account: makeAccount({ type: accountType }),
        profile,
      });
      expect(result).toBe(true);
      const row = await prisma.mailAccount.findFirst({ where: { userId } });
      expect(row).not.toBeNull();
    }
  });

  it("returns true and skips upsert for credentials/email accounts (IMAP stub, magic link)", async () => {
    for (const skipType of ["credentials", "email"] as const) {
      const result = await handleSignIn({
        user: { id: "u-stub" },
        account: makeAccount({ type: skipType }),
        profile: makeProfile(),
      });
      expect(result).toBe(true);
    }
  });

  it("returns true and skips upsert when provider is unknown (e.g. github)", async () => {
    const result = await handleSignIn({
      user: { id: "u-stub" },
      account: makeAccount({ provider: "github" }),
      profile: makeProfile(),
    });
    expect(result).toBe(true);
  });

  it("falls back to email lookup when user.id is missing", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    const result = await handleSignIn({
      user: { email: profile.email }, // no id
      account: makeAccount(),
      profile,
    });

    expect(result).toBe(true);
    const row = await prisma.mailAccount.findUnique({
      where: {
        userId_provider_emailAddress: { userId, provider: "gmail", emailAddress: profile.email },
      },
    });
    expect(row?.userId).toBe(userId);
  });

  it("self-creates the User row when neither user.id nor an email match exists (race recovery)", async () => {
    const profile = makeProfile();
    // No createUser() — simulates the Auth.js v5 race where signIn fires before the adapter commits.

    const result = await handleSignIn({
      user: { email: profile.email }, // no id
      account: makeAccount(),
      profile,
    });

    expect(result).toBe(true);
    const u = await prisma.user.findUnique({ where: { email: profile.email } });
    expect(u).not.toBeNull();
    if (!u) return;
    createdUserIds.push(u.id); // cleanup
    const row = await prisma.mailAccount.findFirst({ where: { userId: u.id } });
    expect(row).not.toBeNull();
  });

  it("on repeat sign-in updates the existing MailAccount row instead of creating a duplicate", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ access_token: "ya29.first" }),
      profile,
    });
    await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ access_token: "ya29.second" }),
      profile,
    });

    const rows = await prisma.mailAccount.findMany({
      where: { userId, provider: "gmail", emailAddress: profile.email },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected one MailAccount row");
    const plain = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
    expect(JSON.parse(plain).accessToken).toBe("ya29.second");
  });

  it("encrypted token blob never contains the plaintext access token", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ access_token: "PLAINTEXT_LOOK_FOR_ME" }),
      profile,
    });

    const row = await prisma.mailAccount.findFirstOrThrow({ where: { userId } });
    // Scan the raw bytes for the plaintext marker.
    const haystack = Buffer.from(row.encryptedSecret).toString("latin1");
    expect(haystack).not.toContain("PLAINTEXT_LOOK_FOR_ME");
  });

  it("Microsoft Entra ID requires Mail.ReadWrite scope to link the MailAccount", async () => {
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    const without = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ provider: "microsoft-entra-id", scope: "openid email profile" }),
      profile,
    });
    // The scope-missing redirect surfaces on /login since the new auth
    // routes are the primary entry points; /signin is now add-only.
    expect(without).toBe("/login?error=ScopeMissing&provider=microsoft-entra-id");

    const withScope = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({
        provider: "microsoft-entra-id",
        scope: "openid email profile Mail.ReadWrite Mail.Send",
      }),
      profile,
    });
    expect(withScope).toBe(true);
    const row = await prisma.mailAccount.findFirst({
      where: { userId, provider: "graph", emailAddress: profile.email },
    });
    expect(row).not.toBeNull();
  });

  // ── Cross-user MailAccount conflict guard ────────────────────────────────
  //
  // When the OAuth email already exists as a `MailAccount.emailAddress` under
  // a DIFFERENT user, we refuse the link with `/signin?error=AccountConflict`.
  // This protects the model's "one mailbox = one user" invariant from being
  // violated by an OAuth callback that would otherwise reattach a mailbox to
  // the wrong identity (e.g. when an existing user is signed in via Gmail
  // and tries to add a Microsoft account whose email is already connected to
  // someone else's account).

  it("refuses to link a MailAccount that already belongs to a different user", async () => {
    // Pre-existing user with the Gmail-flavored MailAccount.
    const sharedEmail = `dual-${randomUUID()}@example.com`;
    const ownerUserId = await createUser(sharedEmail);
    await handleSignIn({
      user: { id: ownerUserId, email: sharedEmail },
      account: makeAccount(),
      profile: makeProfile({ email: sharedEmail }),
    });

    // A different user tries to sign in with the same OAuth email — the
    // OAuth callback's `user.id` is theirs, but our DB already has a
    // MailAccount for that email under the owner's id.
    const intruderUserId = await createUser(`intruder-${randomUUID()}@example.com`);
    const intruderProfile = makeProfile({ email: sharedEmail });

    const result = await handleSignIn({
      user: { id: intruderUserId, email: sharedEmail },
      account: makeAccount({ providerAccountId: `intruder-paid-${randomUUID()}` }),
      profile: intruderProfile,
    });

    expect(result).toBe("/signin?error=AccountConflict");

    // Defense-in-depth: the owner's MailAccount must NOT have been mutated
    // (e.g. reassigned to the intruder). It should still belong to the
    // original owner with no second MailAccount row created.
    const rows = await prisma.mailAccount.findMany({
      where: { emailAddress: sharedEmail },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ownerUserId);
  });

  it("does NOT trigger the conflict guard when the same user re-signs-in to their own mailbox", async () => {
    // Re-signing-in with the same provider for the same user should hit the
    // existing-row update path (already covered by the "repeat sign-in"
    // test), NOT the cross-user conflict refusal. Regression pin.
    const profile = makeProfile();
    const userId = await createUser(profile.email);

    const first = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ access_token: "ya29.first" }),
      profile,
    });
    expect(first).toBe(true);

    const second = await handleSignIn({
      user: { id: userId, email: profile.email },
      account: makeAccount({ access_token: "ya29.second" }),
      profile,
    });
    expect(second).toBe(true);

    const rows = await prisma.mailAccount.findMany({
      where: { emailAddress: profile.email },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userId);
  });

  it("allows the same user to connect two different provider accounts with distinct emails", async () => {
    // Same person, two providers, two emails — both MailAccounts should
    // land under the same User row. This is the happy path for the
    // multi-mailbox model.
    const gmailProfile = makeProfile();
    const userId = await createUser(gmailProfile.email);
    await handleSignIn({
      user: { id: userId, email: gmailProfile.email },
      account: makeAccount(),
      profile: gmailProfile,
    });

    const microsoftEmail = `other-${randomUUID()}@example.com`;
    const microsoftProfile = makeProfile({ email: microsoftEmail });
    const result = await handleSignIn({
      user: { id: userId, email: microsoftEmail },
      account: makeAccount({
        provider: "microsoft-entra-id",
        scope: "openid email profile Mail.ReadWrite Mail.Send",
      }),
      profile: microsoftProfile,
    });
    expect(result).toBe(true);

    const rows = await prisma.mailAccount.findMany({
      where: { userId },
      orderBy: { emailAddress: "asc" },
    });
    expect(rows).toHaveLength(2);
    const providers = rows.map((r) => r.provider).sort();
    expect(providers).toEqual(["gmail", "graph"]);
  });
});
