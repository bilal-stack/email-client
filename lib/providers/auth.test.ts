import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../tests/setup/msw";
import { type MailboxSecret, getMailboxSecret } from "./auth";
import { AuthError } from "./errors";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

async function loadFixture<T = unknown>(name: string): Promise<T> {
  const path = resolve(process.cwd(), "tests", "fixtures", "gmail", name);
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function createTestUser() {
  return prisma.user.create({
    data: { email: `auth-test-${randomUUID()}@example.com` },
  });
}

async function createMailAccountWith(secret: MailboxSecret, provider = "gmail") {
  const user = await createTestUser();
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider,
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    },
  });
  return { user, row };
}

describe("getMailboxSecret", () => {
  const createdAccountIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    if (createdAccountIds.length) {
      await prisma.mailAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
      createdAccountIds.length = 0;
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  it("returns the cached secret without hitting the refresh endpoint when the token is still valid", async () => {
    let refreshHits = 0;
    server.use(
      http.post(GOOGLE_TOKEN_URL, () => {
        refreshHits++;
        return HttpResponse.json({ access_token: "should-not-be-used", expires_in: 3600 });
      }),
    );

    const futureExpiry = Math.floor(Date.now() / 1000) + 60 * 10; // 10 minutes ahead
    const secret: MailboxSecret = {
      accessToken: "ya29.ORIGINAL",
      refreshToken: "1//RT-ORIGINAL",
      expiresAt: futureExpiry,
      scope: "https://www.googleapis.com/auth/gmail.modify",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    const result = await getMailboxSecret(row.id);

    expect(result.accessToken).toBe("ya29.ORIGINAL");
    expect(refreshHits).toBe(0);
  });

  it("refreshes when the token is within the 60s skew window and persists the new secret", async () => {
    const refreshed = await loadFixture<{
      access_token: string;
      expires_in: number;
      scope: string;
    }>("oauth.refresh.ok.json");
    let refreshHits = 0;
    server.use(
      http.post(GOOGLE_TOKEN_URL, () => {
        refreshHits++;
        return HttpResponse.json(refreshed);
      }),
    );

    const nearExpiry = Math.floor(Date.now() / 1000) + 30; // inside skew
    const secret: MailboxSecret = {
      accessToken: "ya29.STALE",
      refreshToken: "1//RT-OK",
      expiresAt: nearExpiry,
      scope: "https://www.googleapis.com/auth/gmail.modify",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    const result = await getMailboxSecret(row.id);

    expect(refreshHits).toBe(1);
    expect(result.accessToken).toBe(refreshed.access_token);
    expect(result.refreshToken).toBe(secret.refreshToken);
    expect(result.expiresAt).toBeGreaterThan(nearExpiry);

    const persisted = await prisma.mailAccount.findUniqueOrThrow({ where: { id: row.id } });
    // The persisted ciphertext should not contain the *old* access token verbatim.
    expect(Buffer.from(persisted.encryptedSecret).includes(Buffer.from(secret.accessToken))).toBe(
      false,
    );
  });

  it("refreshes when the token is fully expired", async () => {
    const refreshed = await loadFixture<{ access_token: string; expires_in: number }>(
      "oauth.refresh.ok.json",
    );
    let refreshHits = 0;
    server.use(
      http.post(GOOGLE_TOKEN_URL, () => {
        refreshHits++;
        return HttpResponse.json(refreshed);
      }),
    );

    const pastExpiry = Math.floor(Date.now() / 1000) - 3600;
    const secret: MailboxSecret = {
      accessToken: "ya29.EXPIRED",
      refreshToken: "1//RT-OK",
      expiresAt: pastExpiry,
      scope: "https://www.googleapis.com/auth/gmail.modify",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    const result = await getMailboxSecret(row.id);
    expect(refreshHits).toBe(1);
    expect(result.accessToken).toBe(refreshed.access_token);
  });

  it("throws AuthError on invalid_grant and does NOT mutate the row", async () => {
    const errBody = await loadFixture<{ error: string }>("oauth.refresh.invalid_grant.json");
    server.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.json(errBody, { status: 400 })));

    const pastExpiry = Math.floor(Date.now() / 1000) - 60;
    const secret: MailboxSecret = {
      accessToken: "ya29.STALE",
      refreshToken: "1//RT-REVOKED",
      expiresAt: pastExpiry,
      scope: "scope",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    const before = await prisma.mailAccount.findUniqueOrThrow({ where: { id: row.id } });

    await expect(getMailboxSecret(row.id)).rejects.toBeInstanceOf(AuthError);

    const after = await prisma.mailAccount.findUniqueOrThrow({ where: { id: row.id } });
    expect(Buffer.compare(before.encryptedSecret, after.encryptedSecret)).toBe(0);
    expect(Buffer.compare(before.secretIv, after.secretIv)).toBe(0);
    expect(Buffer.compare(before.secretTag, after.secretTag)).toBe(0);
  });

  it("round-trips: after refresh, decrypting the persisted ciphertext matches the returned secret", async () => {
    const refreshed = await loadFixture<{
      access_token: string;
      expires_in: number;
      scope: string;
    }>("oauth.refresh.ok.json");
    server.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.json(refreshed)));

    const secret: MailboxSecret = {
      accessToken: "ya29.STALE",
      refreshToken: "1//RT-OK",
      expiresAt: Math.floor(Date.now() / 1000) - 5,
      scope: "scope",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    const returned = await getMailboxSecret(row.id);
    const persisted = await prisma.mailAccount.findUniqueOrThrow({ where: { id: row.id } });

    // Decrypt the persisted row via the same crypto module and compare.
    const { decrypt } = await import("@/lib/auth/crypto");
    const plaintext = decrypt(persisted.encryptedSecret, persisted.secretIv, persisted.secretTag);
    expect(JSON.parse(plaintext)).toEqual(returned);
  });

  it("never writes the plaintext access token into the ciphertext bytes", async () => {
    const refreshed = await loadFixture<{ access_token: string; expires_in: number }>(
      "oauth.refresh.ok.json",
    );
    server.use(http.post(GOOGLE_TOKEN_URL, () => HttpResponse.json(refreshed)));

    const secret: MailboxSecret = {
      accessToken: "ya29.STALE",
      refreshToken: "1//RT-OK",
      expiresAt: Math.floor(Date.now() / 1000) - 5,
      scope: "scope",
    };
    const { user, row } = await createMailAccountWith(secret);
    createdAccountIds.push(row.id);
    createdUserIds.push(user.id);

    await getMailboxSecret(row.id);

    const persisted = await prisma.mailAccount.findUniqueOrThrow({ where: { id: row.id } });
    const cipherBuf = Buffer.from(persisted.encryptedSecret);
    // The plaintext access token from the refresh response should never appear
    // verbatim in the ciphertext bytes (sanity check that the row is encrypted).
    expect(cipherBuf.includes(Buffer.from(refreshed.access_token))).toBe(false);
    expect(cipherBuf.includes(Buffer.from(secret.refreshToken))).toBe(false);
  });
});
