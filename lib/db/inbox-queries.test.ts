// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, describe, expect, it } from "vitest";
import { getThreadByIdForUser, listThreadsForUser } from "./inbox-queries";

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    // Cascades clean up MailAccount + Thread + Message + Attachment.
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `inbox-q-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  const account = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "gmail",
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: randomBytes(16),
      secretIv: randomBytes(12),
      secretTag: randomBytes(16),
    },
  });
  return { userId: user.id, accountId: account.id };
}

async function createThread(
  accountId: string,
  opts: {
    subject: string;
    lastMessageAt: Date;
    unread?: number;
    messageCount?: number;
    labels?: string[];
  },
): Promise<string> {
  const thread = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId: `pth-${randomUUID()}`,
      subject: opts.subject,
      lastMessageAt: opts.lastMessageAt,
      unreadCount: opts.unread ?? 0,
      labels: opts.labels ?? ["INBOX"],
      participants: [{ name: "Sender", email: "sender@example.com" }],
    },
  });
  const count = opts.messageCount ?? 1;
  for (let i = 0; i < count; i++) {
    await prisma.message.create({
      data: {
        threadId: thread.id,
        accountId,
        providerMessageId: `pmsg-${randomUUID()}`,
        providerThreadId: thread.providerThreadId,
        from: { name: "Sender", email: "sender@example.com" },
        to: [{ email: "rcpt@example.com" }],
        cc: [],
        bcc: [],
        subject: opts.subject,
        snippet: `Snippet ${i}`,
        bodyHtml: null,
        bodyText: `Body ${i}`,
        receivedAt: new Date(opts.lastMessageAt.getTime() - i * 1000),
        isUnread: i < (opts.unread ?? 0),
        labels: ["INBOX"],
        inReplyTo: null,
        references: [],
      },
    });
  }
  return thread.id;
}

describe("listThreadsForUser", () => {
  it("returns threads ordered by lastMessageAt DESC for the user's accounts", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const older = await createThread(accountId, {
      subject: "Older",
      lastMessageAt: new Date("2026-05-10T10:00:00Z"),
    });
    const newer = await createThread(accountId, {
      subject: "Newer",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });

    const result = await listThreadsForUser(userId, {});
    expect(result.threads.map((t) => t.id)).toEqual([newer, older]);
    expect(result.nextCursor).toBeNull();
  });

  it("filters by accountId when supplied", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await prisma.mailAccount
      .create({
        data: {
          userId,
          provider: "gmail",
          emailAddress: `mbB-${randomUUID()}@example.com`,
          encryptedSecret: randomBytes(16),
          secretIv: randomBytes(12),
          secretTag: randomBytes(16),
        },
      })
      .then((r) => r.id);

    const tA = await createThread(accA, {
      subject: "A-thread",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });
    await createThread(accB, {
      subject: "B-thread",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });

    const result = await listThreadsForUser(userId, { accountId: accA });
    expect(result.threads.map((t) => t.id)).toEqual([tA]);
  });

  it("computes unreadCount server-side from the messages aggregate", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const tid = await createThread(accountId, {
      subject: "Mixed",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      messageCount: 3,
      unread: 2,
    });

    const result = await listThreadsForUser(userId, {});
    const row = result.threads.find((t) => t.id === tid);
    expect(row?.unreadCount).toBe(2);
  });

  it("paginates via cursor and exposes nextCursor when more rows exist", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(
        await createThread(accountId, {
          subject: `T${i}`,
          lastMessageAt: new Date(2026, 4, 12, 10, 0, i),
        }),
      );
    }
    ids.reverse(); // expected order: newest first

    const page1 = await listThreadsForUser(userId, { limit: 2 });
    expect(page1.threads.map((t) => t.id)).toEqual(ids.slice(0, 2));
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listThreadsForUser(userId, {
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.threads.map((t) => t.id)).toEqual(ids.slice(2, 4));
  });

  it("returns an empty list when the user has no accounts", async () => {
    const user = await prisma.user.create({
      data: { email: `lonely-${randomUUID()}@example.com` },
    });
    createdUserIds.push(user.id);

    const result = await listThreadsForUser(user.id, {});
    expect(result.threads).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it("excludes threads whose labels do not contain INBOX", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const inboxThread = await createThread(accountId, {
      subject: "InInbox",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    await createThread(accountId, {
      subject: "StarredOnly",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["STARRED"],
    });

    const result = await listThreadsForUser(userId, {});
    expect(result.threads.map((t) => t.id)).toEqual([inboxThread]);
  });

  it("excludes threads with both INBOX and TRASH (treated as trashed)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const inboxThread = await createThread(accountId, {
      subject: "Active",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    await createThread(accountId, {
      subject: "Trashed",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["INBOX", "TRASH"],
    });

    const result = await listThreadsForUser(userId, {});
    expect(result.threads.map((t) => t.id)).toEqual([inboxThread]);
  });
});

describe("getThreadByIdForUser", () => {
  it("returns the thread when it belongs to one of the user's accounts", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const tid = await createThread(accountId, {
      subject: "Own",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });

    const thread = await getThreadByIdForUser(userId, tid);
    expect(thread?.id).toBe(tid);
    expect(thread?.account.id).toBe(accountId);
  });

  it("returns null when the thread belongs to a different user (ownership scoping)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const otherTid = await createThread(b.accountId, {
      subject: "Other",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });

    const thread = await getThreadByIdForUser(a.userId, otherTid);
    expect(thread).toBeNull();
  });
});
