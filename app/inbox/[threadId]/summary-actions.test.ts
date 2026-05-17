// @vitest-environment node
//
// Focused unit tests for the `summarizeThread` Server Action. Contracts:
//   - Unauthorized short-circuit.
//   - Rate-limit blocks propagate the retryAfter.
//   - Cached row is served WITHOUT calling the model.
//   - Invalidated row triggers regeneration AND clears `invalidatedAt`.
//   - Malformed model output surfaces the canonical error string and does NOT
//     persist a partial row.

import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be set up before importing the action under test.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  const Anthropic = vi.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
  (Anthropic as unknown as { APIError: typeof APIError }).APIError = APIError;
  return { default: Anthropic };
});

vi.mock("@/lib/ai/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/rate-limit")>(
    "@/lib/ai/rate-limit",
  );
  return { ...actual, checkRateLimit: vi.fn() };
});

import { auth } from "@/lib/auth";
import { checkRateLimit, _resetRateLimit } from "@/lib/ai/rate-limit";
import { summarizeThread } from "./summary-actions";

const authMock = vi.mocked(auth);
const checkRateLimitMock = vi.mocked(checkRateLimit);

const createdUserIds: string[] = [];

beforeEach(() => {
  authMock.mockReset();
  checkRateLimitMock.mockReset();
  checkRateLimitMock.mockReturnValue({ ok: true });
  mockCreate.mockReset();
  _resetRateLimit();
});

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `sa-${randomUUID()}@example.com` },
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

async function createThread(accountId: string): Promise<{ threadId: string }> {
  const thread = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId: `pth-${randomUUID()}`,
      subject: "Subject",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      unreadCount: 0,
      labels: ["INBOX"] as unknown as Prisma.InputJsonValue,
      participants: [
        { name: "Sender", email: "sender@example.com" },
      ] as unknown as Prisma.InputJsonValue,
    },
  });
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
      subject: "Subject",
      snippet: "Snippet",
      bodyHtml: null,
      bodyText: "Body",
      receivedAt: new Date("2026-05-12T09:59:00Z"),
      isUnread: false,
      labels: ["INBOX"] as unknown as Prisma.InputJsonValue,
      inReplyTo: null,
      references: [] as unknown as Prisma.InputJsonValue,
    },
  });
  return { threadId: thread.id };
}

function okToolUseResponse(input: Record<string, unknown>) {
  return {
    id: "msg_x",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5-20251001",
    content: [
      { type: "tool_use", id: "tu_1", name: "report_summary", input },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

describe("summarizeThread", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await summarizeThread({
      threadId: "c123456789012345678901234",
    });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("propagates rate-limit blocks with retryAfterSeconds", async () => {
    const { userId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    checkRateLimitMock.mockReturnValue({ ok: false, retryAfterSeconds: 5 });

    const result = await summarizeThread({
      threadId: "c123456789012345678901234",
    });
    expect(result).toEqual({
      ok: false,
      error: "Rate limit exceeded",
      retryAfterSeconds: 5,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns the cached summary without calling the model", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId);

    await prisma.aISummary.create({
      data: {
        threadId,
        tldr: "Cached tldr",
        ask: "Cached ask",
        decision: null,
        deadline: null,
        model: "claude-haiku-4-5-20251001",
        promptVersion: "v1",
        usage: { input_tokens: 1, output_tokens: 1 } as unknown as Prisma.InputJsonValue,
        userMessageJson: "{}",
        invalidatedAt: null,
      },
    });

    const result = await summarizeThread({ threadId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tldr).toBe("Cached tldr");
    expect(result.data.ask).toBe("Cached ask");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("regenerates when the cached row is invalidated, then clears invalidatedAt", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId);

    await prisma.aISummary.create({
      data: {
        threadId,
        tldr: "Stale tldr",
        ask: null,
        decision: null,
        deadline: null,
        model: "claude-haiku-4-5-20251001",
        promptVersion: "v1",
        usage: { input_tokens: 1, output_tokens: 1 } as unknown as Prisma.InputJsonValue,
        userMessageJson: "{}",
        invalidatedAt: new Date(),
      },
    });

    mockCreate.mockResolvedValueOnce(
      okToolUseResponse({ tldr: "Fresh tldr", ask: "Fresh ask" }),
    );

    const result = await summarizeThread({ threadId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.tldr).toBe("Fresh tldr");
    expect(mockCreate).toHaveBeenCalledTimes(1);

    const row = await prisma.aISummary.findUniqueOrThrow({ where: { threadId } });
    expect(row.tldr).toBe("Fresh tldr");
    expect(row.invalidatedAt).toBeNull();
  });

  it("returns the canonical retry error AND does not modify the cached row when the model output is malformed", async () => {
    const { userId, accountId } = await createUserWithAccount();
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    const { threadId } = await createThread(accountId);

    // Seed an invalidated row so the action attempts regeneration.
    const invalidatedAt = new Date();
    await prisma.aISummary.create({
      data: {
        threadId,
        tldr: "Pre-existing tldr",
        ask: null,
        decision: null,
        deadline: null,
        model: "claude-haiku-4-5-20251001",
        promptVersion: "v1",
        usage: { input_tokens: 1, output_tokens: 1 } as unknown as Prisma.InputJsonValue,
        userMessageJson: "{}",
        invalidatedAt,
      },
    });

    // Missing required `tldr` — Zod will reject.
    mockCreate.mockResolvedValueOnce(okToolUseResponse({ ask: "no tldr" }));

    const result = await summarizeThread({ threadId });
    expect(result).toEqual({
      ok: false,
      error: "Summary failed — please retry",
    });

    // Pre-existing row is unchanged — same tldr, same invalidatedAt.
    const row = await prisma.aISummary.findUniqueOrThrow({ where: { threadId } });
    expect(row.tldr).toBe("Pre-existing tldr");
    expect(row.invalidatedAt?.getTime()).toBe(invalidatedAt.getTime());
  });
});
