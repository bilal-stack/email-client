// @vitest-environment node
// Focused unit tests for the shared transactional writer used by every
// provider's sync function (gmail-sync, graph-sync, future imap-sync). The
// writer is exercised transitively by `gmail-sync.test.ts`, but a focused
// unit catches regressions earlier and exercises the no-op branch cleanly.

import { randomUUID } from "node:crypto";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import type { MailboxSecret } from "@/lib/providers/auth";
import type { CanonicalMessage, DeltaResult } from "@/lib/providers/types";
import type { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import { writeDelta } from "./_write-delta";

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

async function createAccount(): Promise<{ accountId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `wd-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    kind: "oauth",
    accessToken: "X",
    refreshToken: "Y",
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
      syncCursor: "INITIAL",
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

describe("writeDelta", () => {
  it("applies a complete delta: 1 thread upserted, 2 messages created, attachment inserted, change applied, deletion applied, cursor advanced", async () => {
    const { accountId, userId } = await createAccount();

    // Pre-seed a thread + 2 existing messages (one to be label-flipped via
    // changedMessages, one to be deleted via deletedIds).
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
        providerMessageId: "m-flip",
        providerThreadId: "thr-pre",
        from: { email: "a@example.com" } as unknown as Prisma.InputJsonValue,
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
        providerMessageId: "m-doomed",
        providerThreadId: "thr-pre",
        from: { email: "a@example.com" } as unknown as Prisma.InputJsonValue,
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
          id: "m-new-1",
          threadId: "thr-new",
          accountId,
          attachments: [
            { id: "att-1", filename: "a.pdf", mimeType: "application/pdf", size: 100 },
          ],
        }),
        buildMessage({ id: "m-new-2", threadId: "thr-new", accountId }),
      ],
      changedMessages: [{ id: "m-flip", isUnread: false, labels: ["INBOX"] }],
      deletedIds: ["m-doomed"],
      nextCursor: "ADVANCED",
    };

    const result = await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    // Returns the DB ids of the newly-touched threads.
    expect(result.threadIds).toHaveLength(1);
    const newThread = await prisma.thread.findUniqueOrThrow({
      where: {
        accountId_providerThreadId: { accountId, providerThreadId: "thr-new" },
      },
    });
    expect(result.threadIds).toEqual([newThread.id]);

    // Messages: 2 new ones present, the flipped one updated, the doomed one gone.
    const msgs = await prisma.message.findMany({ where: { accountId } });
    const ids = msgs.map((m) => m.providerMessageId).sort();
    expect(ids).toEqual(["m-flip", "m-new-1", "m-new-2"]);
    expect(msgs.find((m) => m.providerMessageId === "m-flip")?.isUnread).toBe(false);

    // Attachment row inserted for m-new-1, none for m-new-2.
    const attachments = await prisma.attachment.findMany({
      where: { message: { accountId, providerMessageId: "m-new-1" } },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("a.pdf");
    expect(attachments[0]?.fetchedAt).toBeNull();

    // Cursor + lastSyncedAt advanced.
    const acc = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.syncCursor).toBe("ADVANCED");
    expect(acc.lastSyncedAt).not.toBeNull();
  });

  it("is idempotent: running the same delta twice does not duplicate rows", async () => {
    const { accountId, userId } = await createAccount();
    const delta: DeltaResult = {
      newMessages: [
        buildMessage({
          id: "m-1",
          threadId: "thr-1",
          accountId,
          attachments: [
            { id: "att", filename: "f.pdf", mimeType: "application/pdf", size: 5 },
          ],
        }),
      ],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "C1",
    };

    await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );
    await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    const msgs = await prisma.message.findMany({
      where: { accountId, providerMessageId: "m-1" },
    });
    expect(msgs).toHaveLength(1);
    const attachments = await prisma.attachment.findMany({
      where: { message: { accountId, providerMessageId: "m-1" } },
    });
    expect(attachments).toHaveLength(1);
    const threads = await prisma.thread.findMany({ where: { accountId } });
    expect(threads).toHaveLength(1);
  });

  it("invalidates AISummary rows on threads that receive new messages", async () => {
    const { accountId, userId } = await createAccount();

    // Pre-seed a thread + AISummary row with invalidatedAt: null.
    const thread = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId: "thr-sum",
        subject: "S",
        lastMessageAt: new Date(0),
        unreadCount: 0,
        labels: ["INBOX"] as unknown as Prisma.InputJsonValue,
        participants: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.aISummary.create({
      data: {
        threadId: thread.id,
        tldr: "old summary",
        model: "claude-haiku-4-5-20251001",
        promptVersion: "v1",
        usage: { input_tokens: 1, output_tokens: 1 } as unknown as Prisma.InputJsonValue,
        userMessageJson: "{}",
        invalidatedAt: null,
      },
    });

    const delta: DeltaResult = {
      newMessages: [
        buildMessage({ id: "m-incoming", threadId: "thr-sum", accountId }),
      ],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "C1",
    };
    await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    const summary = await prisma.aISummary.findUniqueOrThrow({
      where: { threadId: thread.id },
    });
    expect(summary.invalidatedAt).not.toBeNull();
    // Sanity — the rest of the row is unchanged.
    expect(summary.tldr).toBe("old summary");
  });

  it("does NOT invalidate AISummary on a label-only changedMessages delta (no new mail)", async () => {
    const { accountId, userId } = await createAccount();

    const thread = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId: "thr-keep",
        subject: "S",
        lastMessageAt: new Date(0),
        unreadCount: 0,
        labels: ["INBOX"] as unknown as Prisma.InputJsonValue,
        participants: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.message.create({
      data: {
        threadId: thread.id,
        accountId,
        providerMessageId: "m-flip",
        providerThreadId: "thr-keep",
        from: { email: "a@example.com" } as unknown as Prisma.InputJsonValue,
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
    await prisma.aISummary.create({
      data: {
        threadId: thread.id,
        tldr: "still valid",
        model: "claude-haiku-4-5-20251001",
        promptVersion: "v1",
        usage: { input_tokens: 1, output_tokens: 1 } as unknown as Prisma.InputJsonValue,
        userMessageJson: "{}",
        invalidatedAt: null,
      },
    });

    const delta: DeltaResult = {
      newMessages: [],
      changedMessages: [{ id: "m-flip", isUnread: false, labels: ["INBOX"] }],
      deletedIds: [],
      nextCursor: "C2",
    };
    await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    const summary = await prisma.aISummary.findUniqueOrThrow({
      where: { threadId: thread.id },
    });
    expect(summary.invalidatedAt).toBeNull();
  });

  it("empty delta advances cursor and returns empty threadIds without errors", async () => {
    const { accountId, userId } = await createAccount();
    const delta: DeltaResult = {
      newMessages: [],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "NEXT",
    };

    const result = await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    expect(result.threadIds).toEqual([]);
    const acc = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(acc.syncCursor).toBe("NEXT");
    expect(acc.lastSyncedAt).not.toBeNull();
  });

  // The `inbox/message.created` Inngest events fire in the sync FUNCTIONS
  // (`gmail-sync.ts` / `graph-sync.ts`) AFTER the writer's transaction
  // commits — gated on `newMessageDbIds.length > 0`. The writer's job is
  // to return the right pair: the DB ids of just-inserted messages and a
  // map from each to its thread's DB id. These two tests pin the shape of
  // that contract so the callers' fan-out has the data it needs (or is
  // safely gated off on an empty delta).
  it("returns newMessageDbIds + messageIdToThreadDbId for newly-inserted messages, all pointing at the same thread", async () => {
    const { accountId, userId } = await createAccount();
    const delta: DeltaResult = {
      newMessages: [
        buildMessage({ id: "m-a", threadId: "thr-new", accountId }),
        buildMessage({ id: "m-b", threadId: "thr-new", accountId }),
        buildMessage({ id: "m-c", threadId: "thr-new", accountId }),
      ],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "C1",
    };

    const result = await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    expect(result.newMessageDbIds).toHaveLength(3);
    expect(result.messageIdToThreadDbId.size).toBe(3);

    const newThread = await prisma.thread.findUniqueOrThrow({
      where: {
        accountId_providerThreadId: { accountId, providerThreadId: "thr-new" },
      },
    });
    for (const messageDbId of result.newMessageDbIds) {
      expect(result.messageIdToThreadDbId.get(messageDbId)).toBe(newThread.id);
    }
  });

  it("returns empty newMessageDbIds + messageIdToThreadDbId on an empty delta — the caller's `inngest.send` is gated on this length", async () => {
    const { accountId, userId } = await createAccount();
    const delta: DeltaResult = {
      newMessages: [],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "C1",
    };

    const result = await prisma.$transaction((tx) =>
      writeDelta({ account: { id: accountId, userId }, delta, tx }),
    );

    expect(result.newMessageDbIds).toEqual([]);
    expect(result.messageIdToThreadDbId.size).toBe(0);
  });
});
