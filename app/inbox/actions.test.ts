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
import type { CanonicalThread } from "@/lib/providers/types";
import type { Prisma } from "@prisma/client";
import {
  archiveThreads,
  getLabelsForThreads,
  getThread,
  listAvailableLabels,
  listThreads,
  markThreadRead,
  searchThreads,
  setThreadLabels,
  trashThreads,
} from "./actions";

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
    // Canonical reconnect prompt — never the raw AuthError message (which a
    // verbose adapter like Graph can fill with tenant detail).
    expect(result.error).toBe("Please reconnect this account to continue.");

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

// ── shared helpers for new actions ─────────────────────────────────────────

async function addAccount(userId: string): Promise<string> {
  const acc = await prisma.mailAccount.create({
    data: {
      userId,
      provider: "gmail",
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: randomBytes(16),
      secretIv: randomBytes(12),
      secretTag: randomBytes(16),
    },
  });
  return acc.id;
}

async function getThreadLabels(threadId: string): Promise<string[]> {
  const t = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { labels: true },
  });
  return (t.labels as unknown[]).filter((l): l is string => typeof l === "string");
}

async function setThreadLabelsRaw(threadId: string, labels: string[]): Promise<void> {
  await prisma.thread.update({
    where: { id: threadId },
    data: { labels: labels as unknown as Prisma.InputJsonValue },
  });
}

function makeCanonicalThread(overrides: Partial<CanonicalThread> = {}): CanonicalThread {
  return {
    id: `ct-${randomUUID()}`,
    accountId: "acc",
    subject: "Subj",
    snippet: "Snip",
    participants: [{ name: "Alice", email: "alice@example.com" }],
    lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    unreadCount: 0,
    labels: [],
    messageIds: [],
    ...overrides,
  };
}

// ── searchThreads ──────────────────────────────────────────────────────────

describe("searchThreads", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await searchThreads({ query: "hello" });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("returns Invalid input when the query is empty", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const result = await searchThreads({ query: "" });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("single account — calls provider.search(query, {limit}) and returns the mapped results", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const t1 = makeCanonicalThread({
      id: "remote-1",
      subject: "Hello world",
      snippet: "world",
      lastMessageAt: new Date("2026-05-12T12:00:00Z"),
      unreadCount: 1,
    });
    const search = vi.fn(async () => ({ items: [t1], nextCursor: null }));
    getProviderMock.mockResolvedValue(makeProvider({ search }));

    const result = await searchThreads({ query: "hello", limit: 25 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith("hello", { limit: 25 });
    expect(result.data.threads).toHaveLength(1);
    expect(result.data.threads[0]?.id).toBe("remote-1");
    expect(result.data.threads[0]?.accountId).toBe(accountId);
    expect(result.data.threads[0]?.subject).toBe("Hello world");
    expect(result.data.threads[0]?.unreadCount).toBe(1);
  });

  it("multi-account — queries each provider, merges and sorts by lastMessageAt desc", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const aThread = makeCanonicalThread({
      id: "a-1",
      subject: "From A",
      lastMessageAt: new Date("2026-05-10T10:00:00Z"),
    });
    const bThread = makeCanonicalThread({
      id: "b-1",
      subject: "From B",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });
    const aSearch = vi.fn(async () => ({ items: [aThread], nextCursor: null }));
    const bSearch = vi.fn(async () => ({ items: [bThread], nextCursor: null }));
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ search: aSearch });
      if (accountId === accB) return makeProvider({ search: bSearch });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await searchThreads({ query: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(aSearch).toHaveBeenCalledTimes(1);
    expect(bSearch).toHaveBeenCalledTimes(1);
    expect(result.data.threads.map((t) => t.id)).toEqual(["b-1", "a-1"]);
  });

  it("multi-account — when one provider throws, the other's results are still returned", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const goodThread = makeCanonicalThread({
      id: "good-1",
      subject: "Good",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
    });
    const aSearch = vi.fn(async () => ({ items: [goodThread], nextCursor: null }));
    const bSearch = vi.fn(async () => {
      throw new Error("boom");
    });
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ search: aSearch });
      if (accountId === accB) return makeProvider({ search: bSearch });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await searchThreads({ query: "x" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.threads.map((t) => t.id)).toEqual(["good-1"]);
  });

  it("returns an empty list (not an error) when the user has no accounts", async () => {
    const user = await prisma.user.create({
      data: { email: `nx-${randomUUID()}@example.com` },
    });
    createdUserIds.push(user.id);
    authMock.mockResolvedValue({ user: { id: user.id } } as never);

    const result = await searchThreads({ query: "anything" });
    expect(result).toEqual({ ok: true, data: { threads: [], nextCursor: null } });
  });
});

// ── archiveThreads ─────────────────────────────────────────────────────────

describe("archiveThreads", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await archiveThreads({ threadIds: ["c123456789012345678901234"] });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("Zod rejects an empty threadIds array", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const result = await archiveThreads({ threadIds: [] });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("happy path single account — provider.archive called with message ids, INBOX removed", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId, messageIds } = await createThread(accountId, { messageCount: 2 });
    const providerMessageIds = await prisma.message
      .findMany({ where: { id: { in: messageIds } }, select: { providerMessageId: true } })
      .then((rs) => rs.map((r) => r.providerMessageId));

    const archive = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ archive }));

    const result = await archiveThreads({ threadIds: [threadId] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(1);
    expect(result.data.failedAccountIds).toEqual([]);
    expect(archive).toHaveBeenCalledTimes(1);
    const archiveCall = archive.mock.calls[0];
    if (!archiveCall) throw new Error("archive expected to be called");
    const [calledIds] = archiveCall as unknown as [string[]];
    expect([...calledIds].sort()).toEqual([...providerMessageIds].sort());

    expect(await getThreadLabels(threadId)).not.toContain("INBOX");
  });

  it("multi-account — groups by accountId and fans out one provider call per group", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: tA } = await createThread(accA, {});
    const { threadId: tB } = await createThread(accB, {});

    const archiveA = vi.fn(async () => undefined);
    const archiveB = vi.fn(async () => undefined);
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ archive: archiveA });
      if (accountId === accB) return makeProvider({ archive: archiveB });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await archiveThreads({ threadIds: [tA, tB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(2);
    expect(archiveA).toHaveBeenCalledTimes(1);
    expect(archiveB).toHaveBeenCalledTimes(1);
    expect(await getThreadLabels(tA)).not.toContain("INBOX");
    expect(await getThreadLabels(tB)).not.toContain("INBOX");
  });

  it("rejects the whole batch with Forbidden when any thread is not owned (no DB write)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const { threadId: aThreadId } = await createThread(a.accountId, {});
    const { threadId: bThreadId } = await createThread(b.accountId, {});

    const archive = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ archive }));

    const result = await archiveThreads({ threadIds: [aThreadId, bThreadId] });
    expect(result).toEqual({ ok: false, error: "Forbidden: thread not owned" });
    expect(archive).not.toHaveBeenCalled();
    // a's thread was NOT mutated — INBOX should still be there.
    expect(await getThreadLabels(aThreadId)).toContain("INBOX");
  });

  it("reverts local labels when the provider throws", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});
    await setThreadLabelsRaw(threadId, ["INBOX", "STARRED"]);

    const archive = vi.fn(async () => {
      throw new Error("boom");
    });
    getProviderMock.mockResolvedValue(makeProvider({ archive }));

    const result = await archiveThreads({ threadIds: [threadId] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(0);
    expect(result.data.failedAccountIds).toEqual([accountId]);

    // Pre-action labels are restored.
    expect(await getThreadLabels(threadId)).toEqual(["INBOX", "STARRED"]);
  });

  it("partial multi-account failure — A succeeds, B reverts, updatedCount reflects A only", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: tA } = await createThread(accA, {});
    const { threadId: tB } = await createThread(accB, {});

    const archiveA = vi.fn(async () => undefined);
    const archiveB = vi.fn(async () => {
      throw new Error("boom-b");
    });
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ archive: archiveA });
      if (accountId === accB) return makeProvider({ archive: archiveB });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await archiveThreads({ threadIds: [tA, tB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(1);
    expect(result.data.failedAccountIds).toEqual([accB]);

    expect(await getThreadLabels(tA)).not.toContain("INBOX"); // A stays archived
    expect(await getThreadLabels(tB)).toContain("INBOX"); // B reverted
  });
});

// ── trashThreads ───────────────────────────────────────────────────────────

describe("trashThreads", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await trashThreads({ threadIds: ["c123456789012345678901234"] });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("Zod rejects an empty threadIds array", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const result = await trashThreads({ threadIds: [] });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("happy path single account — provider.trash called, TRASH added and INBOX removed", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});

    const trash = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ trash }));

    const result = await trashThreads({ threadIds: [threadId] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(1);
    expect(trash).toHaveBeenCalledTimes(1);

    const labels = await getThreadLabels(threadId);
    expect(labels).toContain("TRASH");
    expect(labels).not.toContain("INBOX");
  });

  it("multi-account — fans out one provider call per group", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: tA } = await createThread(accA, {});
    const { threadId: tB } = await createThread(accB, {});

    const trashA = vi.fn(async () => undefined);
    const trashB = vi.fn(async () => undefined);
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ trash: trashA });
      if (accountId === accB) return makeProvider({ trash: trashB });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await trashThreads({ threadIds: [tA, tB] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(2);
    expect(trashA).toHaveBeenCalledTimes(1);
    expect(trashB).toHaveBeenCalledTimes(1);
  });

  it("rejects with Forbidden when any thread is not owned (no DB write)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const { threadId: aThreadId } = await createThread(a.accountId, {});
    const { threadId: bThreadId } = await createThread(b.accountId, {});

    const trash = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ trash }));

    const result = await trashThreads({ threadIds: [aThreadId, bThreadId] });
    expect(result).toEqual({ ok: false, error: "Forbidden: thread not owned" });
    expect(trash).not.toHaveBeenCalled();
    expect(await getThreadLabels(aThreadId)).toContain("INBOX");
    expect(await getThreadLabels(aThreadId)).not.toContain("TRASH");
  });

  it("reverts local labels when the provider throws", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});
    await setThreadLabelsRaw(threadId, ["INBOX", "STARRED"]);

    const trash = vi.fn(async () => {
      throw new Error("boom");
    });
    getProviderMock.mockResolvedValue(makeProvider({ trash }));

    const result = await trashThreads({ threadIds: [threadId] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(0);
    expect(result.data.failedAccountIds).toEqual([accountId]);

    expect(await getThreadLabels(threadId)).toEqual(["INBOX", "STARRED"]);
  });
});

// ── setThreadLabels ────────────────────────────────────────────────────────

describe("setThreadLabels", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await setThreadLabels({
      threadIds: ["c123456789012345678901234"],
      add: ["Work"],
      remove: [],
    });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("Zod rejects an empty threadIds array", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const result = await setThreadLabels({ threadIds: [], add: ["Work"], remove: [] });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("rejects with Forbidden when any thread is not owned", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const { threadId: aThreadId } = await createThread(a.accountId, {});
    const { threadId: bThreadId } = await createThread(b.accountId, {});

    const setLabels = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    const result = await setThreadLabels({
      threadIds: [aThreadId, bThreadId],
      add: ["Work"],
      remove: [],
    });
    expect(result).toEqual({ ok: false, error: "Forbidden: thread not owned" });
    expect(setLabels).not.toHaveBeenCalled();
  });

  it("add only — provider.setLabels called and local labels include the addition", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});

    const setLabels = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    const result = await setThreadLabels({
      threadIds: [threadId],
      add: ["Work"],
      remove: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(setLabels).toHaveBeenCalledTimes(1);
    const call = setLabels.mock.calls[0];
    if (!call) throw new Error("setLabels expected to be called");
    const [, addArg, removeArg] = call as unknown as [string[], string[], string[]];
    expect(addArg).toEqual(["Work"]);
    expect(removeArg).toEqual([]);

    const labels = await getThreadLabels(threadId);
    expect(labels).toContain("Work");
    expect(labels).toContain("INBOX");
  });

  it("remove only — local labels drop the removed entry", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});
    await setThreadLabelsRaw(threadId, ["INBOX", "Work"]);

    const setLabels = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    const result = await setThreadLabels({
      threadIds: [threadId],
      add: [],
      remove: ["Work"],
    });
    expect(result.ok).toBe(true);
    expect(await getThreadLabels(threadId)).toEqual(["INBOX"]);
  });

  it("add + remove combined — both diffs apply", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});
    await setThreadLabelsRaw(threadId, ["INBOX", "Work"]);

    const setLabels = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    await setThreadLabels({
      threadIds: [threadId],
      add: ["Personal"],
      remove: ["Work"],
    });

    const labels = await getThreadLabels(threadId);
    expect(labels).toEqual(expect.arrayContaining(["INBOX", "Personal"]));
    expect(labels).not.toContain("Work");
  });

  it("no-op when both add and remove are empty — provider not called, ok:true", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});

    const setLabels = vi.fn(async () => undefined);
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    const result = await setThreadLabels({ threadIds: [threadId], add: [], remove: [] });
    expect(result).toEqual({ ok: true, data: { updatedCount: 0, failedAccountIds: [] } });
    expect(setLabels).not.toHaveBeenCalled();
    expect(await getThreadLabels(threadId)).toEqual(["INBOX"]);
  });

  it("multi-account — fans out one provider call per group", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: tA } = await createThread(accA, {});
    const { threadId: tB } = await createThread(accB, {});

    const setLabelsA = vi.fn(async () => undefined);
    const setLabelsB = vi.fn(async () => undefined);
    getProviderMock.mockImplementation(async (accountId: string) => {
      if (accountId === accA) return makeProvider({ setLabels: setLabelsA });
      if (accountId === accB) return makeProvider({ setLabels: setLabelsB });
      throw new Error(`unexpected accountId ${accountId}`);
    });

    const result = await setThreadLabels({
      threadIds: [tA, tB],
      add: ["Work"],
      remove: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.updatedCount).toBe(2);
    expect(setLabelsA).toHaveBeenCalledTimes(1);
    expect(setLabelsB).toHaveBeenCalledTimes(1);
  });

  it("reverts local labels when the provider throws", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId, {});
    await setThreadLabelsRaw(threadId, ["INBOX", "STARRED"]);

    const setLabels = vi.fn(async () => {
      throw new Error("boom");
    });
    getProviderMock.mockResolvedValue(makeProvider({ setLabels }));

    const result = await setThreadLabels({
      threadIds: [threadId],
      add: ["Work"],
      remove: ["STARRED"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.failedAccountIds).toEqual([accountId]);

    expect(await getThreadLabels(threadId)).toEqual(["INBOX", "STARRED"]);
  });
});

// ── listAvailableLabels ────────────────────────────────────────────────────

describe("listAvailableLabels", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await listAvailableLabels({});
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("returns a deduped + sorted union of labels across the user's threads", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: a } = await createThread(accountId, {});
    const { threadId: b } = await createThread(accountId, {});
    const { threadId: c } = await createThread(accountId, {});
    await setThreadLabelsRaw(a, ["INBOX", "Work", "STARRED"]);
    await setThreadLabelsRaw(b, ["INBOX", "Personal", "Work"]);
    await setThreadLabelsRaw(c, ["INBOX"]);

    const result = await listAvailableLabels({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).toEqual(["INBOX", "Personal", "STARRED", "Work"]);
  });

  it("filters by accountId when supplied", async () => {
    const { userId, accountId: accA } = await createUserWithAccount();
    const accB = await addAccount(userId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const { threadId: tA } = await createThread(accA, {});
    const { threadId: tB } = await createThread(accB, {});
    await setThreadLabelsRaw(tA, ["INBOX", "AOnly"]);
    await setThreadLabelsRaw(tB, ["INBOX", "BOnly"]);

    const result = await listAvailableLabels({ accountId: accA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).toEqual(["AOnly", "INBOX"]);
  });

  it("does not leak labels from another user's threads", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId: aThread } = await createThread(a.accountId, {});
    const { threadId: bThread } = await createThread(b.accountId, {});
    await setThreadLabelsRaw(aThread, ["INBOX", "AOnly"]);
    await setThreadLabelsRaw(bThread, ["INBOX", "BSecret"]);

    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const result = await listAvailableLabels({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).not.toContain("BSecret");
    expect(result.data.labels).toContain("AOnly");
  });
});

// ── getLabelsForThreads ────────────────────────────────────────────────────

describe("getLabelsForThreads", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await getLabelsForThreads({
      threadIds: ["c123456789012345678901234"],
    });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("Zod rejects an empty threadIds array", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const result = await getLabelsForThreads({ threadIds: [] });
    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("returns the deduped, sorted union of labels across the given threads", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId: a } = await createThread(accountId, {});
    const { threadId: b } = await createThread(accountId, {});
    await setThreadLabelsRaw(a, ["INBOX", "Work", "STARRED"]);
    await setThreadLabelsRaw(b, ["INBOX", "Personal", "Work"]);

    const result = await getLabelsForThreads({ threadIds: [a, b] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).toEqual(["INBOX", "Personal", "STARRED", "Work"]);
  });

  it("silently drops thread ids the caller does not own (no info leak)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId: aThread } = await createThread(a.accountId, {});
    const { threadId: bThread } = await createThread(b.accountId, {});
    await setThreadLabelsRaw(aThread, ["INBOX", "AOnly"]);
    await setThreadLabelsRaw(bThread, ["INBOX", "BSecret"]);

    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const result = await getLabelsForThreads({ threadIds: [aThread, bThread] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).not.toContain("BSecret");
    expect(result.data.labels).toEqual(["AOnly", "INBOX"]);
  });

  it("returns an empty list when no threads in the set are owned", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId: bThread } = await createThread(b.accountId, {});
    await setThreadLabelsRaw(bThread, ["INBOX", "BSecret"]);

    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const result = await getLabelsForThreads({ threadIds: [bThread] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.labels).toEqual([]);
  });
});
