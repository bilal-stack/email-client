// @vitest-environment node
//
// Thin tests for the Inngest function that runs prioritization on a freshly-
// arrived message. The contracts that matter:
//   - It calls `prioritizeMessage(messageId, userId)` from the event payload.
//   - It upserts on `messageId` (the `@unique` constraint) so a re-fire
//     overwrites in place rather than throwing.
//
// SSE-emit and Inngest concurrency caps are not tested — they're fire-and-
// forget side effects and framework config, not contracts of our code.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `prioritizeMessage` is mocked at the module boundary; the function under
// test imports it from `@/lib/ai/prioritize`. `vi.hoisted` so the mock factory
// can close over the same `fn` that the tests assert on.
const { mockPrioritize } = vi.hoisted(() => ({
  mockPrioritize: vi.fn(),
}));

vi.mock("@/lib/ai/prioritize", () => ({
  prioritizeMessage: mockPrioritize,
}));

// `prisma.priorityScore.upsert` is mocked the same way — we assert on the call
// args, not on DB state. Other models go through with the real client (none of
// them are touched by the function).
const { mockUpsert } = vi.hoisted(() => ({ mockUpsert: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    priorityScore: { upsert: mockUpsert },
  },
}));

// The SSE emit is best-effort; we silence it by mocking the module rather
// than letting the real EventEmitter fire into a void listener.
vi.mock("@/lib/realtime/inbox-events", () => ({
  emitPriorityUpdatedEvent: vi.fn(),
}));

import { prioritizeMessageFn } from "./prioritize-message";

interface FakeStep {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function fakeStep(): FakeStep {
  return { run: (_name, fn) => fn() };
}

function invokeHandler(event: {
  data: {
    messageId: string;
    threadId: string;
    accountId: string;
    userId: string;
  };
}): Promise<unknown> {
  const handler = (
    prioritizeMessageFn as unknown as {
      fn: (ctx: { event: typeof event; step: FakeStep }) => Promise<unknown>;
    }
  ).fn;
  return handler({ event, step: fakeStep() });
}

const PRIORITIZE_RESULT = {
  priority: 4,
  reason: "Reply expected today",
  suggestedActions: ["reply"] as Array<
    "reply" | "archive" | "snooze" | "delegate"
  >,
  riskFlag: "ok" as const,
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  promptVersion: "v1" as const,
  model: "claude-haiku-4-5-20251001",
  userMessageJson: "{\"a\":1}",
};

beforeEach(() => {
  mockPrioritize.mockReset();
  mockUpsert.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("prioritizeMessageFn", () => {
  it("calls prioritizeMessage with the event payload's messageId + userId", async () => {
    mockPrioritize.mockResolvedValueOnce(PRIORITIZE_RESULT);
    mockUpsert.mockResolvedValueOnce({ id: "ps-1" });

    await invokeHandler({
      data: {
        messageId: "msg-123",
        threadId: "thr-123",
        accountId: "acc-123",
        userId: "user-123",
      },
    });

    expect(mockPrioritize).toHaveBeenCalledTimes(1);
    expect(mockPrioritize).toHaveBeenCalledWith("msg-123", "user-123");
  });

  it("upserts on { messageId } with the prioritizer's result", async () => {
    mockPrioritize.mockResolvedValueOnce(PRIORITIZE_RESULT);
    mockUpsert.mockResolvedValueOnce({ id: "ps-1" });

    await invokeHandler({
      data: {
        messageId: "msg-xyz",
        threadId: "thr-xyz",
        accountId: "acc-xyz",
        userId: "user-xyz",
      },
    });

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const call = mockUpsert.mock.calls[0]?.[0] as {
      where: { messageId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.where).toEqual({ messageId: "msg-xyz" });

    // `create` carries the full row payload.
    expect(call.create).toMatchObject({
      messageId: "msg-xyz",
      priority: 4,
      reason: "Reply expected today",
      riskFlag: "ok",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v1",
      userMessageJson: "{\"a\":1}",
    });

    // `update` carries the same scoring fields (re-run overwrites in place).
    expect(call.update).toMatchObject({
      priority: 4,
      reason: "Reply expected today",
      riskFlag: "ok",
      model: "claude-haiku-4-5-20251001",
      promptVersion: "v1",
      userMessageJson: "{\"a\":1}",
    });
  });
});
