// @vitest-environment node
// Sync function calls into `GmailProvider` which uses googleapis; needs Node env
// so MSW's http/https interception catches outbound calls.
import { randomUUID } from "node:crypto";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import type { MailboxSecret } from "@/lib/providers/auth";
import { GmailProvider } from "@/lib/providers/gmail";
import type { CanonicalMessage, DeltaResult } from "@/lib/providers/types";
import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gmailSyncDelta } from "./gmail-sync";

interface FakeStep {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function fakeStep(): FakeStep {
  return { run: (_name, fn) => fn() };
}

// `InngestFunction` keeps the registered handler on a private-ish `fn` field.
// We invoke it directly with a minimal fake context — the test plan says
// "Inngest functions are invoked directly as plain async functions in tests".
function invokeHandler(): Promise<unknown> {
  const handler = (
    gmailSyncDelta as unknown as { fn: (ctx: { step: FakeStep }) => Promise<unknown> }
  ).fn;
  return handler({ step: fakeStep() });
}

async function createAccount(syncCursor: string | null): Promise<{
  accountId: string;
  userId: string;
}> {
  const user = await prisma.user.create({
    data: { email: `sync-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    kind: "oauth",
    accessToken: "ya29.X",
    refreshToken: "1//RT",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "scope",
  };
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "gmail",
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      syncCursor,
    },
  });
  createdAccountIds.push(row.id);
  createdUserIds.push(user.id);
  return { accountId: row.id, userId: user.id };
}

function buildMessage(overrides: Partial<CanonicalMessage>): CanonicalMessage {
  return {
    id: overrides.id ?? "msg-x",
    threadId: overrides.threadId ?? "thr-x",
    accountId: overrides.accountId ?? "acc-x",
    from: { name: "Sender", email: "sender@example.com" },
    to: [{ email: "rcpt@example.com" }],
    cc: [],
    bcc: [],
    subject: "Test",
    snippet: "Snippet",
    bodyHtml: null,
    bodyText: "Body",
    receivedAt: new Date(1_700_000_000_000),
    isUnread: true,
    labels: ["INBOX", "UNREAD"],
    inReplyTo: null,
    references: [],
    attachments: [],
    ...overrides,
  };
}

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (findManyRestorers.length) findManyRestorers.pop()?.();
  // Cascade cleans messages, threads, attachments.
  if (createdAccountIds.length) {
    await prisma.mailAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
    createdAccountIds.length = 0;
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

// Concurrent test files share the test SQLite DB. We scope each invocation of
// the Inngest function to *only* the account this test created, by stubbing the
// `list-accounts` step's underlying `findMany` call. We swap the method via
// direct assignment (rather than `vi.spyOn`) because Prisma's model delegates
// are proxy-backed and not always spyable. The afterEach restores via the
// returned restore function.
const findManyRestorers: Array<() => void> = [];
function scopeToAccount(accountId: string, syncCursor: string | null) {
  const delegate = prisma.mailAccount as unknown as Record<string, unknown>;
  const hadOwn = Object.hasOwn(delegate, "findMany");
  const originalDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(delegate, "findMany") : null;
  Object.defineProperty(delegate, "findMany", {
    configurable: true,
    writable: true,
    value: async () => [{ id: accountId, syncCursor }],
  });
  findManyRestorers.push(() => {
    if (originalDescriptor) {
      Object.defineProperty(delegate, "findMany", originalDescriptor);
    } else {
      // Reflect.deleteProperty is semantically the same as `delete` here but
      // avoids Biome's `noDelete` performance rule — fine in test setup code.
      Reflect.deleteProperty(delegate, "findMany");
    }
  });
}

describe("gmailSyncDelta inngest function", () => {
  it("applies a normal delta: upserts threads, inserts messages, applies changes and deletes, updates cursor", async () => {
    const { accountId } = await createAccount("12345");
    scopeToAccount(accountId, "12345");

    // Pre-create a message that will be marked deleted, and one that will be
    // updated via changedMessages.
    const preThread = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId: "thr-pre",
        subject: "Pre",
        lastMessageAt: new Date(0),
        unreadCount: 1,
        labels: ["INBOX", "UNREAD"] as unknown as Prisma.InputJsonValue,
        participants: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.message.create({
      data: {
        threadId: preThread.id,
        accountId,
        providerMessageId: "m3",
        providerThreadId: "thr-pre",
        from: { email: "x@example.com" } as unknown as Prisma.InputJsonValue,
        to: [] as unknown as Prisma.InputJsonValue,
        cc: [] as unknown as Prisma.InputJsonValue,
        bcc: [] as unknown as Prisma.InputJsonValue,
        subject: "S",
        snippet: "Sn",
        receivedAt: new Date(),
        isUnread: true,
        labels: ["INBOX", "UNREAD"] as unknown as Prisma.InputJsonValue,
        references: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.message.create({
      data: {
        threadId: preThread.id,
        accountId,
        providerMessageId: "m4",
        providerThreadId: "thr-pre",
        from: { email: "x@example.com" } as unknown as Prisma.InputJsonValue,
        to: [] as unknown as Prisma.InputJsonValue,
        cc: [] as unknown as Prisma.InputJsonValue,
        bcc: [] as unknown as Prisma.InputJsonValue,
        subject: "S",
        snippet: "Sn",
        receivedAt: new Date(),
        isUnread: false,
        labels: ["INBOX"] as unknown as Prisma.InputJsonValue,
        references: [] as unknown as Prisma.InputJsonValue,
      },
    });

    const delta: DeltaResult = {
      newMessages: [
        buildMessage({
          id: "m1",
          threadId: "thr-new",
          accountId,
          attachments: [{ id: "att1", filename: "a.pdf", mimeType: "application/pdf", size: 100 }],
        }),
        buildMessage({ id: "m2", threadId: "thr-new", accountId }),
      ],
      changedMessages: [{ id: "m3", isUnread: false, labels: ["INBOX"] }],
      deletedIds: ["m4"],
      nextCursor: "67890",
    };
    const syncSpy = vi.spyOn(GmailProvider.prototype, "syncDelta").mockResolvedValue(delta);

    await invokeHandler();

    expect(syncSpy).toHaveBeenCalledWith("12345");

    const threads = await prisma.thread.findMany({ where: { accountId } });
    expect(threads.some((t) => t.providerThreadId === "thr-new")).toBe(true);

    const messages = await prisma.message.findMany({ where: { accountId } });
    const ids = messages.map((m) => m.providerMessageId).sort();
    expect(ids).toEqual(["m1", "m2", "m3"]);

    const m3 = messages.find((m) => m.providerMessageId === "m3");
    expect(m3?.isUnread).toBe(false);

    const attachments = await prisma.attachment.findMany({
      where: { message: { accountId, providerMessageId: "m1" } },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.fetchedAt).toBeNull();
    expect(attachments[0]?.filename).toBe("a.pdf");

    const acc = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.syncCursor).toBe("67890");
    expect(acc.lastSyncedAt).not.toBeNull();
  });

  it("is idempotent: running the same delta twice does not duplicate messages or attachments", async () => {
    const { accountId } = await createAccount("100");
    scopeToAccount(accountId, "100");
    const delta: DeltaResult = {
      newMessages: [
        buildMessage({
          id: "m1",
          threadId: "thr-1",
          accountId,
          attachments: [
            { id: "att-only", filename: "f.pdf", mimeType: "application/pdf", size: 10 },
          ],
        }),
      ],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "200",
    };
    vi.spyOn(GmailProvider.prototype, "syncDelta").mockResolvedValue(delta);

    await invokeHandler();
    await invokeHandler();

    const messages = await prisma.message.findMany({
      where: { accountId, providerMessageId: "m1" },
    });
    expect(messages).toHaveLength(1);

    const attachments = await prisma.attachment.findMany({
      where: { message: { accountId, providerMessageId: "m1" } },
    });
    expect(attachments).toHaveLength(1);
  });

  it("transactional rollback: when a write fails mid-flight, syncCursor is unchanged", async () => {
    const { accountId } = await createAccount("ROLLBACK_CURSOR");
    scopeToAccount(accountId, "ROLLBACK_CURSOR");

    // Two newMessages sharing the same providerMessageId trigger the
    // `(accountId, providerMessageId)` unique constraint inside createMany,
    // which throws *during* the transaction — the cursor update at step 6
    // should then roll back along with everything else.
    const delta: DeltaResult = {
      newMessages: [
        buildMessage({ id: "m-dup", threadId: "thr-dup", accountId }),
        buildMessage({ id: "m-dup", threadId: "thr-dup", accountId }),
      ],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "NEW_CURSOR",
    };
    vi.spyOn(GmailProvider.prototype, "syncDelta").mockResolvedValue(delta);

    await expect(invokeHandler()).rejects.toBeTruthy();

    const acc = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.syncCursor).toBe("ROLLBACK_CURSOR");
    // No messages should have leaked out either.
    const msgs = await prisma.message.findMany({
      where: { accountId, providerMessageId: "m-dup" },
    });
    expect(msgs).toHaveLength(0);
  });
});
