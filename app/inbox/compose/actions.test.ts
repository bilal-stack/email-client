// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock auth + inngest.send BEFORE the actions module is imported. The
// provider registry mock is preserved because `processSendTask` (the
// worker, exercised in its own test file) uses it; the sendDraft action
// no longer calls the provider directly post-background-send refactor.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));
vi.mock("@/lib/inngest/client", () => ({
  inngest: { send: vi.fn(async () => undefined) },
}));

import { auth } from "@/lib/auth";
import { inngest } from "@/lib/inngest/client";
import { discardDraft, getDraft, sendDraft, upsertDraft } from "./actions";

const authMock = vi.mocked(auth);
const inngestSendMock = vi.mocked(inngest.send);

const createdUserIds: string[] = [];

beforeEach(() => {
  authMock.mockReset();
  inngestSendMock.mockReset();
  inngestSendMock.mockResolvedValue(undefined as never);
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

// ── sendDraft (background queue) ──────────────────────────────────────────
//
// Post-refactor, sendDraft NO LONGER calls the provider directly. It:
//   1. validates input + attachments
//   2. sanitizes bodyHtml
//   3. creates a SendTask row (+ SendTaskAttachment rows)
//   4. enqueues an Inngest event with just the taskId
//   5. deletes the existing Draft row (if any)
//
// The actual provider call lives in `process-send-task.ts` (worker), which
// has its own test file. The assertions here verify the queue handoff and
// the validation cliffs that still belong on the action side.

describe("sendDraft", () => {
  it("happy path (new compose) — creates a SendTask, enqueues the worker event, deletes the draft row", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    // Pre-existing draft row that should be deleted on enqueue success.
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
    expect(typeof result.data.sendTaskId).toBe("string");

    // SendTask row exists with the right fields, in `queued` state.
    const task = await prisma.sendTask.findUnique({
      where: { id: result.data.sendTaskId },
    });
    expect(task).not.toBeNull();
    expect(task?.userId).toBe(userId);
    expect(task?.accountId).toBe(accountId);
    expect(task?.mode).toBe("new");
    expect(task?.status).toBe("queued");
    expect(task?.subject).toBe("Hi");

    // Inngest worker was enqueued with the task id.
    expect(inngestSendMock).toHaveBeenCalledTimes(1);
    const sendCall = inngestSendMock.mock.calls[0];
    if (!sendCall) throw new Error("expected inngest.send call");
    const payload = sendCall[0] as { name: string; data: { taskId: string } };
    expect(payload.name).toBe("inbox/send-task.queued");
    expect(payload.data.taskId).toBe(result.data.sendTaskId);

    // Draft row is gone — the SendTask carries the body now.
    const draftAfter = await prisma.draft.findUnique({
      where: { id: created.data.draftId },
    });
    expect(draftAfter).toBeNull();
  });

  it("happy path (reply) — captures providerThreadId on the SendTask row", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId, providerThreadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);

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

    const task = await prisma.sendTask.findUnique({
      where: { id: result.data.sendTaskId },
    });
    expect(task?.mode).toBe("reply");
    expect(task?.threadId).toBe(threadId);
    // Captured at enqueue time so the worker doesn't have to re-fetch.
    expect(task?.providerThreadId).toBe(providerThreadId);
    // The most-recent inReplyTo is preserved on the task row (only the
    // last id is used at MIME-build time, but the worker still expects it
    // to round-trip).
    expect(task?.inReplyTo).toBe("msg-1");
  });

  it("outbound sanitization — strips <script> from bodyHtml on the persisted SendTask row", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      bodyHtml: "<script>alert(1)</script><p>hi</p>",
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const task = await prisma.sendTask.findUnique({
      where: { id: result.data.sendTaskId },
    });
    // Sanitization must happen BEFORE persistence — the worker passes the
    // stored bodyHtml straight to the provider, so anything we don't
    // strip here goes out over the wire verbatim.
    expect(task?.bodyHtml).not.toMatch(/<script\b/i);
    expect(task?.bodyHtml).toContain("<p>hi</p>");
  });

  it("attachment too large — returns 25 MB error, NO SendTask row created, NO event enqueued", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

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
    expect(inngestSendMock).not.toHaveBeenCalled();
    expect(await prisma.sendTask.count({ where: { userId } })).toBe(0);
  });

  it("denied MIME — returns blocked error, NO SendTask row created", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

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
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("accountId not owned by user — rejects, no enqueue", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

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
    expect(inngestSendMock).not.toHaveBeenCalled();
  });

  it("attachment bytes persist to the SendTaskAttachment table so the worker can stream them later", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    const f = new File([Buffer.from("hello-attachment", "utf8")], "note.txt", {
      type: "text/plain",
    });

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
      attachments: [f],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attachments = await prisma.sendTaskAttachment.findMany({
      where: { taskId: result.data.sendTaskId },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe("note.txt");
    expect(attachments[0]?.mimeType).toBe("text/plain");
    // Byte-perfect round-trip — the worker's RFC 2822 builder needs this.
    expect(Buffer.from(attachments[0]?.content ?? []).toString("utf8")).toBe(
      "hello-attachment",
    );
  });

  it("inngest.send failure rolls back to a user-actionable error; SendTask row remains for diagnosis", async () => {
    // If the Inngest dev server is down, sendDraft should report that
    // failure cleanly (not 500). The row stays around so a future "reaper"
    // / retry path can pick it up; the user just resubmits.
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

    inngestSendMock.mockRejectedValueOnce(new Error("inngest unreachable"));

    const fd = makeSendFormData({
      accountId,
      threadId: null,
      mode: "new",
      to: [{ email: "rcpt@example.com" }],
    });

    const result = await sendDraft(fd);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/queue/i);

    // Row was already inserted — confirms the action returned a clean
    // public message rather than letting the inngest exception bubble.
    expect(await prisma.sendTask.count({ where: { userId } })).toBe(1);
  });

  it("Zod rejects an invalid mode value", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);

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
    expect(inngestSendMock).not.toHaveBeenCalled();
  });
});
