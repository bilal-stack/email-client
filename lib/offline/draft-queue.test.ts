import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTests,
  bumpAttempt,
  clearQueued,
  listQueued,
  queueDraft,
  removeQueued,
} from "./draft-queue";

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

describe("offline draft queue", () => {
  beforeEach(async () => {
    // Each test gets a clean store. The fake-indexeddb DB persists across
    // tests in-process, so we explicitly clear + reset the cached connection.
    await clearQueued();
    _resetForTests();
  });

  it("round-trips a queued draft (queue -> list -> remove)", async () => {
    const id = await queueDraft(baseDraft);
    expect(id).toEqual(expect.any(String));

    const after = await listQueued();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id,
      accountId: "acc_1",
      threadId: "thr_1",
      mode: "reply",
      subject: "Hello",
      attemptCount: 0,
    });
    expect(after[0]?.queuedAt).toEqual(expect.any(Number));

    await removeQueued(id);
    expect(await listQueued()).toEqual([]);
  });

  it("returns multi-draft results in chronological order", async () => {
    const id1 = await queueDraft({ ...baseDraft, subject: "first" });
    await new Promise((r) => setTimeout(r, 2));
    const id2 = await queueDraft({ ...baseDraft, subject: "second" });
    await new Promise((r) => setTimeout(r, 2));
    const id3 = await queueDraft({ ...baseDraft, subject: "third" });

    const all = await listQueued();
    expect(all.map((d) => d.id)).toEqual([id1, id2, id3]);
    // queuedAt strictly non-decreasing
    expect(all[0]!.queuedAt).toBeLessThanOrEqual(all[1]!.queuedAt);
    expect(all[1]!.queuedAt).toBeLessThanOrEqual(all[2]!.queuedAt);
  });

  it("removeQueued is idempotent for unknown and repeated ids", async () => {
    await expect(removeQueued("nonexistent")).resolves.toBeUndefined();

    const id = await queueDraft(baseDraft);
    await expect(removeQueued(id)).resolves.toBeUndefined();
    await expect(removeQueued(id)).resolves.toBeUndefined();
    expect(await listQueued()).toEqual([]);
  });

  it("bumpAttempt increments the retry counter", async () => {
    const id = await queueDraft(baseDraft);
    await bumpAttempt(id);
    await bumpAttempt(id);

    const all = await listQueued();
    expect(all).toHaveLength(1);
    expect(all[0]?.attemptCount).toBe(2);
  });

  it("clearQueued empties the store", async () => {
    await queueDraft({ ...baseDraft, subject: "a" });
    await queueDraft({ ...baseDraft, subject: "b" });
    await queueDraft({ ...baseDraft, subject: "c" });
    expect(await listQueued()).toHaveLength(3);

    await clearQueued();
    expect(await listQueued()).toEqual([]);
  });
});
