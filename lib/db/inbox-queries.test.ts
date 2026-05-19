// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  getThreadByIdForUser,
  listDraftsForUser,
  listThreadsForUser,
} from "./inbox-queries";

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

describe("listThreadsForUser folder filter", () => {
  // The folder filter is the core of the new Inbox / Sent / Archived / Spam /
  // Trash navigation. Each test seeds threads with a deliberate label mix
  // and asserts the query returns exactly the expected subset.
  it("folder=sent returns SENT threads and excludes INBOX-only ones", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const inboxOnly = await createThread(accountId, {
      subject: "Inbox-only",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    const sentOnly = await createThread(accountId, {
      subject: "Sent-only",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["SENT"],
    });
    const sentInboxBoth = await createThread(accountId, {
      subject: "Self-cc",
      lastMessageAt: new Date("2026-05-12T12:00:00Z"),
      labels: ["INBOX", "SENT"],
    });

    const sent = await listThreadsForUser(userId, { folder: "sent" });
    const ids = sent.threads.map((t) => t.id).sort();
    expect(ids).toEqual([sentInboxBoth, sentOnly].sort());
    expect(ids).not.toContain(inboxOnly);
  });

  it("folder=sent excludes trashed sends", async () => {
    const { userId, accountId } = await createUserWithAccount();
    await createThread(accountId, {
      subject: "Trashed send",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["SENT", "TRASH"],
    });
    const liveSend = await createThread(accountId, {
      subject: "Active send",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["SENT"],
    });

    const sent = await listThreadsForUser(userId, { folder: "sent" });
    expect(sent.threads.map((t) => t.id)).toEqual([liveSend]);
  });

  it("folder=spam returns SPAM threads only", async () => {
    const { userId, accountId } = await createUserWithAccount();
    await createThread(accountId, {
      subject: "Inbox",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    const spam = await createThread(accountId, {
      subject: "Junk",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["UNREAD", "SPAM"],
    });

    const result = await listThreadsForUser(userId, { folder: "spam" });
    expect(result.threads.map((t) => t.id)).toEqual([spam]);
  });

  it("folder=trash returns TRASH threads (and includes those that were once in inbox)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const trashed = await createThread(accountId, {
      subject: "Deleted",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX", "TRASH"],
    });
    await createThread(accountId, {
      subject: "Live",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["INBOX"],
    });

    const result = await listThreadsForUser(userId, { folder: "trash" });
    expect(result.threads.map((t) => t.id)).toEqual([trashed]);
  });

  it("folder=archived returns threads without INBOX/SPAM/TRASH", async () => {
    const { userId, accountId } = await createUserWithAccount();
    await createThread(accountId, {
      subject: "In inbox",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    const archived = await createThread(accountId, {
      subject: "Archived",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      // Note: no INBOX, no SPAM, no TRASH. Gmail's archive action removes
      // INBOX; the row remains in the user's mailbox with whatever other
      // labels (or none) were applied.
      labels: ["STARRED"],
    });
    await createThread(accountId, {
      subject: "Spam",
      lastMessageAt: new Date("2026-05-12T12:00:00Z"),
      labels: ["SPAM"],
    });
    await createThread(accountId, {
      subject: "Trashed",
      lastMessageAt: new Date("2026-05-12T13:00:00Z"),
      labels: ["TRASH"],
    });

    const result = await listThreadsForUser(userId, { folder: "archived" });
    expect(result.threads.map((t) => t.id)).toEqual([archived]);
  });

  it("folder=all returns every non-trashed thread", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const inbox = await createThread(accountId, {
      subject: "In inbox",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    const sent = await createThread(accountId, {
      subject: "Sent",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["SENT"],
    });
    const spam = await createThread(accountId, {
      subject: "Spam",
      lastMessageAt: new Date("2026-05-12T12:00:00Z"),
      labels: ["SPAM"],
    });
    await createThread(accountId, {
      subject: "Trashed",
      lastMessageAt: new Date("2026-05-12T13:00:00Z"),
      labels: ["TRASH"],
    });

    const result = await listThreadsForUser(userId, { folder: "all", sort: "time" });
    const ids = result.threads.map((t) => t.id).sort();
    expect(ids).toEqual([inbox, sent, spam].sort());
  });

  it("default folder (no opts.folder) keeps the inbox-only behavior", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const inbox = await createThread(accountId, {
      subject: "In inbox",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      labels: ["INBOX"],
    });
    await createThread(accountId, {
      subject: "Sent",
      lastMessageAt: new Date("2026-05-12T11:00:00Z"),
      labels: ["SENT"],
    });

    const result = await listThreadsForUser(userId, {});
    expect(result.threads.map((t) => t.id)).toEqual([inbox]);
  });
});

describe("listDraftsForUser", () => {
  // Drafts come from a separate Prisma table and don't pass through the
  // label-based folder filter. The query joins on `accountId` for the
  // emailAddress label and orders by `updatedAt DESC`.
  it("returns the user's drafts, newest first", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const older = await prisma.draft.create({
      data: {
        userId,
        accountId,
        threadId: null,
        mode: "new",
        to: [{ email: "a@example.com" }],
        cc: [],
        bcc: [],
        subject: "Older draft",
        bodyHtml: "<p>old body</p>",
        inReplyTo: [],
        references: [],
        // Backdate so we can assert ordering.
        updatedAt: new Date("2026-05-10T10:00:00Z"),
      },
    });
    const newer = await prisma.draft.create({
      data: {
        userId,
        accountId,
        threadId: null,
        mode: "new",
        to: [{ email: "b@example.com" }],
        cc: [],
        bcc: [],
        subject: "Newer draft",
        bodyHtml: "<p>new body</p>",
        inReplyTo: [],
        references: [],
        updatedAt: new Date("2026-05-12T10:00:00Z"),
      },
    });

    const result = await listDraftsForUser(userId, {});
    expect(result.drafts.map((d) => d.id)).toEqual([newer.id, older.id]);
    expect(result.drafts[0]?.subject).toBe("Newer draft");
    expect(result.drafts[0]?.toLine).toBe("b@example.com");
  });

  it("excludes drafts owned by other users", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    await prisma.draft.create({
      data: {
        userId: b.userId,
        accountId: b.accountId,
        threadId: null,
        mode: "new",
        to: [],
        cc: [],
        bcc: [],
        subject: "Other user's",
        bodyHtml: "",
        inReplyTo: [],
        references: [],
      },
    });

    const result = await listDraftsForUser(a.userId, {});
    expect(result.drafts).toEqual([]);
  });

  it("scopes by accountId when supplied", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await prisma.mailAccount
      .create({
        data: {
          userId,
          provider: "graph",
          emailAddress: `mbB-${randomUUID()}@example.com`,
          encryptedSecret: randomBytes(16),
          secretIv: randomBytes(12),
          secretTag: randomBytes(16),
        },
      })
      .then((r) => r.id);

    const inA = await prisma.draft.create({
      data: {
        userId,
        accountId: accA,
        threadId: null,
        mode: "new",
        to: [],
        cc: [],
        bcc: [],
        subject: "A",
        bodyHtml: "",
        inReplyTo: [],
        references: [],
      },
    });
    await prisma.draft.create({
      data: {
        userId,
        accountId: accB,
        threadId: null,
        mode: "new",
        to: [],
        cc: [],
        bcc: [],
        subject: "B",
        bodyHtml: "",
        inReplyTo: [],
        references: [],
      },
    });

    const result = await listDraftsForUser(userId, { accountId: accA });
    expect(result.drafts.map((d) => d.id)).toEqual([inA.id]);
  });

  it("derives snippet from bodyHtml by stripping tags and collapsing whitespace", async () => {
    const { userId, accountId } = await createUserWithAccount();
    await prisma.draft.create({
      data: {
        userId,
        accountId,
        threadId: null,
        mode: "new",
        to: [],
        cc: [],
        bcc: [],
        subject: "Subject",
        bodyHtml: "<p>Hello <b>world</b>   with   spaces.</p>",
        inReplyTo: [],
        references: [],
      },
    });

    const result = await listDraftsForUser(userId, {});
    // Tags stripped + runs of whitespace collapsed to single spaces.
    // HTML entities (&nbsp; etc.) are NOT decoded — the snippet is a
    // list-row preview, not a renderable string, and decoding would
    // require pulling in a parser for what's already an approximation.
    expect(result.drafts[0]?.snippet).toBe("Hello world with spaces.");
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
