import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpsertDraft } = vi.hoisted(() => ({
  mockUpsertDraft: vi.fn(),
}));

vi.mock("@/app/inbox/compose/actions", () => ({
  upsertDraft: mockUpsertDraft,
}));

// Import AFTER `vi.mock` so the SUT picks up the mocked action.
import { __test__ } from "./draft-replay";
import { _resetForTests, clearQueued, listQueued, queueDraft } from "./draft-queue";

const baseDraft = {
  accountId: "acc_1",
  threadId: "thr_1",
  mode: "reply" as const,
  to: [{ email: "a@example.com" }],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyHtml: "<p>hi</p>",
};

describe("offline draft replay", () => {
  beforeEach(async () => {
    mockUpsertDraft.mockReset();
    await clearQueued();
    _resetForTests();
  });

  it("replays each queued draft via upsertDraft and removes on success", async () => {
    await queueDraft({ ...baseDraft, subject: "first" });
    await queueDraft({ ...baseDraft, subject: "second" });

    mockUpsertDraft.mockResolvedValue({
      ok: true,
      data: { draftId: "server_x", updatedAt: new Date() },
    });

    await __test__.run();

    expect(mockUpsertDraft).toHaveBeenCalledTimes(2);
    expect(await listQueued()).toEqual([]);
  });

  it("leaves the entry in the queue and bumps attemptCount on failure", async () => {
    const id = await queueDraft(baseDraft);

    mockUpsertDraft.mockResolvedValue({
      ok: false,
      error: "server rejected",
    });

    await __test__.run();

    const remaining = await listQueued();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(id);
    expect(remaining[0]?.attemptCount).toBe(1);
  });

  it("in-flight gate short-circuits a concurrent run", async () => {
    await queueDraft(baseDraft);

    mockUpsertDraft.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ ok: true, data: { draftId: "x", updatedAt: new Date() } }),
            50,
          ),
        ),
    );

    // Kick off two runs without awaiting the first — the second must observe
    // `inFlight === true` and bail.
    const p1 = __test__.run();
    const p2 = __test__.run();
    await Promise.all([p1, p2]);

    expect(mockUpsertDraft).toHaveBeenCalledTimes(1);
  });
});
