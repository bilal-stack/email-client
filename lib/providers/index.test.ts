import { randomUUID } from "node:crypto";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxSecret } from "./auth";
import { GmailProvider } from "./gmail";
import { GraphProvider } from "./graph";
import { buildProvider, getProviderForAccount } from "./index";
import { NotImplementedProvider } from "./types";

async function createAccountWithProvider(provider: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `idx-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    accessToken: "ya29.X",
    refreshToken: "1//RT",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "scope",
  };
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
  createdAccountIds.push(row.id);
  createdUserIds.push(user.id);
  return row.id;
}

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

describe("getProviderForAccount", () => {
  it("returns a GmailProvider for a gmail-backed MailAccount row", async () => {
    const accountId = await createAccountWithProvider("gmail");
    const provider = await getProviderForAccount(accountId);
    expect(provider).toBeInstanceOf(GmailProvider);
  });

  it("returns a GraphProvider for a graph row", async () => {
    const accountId = await createAccountWithProvider("graph");
    const provider = await getProviderForAccount(accountId);
    expect(provider).toBeInstanceOf(GraphProvider);
  });

  it("returns a NotImplementedProvider for an imap row", async () => {
    const accountId = await createAccountWithProvider("imap");
    const provider = await getProviderForAccount(accountId);
    expect(provider).toBeInstanceOf(NotImplementedProvider);
  });
});

describe("buildProvider", () => {
  it("builds a GmailProvider when given (gmail, accountId)", () => {
    const provider = buildProvider("gmail", "acc-123");
    expect(provider).toBeInstanceOf(GmailProvider);
  });

  it("builds a GraphProvider when given (graph, accountId)", () => {
    expect(buildProvider("graph", "acc-1")).toBeInstanceOf(GraphProvider);
  });

  it("builds a NotImplementedProvider for imap", () => {
    expect(buildProvider("imap", "acc-1")).toBeInstanceOf(NotImplementedProvider);
  });
});
