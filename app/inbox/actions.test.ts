// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "@/lib/providers/errors";
import type { IEmailProvider } from "@/lib/providers/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the auth() session-loader before importing the actions.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

// Mock the provider registry so we don't run real Gmail API calls.
vi.mock("@/lib/providers", () => ({
  getProviderForAccount: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getProviderForAccount } from "@/lib/providers";
import { getThread, listThreads, markThreadRead } from "./actions";

const authMock = vi.mocked(auth);
const getProviderMock = vi.mocked(getProviderForAccount);

function makeProvider(overrides: Partial<IEmailProvider> = {}): IEmailProvider {
  return {
    listThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
    getThread: vi.fn(async () => {
      throw new Error("not used");
    }),
    sendMessage: vi.fn(async () => ({ id: "x", threadId: "y" })),
    reply: vi.fn(async () => ({ id: "x" })),
    archive: vi.fn(async () => undefined),
    trash: vi.fn(async () => undefined),
    markRead: vi.fn(async () => undefined),
    setLabels: vi.fn(async () => undefined),
    search: vi.fn(async () => ({ items: [], nextCursor: null })),
    syncDelta: vi.fn(async () => ({
      newMessages: [],
      changedMessages: [],
      deletedIds: [],
      nextCursor: "",
    })),
    ...overrides,
  };
}

const createdUserIds: string[] = [];

beforeEach(() => {
  authMock.mockReset();
  getProviderMock.mockReset();
});

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `inbox-act-${randomUUID()}@example.com` },
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
    subject?: string;
    lastMessageAt?: Date;
    bodyHtml?: string | null;
    unread?: number;
    messageCount?: number;
  } = {},
): Promise<{ threadId: string; messageIds: string[] }> {
  const thread = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId: `pth-${randomUUID()}`,
      subject: opts.subject ?? "Subject",
      lastMessageAt: opts.lastMessageAt ?? new Date("2026-05-12T10:00:00Z"),
      unreadCount: opts.unread ?? 0,
      labels: ["INBOX"],
      participants: [{ name: "Sender", email: "sender@example.com" }],
    },
  });
  const count = opts.messageCount ?? 1;
  const messageIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const msg = await prisma.message.create({
      data: {
        threadId: thread.id,
        accountId,
        providerMessageId: `pmsg-${randomUUID()}`,
        providerThreadId: thread.providerThreadId,
        from: { name: "Sender", email: "sender@example.com" },
        to: [{ email: "rcpt@example.com" }],
        cc: [],
        bcc: [],
        subject: opts.subject ?? "Subject",
        snippet: `Snippet ${i}`,
        bodyHtml: opts.bodyHtml ?? null,
        bodyText: `Body ${i}`,
        receivedAt: new Date(
          (opts.lastMessageAt ?? new Date("2026-05-12T10:00:00Z")).getTime() - i * 1000,
        ),
        isUnread: i < (opts.unread ?? 0),
        labels: ["INBOX"],
        inReplyTo: null,
        references: [],
      },
    });
    messageIds.push(msg.id);
  }
  return { threadId: thread.id, messageIds };
}

describe("listThreads", () => {
  it("returns the user's threads ordered by lastMessageAt DESC with computed unreadCount", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    await createThread(accountId, {
      subject: "Older",
      lastMessageAt: new Date("2026-05-10T10:00:00Z"),
    });
    await createThread(accountId, {
      subject: "Newer",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      messageCount: 2,
      unread: 1,
    });

    const result = await listThreads({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.threads.map((t) => t.subject)).toEqual(["Newer", "Older"]);
    expect(result.data.threads[0]?.unreadCount).toBe(1);
  });

  it("filters by accountId", async () => {
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
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    await createThread(accA, { subject: "A" });
    await createThread(accB, { subject: "B" });

    const result = await listThreads({ accountId: accA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.threads.map((t) => t.subject)).toEqual(["A"]);
  });

  it("returns empty when passed an accountId the user does not own (no leak)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    await createThread(b.accountId, { subject: "B" });
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const result = await listThreads({ accountId: b.accountId });
    expect(result).toEqual({ ok: true, data: { threads: [], nextCursor: null } });
  });

  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await listThreads({});
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("returns Invalid input on bad input", async () => {
    authMock.mockResolvedValue({ user: { id: "u1" } } as never);
    const bad1 = await listThreads({ limit: -1 } as never);
    expect(bad1).toEqual({ ok: false, error: "Invalid input" });

    const bad2 = await listThreads({ accountId: "not-a-cuid" });
    expect(bad2).toEqual({ ok: false, error: "Invalid input" });
  });
});

describe("getThread", () => {
  it("returns the thread with sanitized message bodies", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { threadId } = await createThread(accountId, {
      subject: "Phish",
      bodyHtml: '<p>Hello</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
    });

    const result = await getThread({ threadId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const body = result.data.messages[0]?.bodyHtml ?? "";
    expect(body).toContain("<p>Hello</p>");
    expect(body).not.toContain("<script");
    expect(body.toLowerCase()).not.toContain("onerror");
  });

  it("returns Not found for a thread that belongs to another user", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId } = await createThread(b.accountId, {});
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const result = await getThread({ threadId });
    expect(result).toEqual({ ok: false, error: "Not found" });
  });

  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    // Even with a fake cuid the Unauthorized branch fires first.
    const result = await getThread({ threadId: "c123456789012345678901234" });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });
});

describe("markThreadRead", () => {
  it("calls provider.markRead with the unread provider ids and clears isUnread in the DB", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { threadId, messageIds } = await createThread(accountId, {
      messageCount: 2,
      unread: 2,
    });
    const unreadProviderIds = await prisma.message
      .findMany({
        where: { id: { in: messageIds } },
        select: { providerMessageId: true },
        orderBy: { receivedAt: "asc" },
      })
      .then((rs) => rs.map((r) => r.providerMessageId));

    const markRead = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ markRead }));

    const result = await markThreadRead({ threadId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(2);
    expect(markRead).toHaveBeenCalledTimes(1);
    const firstCall = markRead.mock.calls[0];
    if (!firstCall) throw new Error("markRead expected to have been called");
    const [calledIds, calledRead] = firstCall as unknown as [string[], boolean];
    expect(calledIds.sort()).toEqual([...unreadProviderIds].sort());
    expect(calledRead).toBe(true);

    const stillUnread = await prisma.message.count({
      where: { threadId, isUnread: true },
    });
    expect(stillUnread).toBe(0);
  });

  it("returns updatedCount=0 and never calls the provider when nothing is unread", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, { messageCount: 2, unread: 0 });

    const markRead = vi.fn();
    getProviderMock.mockResolvedValue(makeProvider({ markRead }));

    const result = await markThreadRead({ threadId });
    expect(result).toEqual({ ok: true, data: { updatedCount: 0 } });
    expect(markRead).not.toHaveBeenCalled();
  });

  it("returns ok:false and does NOT mutate the DB when the provider throws AuthError", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, { messageCount: 2, unread: 2 });

    const markRead = vi.fn(async () => {
      throw new AuthError("reconnect required");
    });
    getProviderMock.mockResolvedValue(makeProvider({ markRead }));

    const result = await markThreadRead({ threadId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("reconnect");

    const stillUnread = await prisma.message.count({
      where: { threadId, isUnread: true },
    });
    expect(stillUnread).toBe(2);
  });

  it("no-ops for a thread owned by another user — provider never called", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId } = await createThread(b.accountId, { messageCount: 2, unread: 2 });
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const markRead = vi.fn();
    getProviderMock.mockResolvedValue(makeProvider({ markRead }));

    const result = await markThreadRead({ threadId });
    expect(result).toEqual({ ok: true, data: { updatedCount: 0 } });
    expect(markRead).not.toHaveBeenCalled();
    expect(getProviderMock).not.toHaveBeenCalled();
  });
});
