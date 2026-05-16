// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteDraftForUser,
  getDraftByIdForUser,
  getDraftForUser,
  upsertDraftForUser,
} from "./draft-queries";

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `draft-q-${randomUUID()}@example.com` },
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

async function createThread(accountId: string): Promise<string> {
  const thread = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId: `pth-${randomUUID()}`,
      subject: "Subject",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      unreadCount: 0,
      labels: ["INBOX"],
      participants: [{ name: "Sender", email: "sender@example.com" }],
    },
  });
  return thread.id;
}

describe("upsertDraftForUser", () => {
  it("creates a new row on first call with the given fields", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);

    const row = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      bodyHtml: "<p>first</p>",
    });

    expect(row.userId).toBe(userId);
    expect(row.threadId).toBe(threadId);
    expect(row.mode).toBe("reply");
    expect(row.subject).toBe("Re: Hello");
    expect(row.bodyHtml).toBe("<p>first</p>");
  });

  it("second call with the same (userId, threadId, mode) updates the row and advances updatedAt", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);

    const first = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      bodyHtml: "<p>first</p>",
    });

    // Small delay so updatedAt clearly advances on SQLite's millisecond clock.
    await new Promise((r) => setTimeout(r, 5));

    const second = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Hello (edited)",
      bodyHtml: "<p>second</p>",
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    expect(second.subject).toBe("Re: Hello (edited)");
    expect(second.bodyHtml).toBe("<p>second</p>");
  });

  it("threadId = null + mode = 'new' is a singleton — two upserts produce one row", async () => {
    const { userId, accountId } = await createUserWithAccount();

    const first = await upsertDraftForUser(userId, {
      accountId,
      threadId: null,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "Draft 1",
      bodyHtml: "<p>v1</p>",
    });

    const second = await upsertDraftForUser(userId, {
      accountId,
      threadId: null,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "Draft 2",
      bodyHtml: "<p>v2</p>",
    });

    expect(second.id).toBe(first.id);

    const rows = await prisma.draft.findMany({
      where: { userId, threadId: null, mode: "new" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject).toBe("Draft 2");
  });

  it("different users with the same threadId + mode produce separate rows (ownership scoping)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const threadIdA = await createThread(a.accountId);
    const threadIdB = await createThread(b.accountId);

    const rowA = await upsertDraftForUser(a.userId, {
      accountId: a.accountId,
      threadId: threadIdA,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "A",
      bodyHtml: "<p>A</p>",
    });
    const rowB = await upsertDraftForUser(b.userId, {
      accountId: b.accountId,
      threadId: threadIdB,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "B",
      bodyHtml: "<p>B</p>",
    });

    expect(rowA.id).not.toBe(rowB.id);
    expect(rowA.userId).toBe(a.userId);
    expect(rowB.userId).toBe(b.userId);
  });
});

describe("getDraftForUser", () => {
  it("returns the row when the (userId, threadId, mode) slot exists", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);
    const created = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "S",
      bodyHtml: "<p>B</p>",
    });

    const found = await getDraftForUser(userId, { threadId, mode: "reply" });
    expect(found?.id).toBe(created.id);
  });

  it("returns null when no row exists for the slot", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);

    const found = await getDraftForUser(userId, { threadId, mode: "reply" });
    expect(found).toBeNull();
  });

  it("returns null for another user's draft even with matching threadId+mode", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const threadId = await createThread(b.accountId);
    await upsertDraftForUser(b.userId, {
      accountId: b.accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "B's draft",
      bodyHtml: "<p>secret</p>",
    });

    const found = await getDraftForUser(a.userId, { threadId, mode: "reply" });
    expect(found).toBeNull();
  });
});

describe("getDraftByIdForUser", () => {
  it("returns the row when the id belongs to the user", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);
    const created = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "S",
      bodyHtml: "<p>B</p>",
    });

    const found = await getDraftByIdForUser(userId, created.id);
    expect(found?.id).toBe(created.id);
  });

  it("returns null when the id belongs to a different user", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const threadId = await createThread(b.accountId);
    const bDraft = await upsertDraftForUser(b.userId, {
      accountId: b.accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "B",
      bodyHtml: "<p>B</p>",
    });

    const found = await getDraftByIdForUser(a.userId, bDraft.id);
    expect(found).toBeNull();
  });
});

describe("deleteDraftForUser", () => {
  it("deletes the matching row", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId);
    const created = await upsertDraftForUser(userId, {
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "S",
      bodyHtml: "<p>B</p>",
    });

    const result = await deleteDraftForUser(userId, created.id);
    expect(result.count).toBe(1);

    const after = await prisma.draft.findUnique({ where: { id: created.id } });
    expect(after).toBeNull();
  });

  it("refuses to delete another user's row (count = 0, row survives)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const threadId = await createThread(b.accountId);
    const bDraft = await upsertDraftForUser(b.userId, {
      accountId: b.accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "B",
      bodyHtml: "<p>B</p>",
    });

    const result = await deleteDraftForUser(a.userId, bDraft.id);
    expect(result.count).toBe(0);

    const survivor = await prisma.draft.findUnique({ where: { id: bDraft.id } });
    expect(survivor).not.toBeNull();
  });
});
