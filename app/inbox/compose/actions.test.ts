// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { AuthError, RateLimitError } from "@/lib/providers/errors";
import type { IEmailProvider } from "@/lib/providers/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth + provider registry BEFORE the actions module is imported so the
// mocks are in place when the module's top-level imports resolve.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/providers", () => ({
  getProviderForAccount: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { getProviderForAccount } from "@/lib/providers";
import { discardDraft, getDraft, sendDraft, upsertDraft } from "./actions";

const authMock = vi.mocked(auth);
const getProviderMock = vi.mocked(getProviderForAccount);

function makeProvider(overrides: Partial<IEmailProvider> = {}): IEmailProvider {
  return {
    listThreads: vi.fn(async () => ({ items: [], nextCursor: null })),
    getThread: vi.fn(async () => {
      throw new Error("not used");
    }),
    sendMessage: vi.fn(async () => ({ id: "new-msg-id", threadId: "new-thread-id" })),
    reply: vi.fn(async () => ({ id: "reply-msg-id" })),
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
    data: { email: `compose-act-${randomUUID()}@example.com` },
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
  opts: { providerThreadId?: string } = {},
): Promise<{ threadId: string; providerThreadId: string }> {
  const providerThreadId = opts.providerThreadId ?? `pth-${randomUUID()}`;
  const thread = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId,
      subject: "Re: Hello",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      unreadCount: 0,
      labels: ["INBOX"],
      participants: [{ name: "Sender", email: "sender@example.com" }],
    },
  });
  return { threadId: thread.id, providerThreadId };
}

function makeSendFormData(fields: {
  draftId?: string;
  accountId: string;
  threadId?: string | null;
  mode: "new" | "reply" | "reply-all" | "forward";
  to?: { name?: string; email: string }[];
  cc?: { name?: string; email: string }[];
  bcc?: { name?: string; email: string }[];
  subject?: string;
  bodyHtml?: string;
  inReplyTo?: string[];
  references?: string[];
  attachments?: File[];
}): FormData {
  const fd = new FormData();
  if (fields.draftId) fd.set("draftId", fields.draftId);
  fd.set("accountId", fields.accountId);
  fd.set(
    "threadId",
    fields.threadId === undefined ? "" : fields.threadId === null ? "" : fields.threadId,
  );
  fd.set("mode", fields.mode);
  fd.set("to", JSON.stringify(fields.to ?? [{ email: "rcpt@example.com" }]));
  fd.set("cc", JSON.stringify(fields.cc ?? []));
  fd.set("bcc", JSON.stringify(fields.bcc ?? []));
  fd.set("subject", fields.subject ?? "Hello");
  fd.set("bodyHtml", fields.bodyHtml ?? "<p>hi</p>");
  if (fields.inReplyTo) fd.set("inReplyTo", JSON.stringify(fields.inReplyTo));
  if (fields.references) fd.set("references", JSON.stringify(fields.references));
  for (const f of fields.attachments ?? []) {
    fd.append("attachments", f);
  }
  return fd;
}

// ── upsertDraft ────────────────────────────────────────────────────────────

describe("upsertDraft", () => {
  it("rejects with Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const { accountId } = await createUserWithAccount();

    const result = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      bodyHtml: "",
    });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
  });

  it("happy path — creates a Draft row and returns its id + updatedAt", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const result = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      bodyHtml: "<p>hi</p>",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.data.draftId).toBe("string");
    expect(result.data.updatedAt).toBeInstanceOf(Date);

    const row = await prisma.draft.findUnique({ where: { id: result.data.draftId } });
    expect(row?.userId).toBe(userId);
    expect(row?.subject).toBe("Hello");
  });

  it("happy path (existing slot) — second call updates the same row id; updatedAt advances", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const first = await upsertDraft({
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "First",
      bodyHtml: "<p>1</p>",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await new Promise((r) => setTimeout(r, 5));

    const second = await upsertDraft({
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "Second",
      bodyHtml: "<p>2</p>",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.data.draftId).toBe(first.data.draftId);
    expect(second.data.updatedAt.getTime()).toBeGreaterThanOrEqual(first.data.updatedAt.getTime());
    const row = await prisma.draft.findUnique({ where: { id: first.data.draftId } });
    expect(row?.subject).toBe("Second");
  });

  it("rejects with 'Invalid input' when an email in `to` is malformed", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const result = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "not-an-email" }],
      cc: [],
      bcc: [],
      subject: "",
      bodyHtml: "",
    });

    expect(result).toEqual({ ok: false, error: "Invalid input" });
  });

  it("rejects when accountId is not owned by the user (ownership check)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const result = await upsertDraft({
      accountId: b.accountId, // someone else's account
      threadId: null,
      mode: "new",
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      bodyHtml: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Account not found|Forbidden/);
  });
});

// ── discardDraft ───────────────────────────────────────────────────────────

describe("discardDraft", () => {
  it("happy path — deletes the row and returns ok", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const created = await upsertDraft({
      accountId,
      threadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "S",
      bodyHtml: "<p>B</p>",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await discardDraft({ draftId: created.data.draftId });
    expect(result.ok).toBe(true);

    const survivor = await prisma.draft.findUnique({
      where: { id: created.data.draftId },
    });
    expect(survivor).toBeNull();
  });

  it("ownership — passing another user's draftId does not delete it (matches deleteMany semantics)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId: bThreadId } = await createThread(b.accountId);

    // Create draft as user B.
    authMock.mockResolvedValue({ user: { id: b.userId } } as never);
    const bDraft = await upsertDraft({
      accountId: b.accountId,
      threadId: bThreadId,
      mode: "reply",
      to: [],
      cc: [],
      bcc: [],
      subject: "B",
      bodyHtml: "<p>B</p>",
    });
    expect(bDraft.ok).toBe(true);
    if (!bDraft.ok) return;

    // Switch session to user A and try to discard B's draft.
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);
    const result = await discardDraft({ draftId: bDraft.data.draftId });
    // Implementation rejects with "Draft not found" (the ownership check is
    // an explicit getDraftByIdForUser before deleteMany).
    expect(result.ok).toBe(false);

    // The row must survive — verifies ownership scoping.
    const survivor = await prisma.draft.findUnique({
      where: { id: bDraft.data.draftId },
    });
    expect(survivor).not.toBeNull();
  });
});

// ── getDraft ──────────────────────────────────────────────────────────────

describe("getDraft", () => {
  it("happy path — returns the row's DraftDTO", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const created = await upsertDraft({
      accountId,
      threadId,
      mode: "reply",
      to: [{ name: "Alice", email: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Re: Hello",
      bodyHtml: "<p>body</p>",
      inReplyTo: ["msg-1"],
      references: ["msg-0", "msg-1"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await getDraft({ threadId, mode: "reply" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).not.toBeNull();
    if (!result.data) return;
    expect(result.data.id).toBe(created.data.draftId);
    expect(result.data.accountId).toBe(accountId);
    expect(result.data.threadId).toBe(threadId);
    expect(result.data.mode).toBe("reply");
    expect(result.data.subject).toBe("Re: Hello");
    expect(result.data.to).toEqual([{ name: "Alice", email: "alice@example.com" }]);
    expect(result.data.inReplyTo).toEqual(["msg-1"]);
    expect(result.data.references).toEqual(["msg-0", "msg-1"]);
    expect(result.data.updatedAt).toBeInstanceOf(Date);
  });

  it("returns ok:true with data:null when no row exists in the slot", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const result = await getDraft({ threadId, mode: "reply" });
    expect(result).toEqual({ ok: true, data: null });
  });
});

// ── sendDraft ─────────────────────────────────────────────────────────────

describe("sendDraft", () => {
  it("happy path (new compose) — calls provider.sendMessage with the SendDraft, returns ids, deletes the draft row", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    // Pre-existing draft row that should be deleted on success.
    const created = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      bodyHtml: "<p>hello</p>",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const sendMessage = vi.fn(async () => ({ id: "pm-1", threadId: "pt-1" }));
    const reply = vi.fn(async () => ({ id: "should-not-call" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage, reply }));

    const fd = makeSendFormData({
      draftId: created.data.draftId,
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      subject: "Hi",
      bodyHtml: "<p>hello</p>",
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({ providerMessageId: "pm-1", providerThreadId: "pt-1" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();

    const draftAfter = await prisma.draft.findUnique({
      where: { id: created.data.draftId },
    });
    expect(draftAfter).toBeNull();
  });

  it("happy path (reply) — calls provider.reply(providerThreadId, ...), NOT sendMessage", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId, providerThreadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "should-not-call", threadId: "x" }));
    const reply = vi.fn(async () => ({ id: "reply-msg-id" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage, reply }));

    const fd = makeSendFormData({
      accountId,
      threadId,
      mode: "reply",
      to: [{ email: "rcpt@example.com" }],
      subject: "Re: Hi",
      bodyHtml: "<p>reply</p>",
      inReplyTo: ["msg-1"],
      references: ["msg-0", "msg-1"],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.providerMessageId).toBe("reply-msg-id");
    expect(result.data.providerThreadId).toBe(providerThreadId);

    expect(reply).toHaveBeenCalledTimes(1);
    const replyCall = reply.mock.calls[0];
    if (!replyCall) throw new Error("reply expected to be called");
    expect((replyCall as unknown as [string, unknown])[0]).toBe(providerThreadId);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("outbound sanitization — strips <script> from bodyHtml before passing to the adapter (defense-in-depth)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "pm-2", threadId: "pt-2" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      bodyHtml: "<script>alert(1)</script><p>hi</p>",
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(true);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const sendCall = sendMessage.mock.calls[0];
    if (!sendCall) throw new Error("sendMessage expected to be called");
    const draftArg = (sendCall as unknown as [{ bodyHtml: string }])[0];
    expect(draftArg.bodyHtml).not.toMatch(/<script\b/i);
    expect(draftArg.bodyHtml).toContain("<p>hi</p>");
  });

  it("attachment too large — returns 25 MB error, provider NOT called", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "no", threadId: "no" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    // Two 13 MB files = 26 MB > 25 MB cap.
    const big = (size: number, name: string) =>
      new File([new Uint8Array(size)], name, { type: "application/octet-stream" });

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      attachments: [big(13 * 1024 * 1024, "a.bin"), big(13 * 1024 * 1024, "b.bin")],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/25 MB/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("denied MIME — returns blocked error, provider NOT called", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "no", threadId: "no" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const evil = new File([new Uint8Array(10)], "evil.exe", {
      type: "application/x-msdownload",
    });

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      attachments: [evil],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/blocked/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("accountId not owned by user — rejects, provider NOT called", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "no", threadId: "no" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const fd = makeSendFormData({
      accountId: b.accountId, // not owned by user A
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Account not found|Forbidden/);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("provider throws AuthError — returns its message AND draft row is preserved", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    // Pre-existing draft row that MUST survive the failed send.
    const created = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      bodyHtml: "<p>hello</p>",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const sendMessage = vi.fn(async () => {
      throw new AuthError("Reconnect Google account");
    });
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const fd = makeSendFormData({
      draftId: created.data.draftId,
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Public error is the fixed canonical reconnect string — never the raw
    // provider message (which Graph can fill with tenant detail).
    expect(result.error).toBe("Please reconnect this account to continue.");
    // Defensive: the raw provider phrase is NOT leaked.
    expect(result.error).not.toContain("Google");
    expect(sendMessage).toHaveBeenCalledTimes(1);

    // CRITICAL: the user's work survives a send failure.
    const survivor = await prisma.draft.findUnique({
      where: { id: created.data.draftId },
    });
    expect(survivor).not.toBeNull();
  });

  it("provider throws RateLimitError — draft is preserved", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const created = await upsertDraft({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: "Hi",
      bodyHtml: "<p>hello</p>",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const sendMessage = vi.fn(async () => {
      throw new RateLimitError("Rate limited, retry later", 30);
    });
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const fd = makeSendFormData({
      draftId: created.data.draftId,
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Canonical wait-and-retry phrase — the original retry-after value (30s)
    // is intentionally not surfaced; the user just retries when they're ready.
    expect(result.error).toBe("Too many requests. Please wait a moment and try again.");

    const survivor = await prisma.draft.findUnique({
      where: { id: created.data.draftId },
    });
    expect(survivor).not.toBeNull();
  });

  it("Zod rejects an invalid mode value", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const sendMessage = vi.fn(async () => ({ id: "no", threadId: "no" }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const fd = new FormData();
    fd.set("accountId", accountId);
    fd.set("threadId", "");
    fd.set("mode", "garbage"); // not in the enum
    fd.set("to", JSON.stringify([{ email: "rcpt@example.com" }]));
    fd.set("cc", JSON.stringify([]));
    fd.set("bcc", JSON.stringify([]));
    fd.set("subject", "Hi");
    fd.set("bodyHtml", "<p>hi</p>");

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
