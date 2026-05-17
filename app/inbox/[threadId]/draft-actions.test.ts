// @vitest-environment node
//
// Focused unit tests for `requestAIDraft`. The contracts that matter:
//   - Unauthorized session → `Unauthorized`. No DB / AI side-effects.
//   - Rate-limited (`checkRateLimit` returns ok:false) → fixed canonical
//     "Too many AI requests..." string. The limiter's `retryAfterSeconds`
//     is intentionally NOT exposed.
//   - Cross-user ownership rejection (A tries to use B's accountId) →
//     canonical generic error, NOT a 404 / NOT a leak of which row exists.
//   - Anthropic 429 / 503 / 529 / arbitrary ZodError → one of four fixed
//     canonical strings. Raw `e.message` is NEVER surfaced.

import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mocks — must exist before the SUT imports. `APIError` lives here
// too because the `vi.mock("@anthropic-ai/sdk")` factory needs to construct
// it at top-of-module time (it's hoisted above any top-level class).
const { mockStreamReplyDraft, mockCheckRateLimit, authMock, APIError } = vi.hoisted(() => {
  class APIError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  }
  return {
    mockStreamReplyDraft: vi.fn(),
    mockCheckRateLimit: vi.fn(),
    authMock: vi.fn(),
    APIError,
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  const Anthropic = vi.fn();
  (Anthropic as unknown as { APIError: typeof APIError }).APIError = APIError;
  return { default: Anthropic };
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("@/lib/ai/rate-limit", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/ai/draft", () => ({ streamReplyDraft: mockStreamReplyDraft }));

// `ai/rsc` has no runtime fallback in vitest's Node env — mock the surface
// just enough that the SUT's type import doesn't try to load real code.
// (The SUT only references `StreamableValue` as a type — but it imports it
// from `ai/rsc`. The vi.mock here is belt-and-suspenders.)
vi.mock("ai/rsc", () => ({
  createStreamableValue: vi.fn(),
  readStreamableValue: vi.fn(),
}));

import { requestAIDraft } from "./draft-actions";

const createdUserIds: string[] = [];

beforeEach(() => {
  mockStreamReplyDraft.mockReset();
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockReturnValue({ ok: true });
  authMock.mockReset();
});

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `draft-act-${randomUUID()}@example.com` },
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
      subject: "S",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      unreadCount: 0,
      labels: ["INBOX"] as unknown as object,
      participants: [{ email: "x@example.com" }] as unknown as object,
    },
  });
  return { threadId: thread.id };
}

describe("requestAIDraft", () => {
  it("returns Unauthorized when there is no session", async () => {
    authMock.mockResolvedValue(null as never);
    const result = await requestAIDraft({
      threadId: "c123456789012345678901234",
      accountId: "c123456789012345678901234",
      mode: "reply",
    });
    expect(result).toEqual({ ok: false, error: "Unauthorized" });
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
    expect(mockStreamReplyDraft).not.toHaveBeenCalled();
  });

  it("returns the canonical rate-limit string when checkRateLimit rejects (retryAfterSeconds is NOT exposed)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    mockCheckRateLimit.mockReturnValue({ ok: false, retryAfterSeconds: 5 });

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result).toEqual({
      ok: false,
      error: "Too many AI requests. Please wait a moment.",
    });
    // The retryAfterSeconds value is deliberately not exposed in the public
    // error — a regression that leaks "5" would defeat the intent.
    if (!result.ok) expect(result.error).not.toContain("5");
    expect(mockStreamReplyDraft).not.toHaveBeenCalled();
  });

  it("rejects cross-user ownership with the canonical generic error, never the streamReplyDraft helper", async () => {
    // User A has accountA. User B has accountB and a thread on it.
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const { threadId: bThreadId } = await createThread(b.accountId);
    // A's session calls requestAIDraft with B's threadId AND B's accountId.
    authMock.mockResolvedValue({ user: { id: a.userId } } as never);

    const result = await requestAIDraft({
      threadId: bThreadId,
      accountId: b.accountId,
      mode: "reply",
    });

    expect(result).toEqual({
      ok: false,
      error: "Draft generation failed. Please try again.",
    });
    expect(mockStreamReplyDraft).not.toHaveBeenCalled();
  });

  it("maps Anthropic 429 from streamReplyDraft to the canonical rate-limit string — raw message NOT echoed", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    mockStreamReplyDraft.mockRejectedValue(
      new APIError("request_id=req_abc123 rate limit exceeded", 429),
    );

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result).toEqual({
      ok: false,
      error: "Too many AI requests. Please wait a moment.",
    });
    if (!result.ok) {
      // The raw Anthropic message (including request_id) must not appear.
      expect(result.error).not.toContain("req_abc");
      expect(result.error).not.toContain("rate limit exceeded");
    }
  });

  it("maps Anthropic 529 (overloaded) to the canonical 'AI service is busy' string", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    mockStreamReplyDraft.mockRejectedValue(new APIError("overloaded_error", 529));

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result).toEqual({
      ok: false,
      error: "AI service is busy. Please try again.",
    });
  });

  it("maps Anthropic 503 to the canonical 'AI service is busy' string (same family as 529)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    mockStreamReplyDraft.mockRejectedValue(new APIError("upstream unavailable", 503));

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result).toEqual({
      ok: false,
      error: "AI service is busy. Please try again.",
    });
  });

  it("maps a ZodError (malformed tool-use shape from the generator) to the canonical generic error", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    // Re-import ZodError from the real zod so `instanceof` matches the SUT's.
    const { ZodError } = await import("zod");
    const zodErr = new ZodError([
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["detailed"],
        message: "Required",
      },
    ]);
    mockStreamReplyDraft.mockRejectedValue(zodErr);

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result).toEqual({
      ok: false,
      error: "Draft generation failed. Please try again.",
    });
  });

  it("happy path: returns ok:true with three streamables when streamReplyDraft resolves", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const { threadId } = await createThread(accountId);
    authMock.mockResolvedValue({ user: { id: userId } } as never);
    // The actual StreamableValue shape isn't observable from out-of-RSC;
    // sentinel objects are enough to verify the Server Action forwards them.
    const terseStream = { _kind: "terse" } as unknown;
    const friendlyStream = { _kind: "friendly" } as unknown;
    const detailedStream = { _kind: "detailed" } as unknown;
    mockStreamReplyDraft.mockResolvedValue({
      terseStream,
      friendlyStream,
      detailedStream,
      donePromise: Promise.resolve(),
    });

    const result = await requestAIDraft({ threadId, accountId, mode: "reply" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.terseStream).toBe(terseStream);
    expect(result.friendlyStream).toBe(friendlyStream);
    expect(result.detailedStream).toBe(detailedStream);
    expect(mockStreamReplyDraft).toHaveBeenCalledTimes(1);
    expect(mockStreamReplyDraft).toHaveBeenCalledWith(
      { threadId, accountId, mode: "reply" },
      userId,
    );
  });
});
