// @vitest-environment node
import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { afterEach, describe, expect, it } from "vitest";
import { applyLabelsLocally, archiveLocally, revertLabels, trashLocally } from "./inbox-mutations";

// Helpers --------------------------------------------------------------------

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string }> {
  const user = await prisma.user.create({
    data: { email: `inbox-mut-${randomUUID()}@example.com` },
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

async function createThread(accountId: string, labels: string[]): Promise<string> {
  const t = await prisma.thread.create({
    data: {
      accountId,
      providerThreadId: `pth-${randomUUID()}`,
      subject: "Subject",
      lastMessageAt: new Date("2026-05-12T10:00:00Z"),
      unreadCount: 0,
      labels,
      participants: [{ name: "Sender", email: "sender@example.com" }],
    },
  });
  return t.id;
}

async function getLabels(threadId: string): Promise<string[]> {
  const t = await prisma.thread.findUniqueOrThrow({
    where: { id: threadId },
    select: { labels: true },
  });
  return (t.labels as unknown[]).filter((l): l is string => typeof l === "string");
}

// Tests ----------------------------------------------------------------------

describe("archiveLocally", () => {
  it("happy path — removes INBOX, leaves other labels intact", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "STARRED"]);

    const snap = await archiveLocally([threadId], userId);

    expect(await getLabels(threadId)).toEqual(["STARRED"]);
    expect(snap).toEqual([{ id: threadId, prevLabels: ["INBOX", "STARRED"] }]);
  });

  it("is idempotent — calling twice leaves labels unchanged the second time", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "STARRED"]);

    await archiveLocally([threadId], userId);
    const afterFirst = await getLabels(threadId);
    await archiveLocally([threadId], userId);
    const afterSecond = await getLabels(threadId);

    expect(afterFirst).toEqual(["STARRED"]);
    expect(afterSecond).toEqual(["STARRED"]);
  });

  it("ownership scoping — passing another user's thread id is a no-op (no row touched, no error)", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const bThreadId = await createThread(b.accountId, ["INBOX", "STARRED"]);

    const snap = await archiveLocally([bThreadId], a.userId);

    expect(snap).toEqual([]);
    expect(await getLabels(bThreadId)).toEqual(["INBOX", "STARRED"]);
  });
});

describe("trashLocally", () => {
  it("happy path — adds TRASH and removes INBOX", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX"]);

    await trashLocally([threadId], userId);
    const labels = await getLabels(threadId);

    expect(labels).toContain("TRASH");
    expect(labels).not.toContain("INBOX");
  });

  it("from already-trashed — labels stay ['TRASH'] (no duplicate)", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["TRASH"]);

    await trashLocally([threadId], userId);
    const labels = await getLabels(threadId);

    expect(labels).toEqual(["TRASH"]);
  });

  it("ownership scoping — passing another user's thread id is a no-op", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const bThreadId = await createThread(b.accountId, ["INBOX"]);

    const snap = await trashLocally([bThreadId], a.userId);

    expect(snap).toEqual([]);
    expect(await getLabels(bThreadId)).toEqual(["INBOX"]);
  });
});

describe("applyLabelsLocally", () => {
  it("add only — appends without disturbing existing labels", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX"]);

    await applyLabelsLocally([threadId], userId, ["Work"], []);
    const labels = await getLabels(threadId);

    expect(labels).toEqual(expect.arrayContaining(["INBOX", "Work"]));
    expect(labels).toHaveLength(2);
  });

  it("remove only — drops the named label", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "Work"]);

    await applyLabelsLocally([threadId], userId, [], ["Work"]);

    expect(await getLabels(threadId)).toEqual(["INBOX"]);
  });

  it("add + remove combined — works as set union/difference", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "Work"]);

    await applyLabelsLocally([threadId], userId, ["Personal"], ["Work"]);
    const labels = await getLabels(threadId);

    expect(labels).toEqual(expect.arrayContaining(["INBOX", "Personal"]));
    expect(labels).not.toContain("Work");
    expect(labels).toHaveLength(2);
  });

  it("no-op — empty add + remove leaves labels unchanged", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "Work"]);

    await applyLabelsLocally([threadId], userId, [], []);

    expect(await getLabels(threadId)).toEqual(["INBOX", "Work"]);
  });

  it("ownership scoping — another user's thread id is left untouched", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const bThreadId = await createThread(b.accountId, ["INBOX"]);

    const snap = await applyLabelsLocally([bThreadId], a.userId, ["Work"], []);

    expect(snap).toEqual([]);
    expect(await getLabels(bThreadId)).toEqual(["INBOX"]);
  });
});

describe("revertLabels", () => {
  it("restores prior labels for ids that appear in the snapshot", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const threadId = await createThread(accountId, ["INBOX", "STARRED"]);

    const snap = await archiveLocally([threadId], userId);
    expect(await getLabels(threadId)).toEqual(["STARRED"]);

    await revertLabels(snap, userId, [threadId]);

    expect(await getLabels(threadId)).toEqual(["INBOX", "STARRED"]);
  });

  it("ignores thread ids not present in the supplied id list", async () => {
    const { userId, accountId } = await createUserWithAccount();
    const a = await createThread(accountId, ["INBOX", "STARRED"]);
    const b = await createThread(accountId, ["INBOX"]);

    const snap = await archiveLocally([a, b], userId);
    expect(await getLabels(a)).toEqual(["STARRED"]);
    expect(await getLabels(b)).toEqual([]);

    // Only revert `a`. `b` should stay archived.
    await revertLabels(snap, userId, [a]);

    expect(await getLabels(a)).toEqual(["INBOX", "STARRED"]);
    expect(await getLabels(b)).toEqual([]);
  });

  it("ownership scoping — a stale snapshot from another user can't write across users", async () => {
    const a = await createUserWithAccount();
    const b = await createUserWithAccount();
    const bThreadId = await createThread(b.accountId, ["INBOX"]);

    // Fake snapshot claiming user A owns user B's thread.
    const fakeSnap = [{ id: bThreadId, prevLabels: ["INBOX", "Hijacked"] }];
    await revertLabels(fakeSnap, a.userId, [bThreadId]);

    expect(await getLabels(bThreadId)).toEqual(["INBOX"]);
  });
});
