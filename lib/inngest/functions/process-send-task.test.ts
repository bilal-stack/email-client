// @vitest-environment node
//
// Tests for the background send-task worker. Pattern matches the other
// Inngest function tests in this directory: we extract the handler from
// the `InngestFunction.fn` property and invoke it with a fake step
// runner. Provider + SSE emitters are mocked at the module boundary so
// we can exercise the full DB write path without real network.

import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "@/lib/providers/errors";
import type { IEmailProvider } from "@/lib/providers/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the provider registry + SSE emitters BEFORE importing the worker
// module so the worker resolves to the mocks at module-import time.
vi.mock("@/lib/providers", () => ({
  getProviderForAccount: vi.fn(),
}));
vi.mock("@/lib/realtime/inbox-events", () => ({
  emitInboxSyncEvent: vi.fn(),
  emitSendTaskCompletedEvent: vi.fn(),
  emitSendTaskFailedEvent: vi.fn(),
}));

import { getProviderForAccount } from "@/lib/providers";
import {
  emitInboxSyncEvent,
  emitSendTaskCompletedEvent,
  emitSendTaskFailedEvent,
} from "@/lib/realtime/inbox-events";
import { processSendTaskFn } from "./process-send-task";

const getProviderMock = vi.mocked(getProviderForAccount);
const emitCompletedMock = vi.mocked(emitSendTaskCompletedEvent);
const emitFailedMock = vi.mocked(emitSendTaskFailedEvent);
const emitSyncMock = vi.mocked(emitInboxSyncEvent);

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

interface FakeStep {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function fakeStep(): FakeStep {
  return { run: (_name, fn) => fn() };
}

interface HandlerCtx {
  step: FakeStep;
  event: { data: { taskId: string; userId: string; accountId: string } };
}

function invokeHandler(event: HandlerCtx["event"]): Promise<unknown> {
  const handler = (
    processSendTaskFn as unknown as { fn: (ctx: HandlerCtx) => Promise<unknown> }
  ).fn;
  return handler({ step: fakeStep(), event });
}

const createdUserIds: string[] = [];

beforeEach(() => {
  getProviderMock.mockReset();
  emitCompletedMock.mockReset();
  emitFailedMock.mockReset();
  emitSyncMock.mockReset();
});

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{
  userId: string;
  accountId: string;
  email: string;
}> {
  const user = await prisma.user.create({
    data: { email: `sendtask-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  const email = `mb-${randomUUID()}@example.com`;
  const account = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "gmail",
      emailAddress: email,
      encryptedSecret: randomBytes(16),
      secretIv: randomBytes(12),
      secretTag: randomBytes(16),
    },
  });
  return { userId: user.id, accountId: account.id, email };
}

async function createSendTaskRow(opts: {
  userId: string;
  accountId: string;
  mode?: "new" | "reply" | "reply-all" | "forward";
  providerThreadId?: string | null;
  threadDbId?: string | null;
  subject?: string;
  attachmentBytes?: Buffer;
}): Promise<string> {
  const row = await prisma.sendTask.create({
    data: {
      userId: opts.userId,
      accountId: opts.accountId,
      mode: opts.mode ?? "new",
      threadId: opts.threadDbId ?? null,
      providerThreadId: opts.providerThreadId ?? null,
      to: [{ email: "rcpt@example.com" }],
      cc: [],
      bcc: [],
      subject: opts.subject ?? "Hi",
      bodyHtml: "<p>hello</p>",
      inReplyTo: null,
      references: [],
    },
  });
  if (opts.attachmentBytes) {
    await prisma.sendTaskAttachment.create({
      data: {
        taskId: row.id,
        filename: "note.txt",
        mimeType: "text/plain",
        size: opts.attachmentBytes.byteLength,
        content: opts.attachmentBytes,
      },
    });
  }
  return row.id;
}

describe("process-send-task worker", () => {
  it("new compose — calls provider.sendMessage, records Message+Thread, deletes SendTask, emits completed", async () => {
    const { userId, accountId, email } = await createUserWithAccount();
    const taskId = await createSendTaskRow({
      userId,
      accountId,
      subject: "Worker happy path",
    });

    const providerMessageId = `pm-${randomUUID()}`;
    const providerThreadId = `pt-${randomUUID()}`;
    const sendMessage = vi.fn(async () => ({
      id: providerMessageId,
      threadId: providerThreadId,
    }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    await invokeHandler({ data: { taskId, userId, accountId } });

    // Provider called exactly once with a SendDraft built from the row.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const draftArg = (sendMessage.mock.calls[0] as unknown as [{ subject: string }])[0];
    expect(draftArg.subject).toBe("Worker happy path");

    // Local Message + Thread now exist, tagged SENT.
    const message = await prisma.message.findUnique({
      where: { accountId_providerMessageId: { accountId, providerMessageId } },
      include: { thread: true },
    });
    expect(message).not.toBeNull();
    expect(message?.from).toEqual({ email });
    const labels = Array.isArray(message?.thread.labels)
      ? (message?.thread.labels as unknown[])
      : [];
    expect(labels).toContain("SENT");

    // SendTask was deleted.
    expect(await prisma.sendTask.findUnique({ where: { id: taskId } })).toBeNull();

    // SSE: completed event + inbox-sync invalidation.
    expect(emitCompletedMock).toHaveBeenCalledTimes(1);
    expect(emitSyncMock).toHaveBeenCalledTimes(1);
    expect(emitFailedMock).not.toHaveBeenCalled();
  });

  it("reply — calls provider.reply with the captured providerThreadId, keeps the local Thread", async () => {
    const { userId, accountId } = await createUserWithAccount();

    // Pre-existing thread the user is replying to.
    const seededProviderThreadId = `pt-existing-${randomUUID()}`;
    const seededThread = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId: seededProviderThreadId,
        subject: "Existing thread",
        lastMessageAt: new Date("2026-05-12T10:00:00Z"),
        unreadCount: 0,
        labels: ["INBOX"],
        participants: [],
      },
    });

    const taskId = await createSendTaskRow({
      userId,
      accountId,
      mode: "reply",
      providerThreadId: seededProviderThreadId,
      threadDbId: seededThread.id,
      subject: "Re: Existing thread",
    });

    const reply = vi.fn(async () => ({ id: `pm-reply-${randomUUID()}` }));
    const sendMessage = vi.fn(async () => ({ id: "should-not-call", threadId: "x" }));
    getProviderMock.mockResolvedValue(makeProvider({ reply, sendMessage }));

    await invokeHandler({ data: { taskId, userId, accountId } });

    expect(reply).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
    const callArgs = reply.mock.calls[0] as unknown as [string, unknown];
    expect(callArgs[0]).toBe(seededProviderThreadId);

    // Reply lands on the SAME local Thread row — recordSentMessage upserts
    // by (accountId, providerThreadId).
    const updated = await prisma.thread.findUnique({
      where: { id: seededThread.id },
      include: { messages: true },
    });
    const labels = Array.isArray(updated?.labels) ? (updated?.labels as unknown[]) : [];
    expect(labels).toContain("INBOX"); // preserved
    expect(labels).toContain("SENT"); // added
    expect(updated?.messages).toHaveLength(1);
  });

  it("attachment bytes are passed through to the provider", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const attachmentBytes = Buffer.from("hello-attachment-bytes", "utf8");
    const taskId = await createSendTaskRow({
      userId,
      accountId,
      attachmentBytes,
    });

    const sendMessage = vi.fn(async () => ({
      id: `pm-${randomUUID()}`,
      threadId: `pt-${randomUUID()}`,
    }));
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    await invokeHandler({ data: { taskId, userId, accountId } });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const draftArg = (sendMessage.mock.calls[0] as unknown as [{ attachments?: unknown[] }])[0];
    expect(Array.isArray(draftArg.attachments)).toBe(true);
    expect(draftArg.attachments).toHaveLength(1);
    const att = (draftArg.attachments as unknown as Array<{ filename: string; content: Buffer }>)[0];
    expect(att.filename).toBe("note.txt");
    expect(Buffer.from(att.content).toString("utf8")).toBe("hello-attachment-bytes");
  });

  it("provider throws AuthError — task flips to failed, error stored, no Message row written, failed SSE emitted", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const taskId = await createSendTaskRow({ userId, accountId });

    const sendMessage = vi.fn(async () => {
      throw new AuthError("Reconnect Google account");
    });
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    await invokeHandler({ data: { taskId, userId, accountId } });

    const task = await prisma.sendTask.findUnique({ where: { id: taskId } });
    expect(task).not.toBeNull();
    expect(task?.status).toBe("failed");
    // Canonical, user-safe message — NOT the raw provider phrase.
    expect(task?.error).toBe("Please reconnect this account to continue.");
    expect(task?.error).not.toContain("Google");

    // No local message row created on failure.
    const messages = await prisma.message.findMany({ where: { accountId } });
    expect(messages).toHaveLength(0);

    expect(emitFailedMock).toHaveBeenCalledTimes(1);
    const failedCall = emitFailedMock.mock.calls[0];
    if (!failedCall) throw new Error("expected emitFailedMock call");
    expect((failedCall as unknown as [string, { taskId: string; error: string }])[1].error).toBe(
      "Please reconnect this account to continue.",
    );
    expect(emitCompletedMock).not.toHaveBeenCalled();
  });

  it("task already deleted (status='sent' or row missing) is a silent no-op", async () => {
    const { userId, accountId } = await createUserWithAccount();

    // Case 1: row missing entirely (user discarded it).
    const phantom = `task-missing-${randomUUID()}`;
    const sendMessage = vi.fn();
    getProviderMock.mockResolvedValue(makeProvider({ sendMessage }));

    const result1 = await invokeHandler({
      data: { taskId: phantom, userId, accountId },
    });
    expect(result1).toEqual({ skipped: true });
    expect(sendMessage).not.toHaveBeenCalled();

    // Case 2: row present but already in `sent` (Inngest retry after the
    // worker finished but before the delete). Still a no-op.
    const sentRow = await prisma.sendTask.create({
      data: {
        userId,
        accountId,
        mode: "new",
        threadId: null,
        providerThreadId: null,
        to: [{ email: "x@y.com" }],
        cc: [],
        bcc: [],
        subject: "Already sent",
        bodyHtml: "<p>x</p>",
        inReplyTo: null,
        references: [],
        status: "sent",
      },
    });
    const result2 = await invokeHandler({
      data: { taskId: sentRow.id, userId, accountId },
    });
    expect(result2).toEqual({ duplicate: true });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
