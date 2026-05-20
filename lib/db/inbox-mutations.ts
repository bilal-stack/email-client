// Server-side optimistic label mutations on the local `Thread` rows. These
// match what the provider will eventually do (archive removes `INBOX`; trash
// removes `INBOX` and adds `TRASH`; `applyLabelsLocally` is the generic case).
//
// Every function is ownership-scoped via `account: { userId }` and returns the
// PRIOR labels (a snapshot) so the caller can revert when the provider call
// throws. See `app/inbox/actions.ts` for the revert path.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

const INBOX = "INBOX";
const TRASH = "TRASH";
const SPAM = "SPAM";

export interface LabelSnapshotRow {
  id: string;
  prevLabels: string[];
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

async function snapshot(threadIds: string[], userId: string): Promise<LabelSnapshotRow[]> {
  const rows = await prisma.thread.findMany({
    where: { id: { in: threadIds }, account: { userId } },
    select: { id: true, labels: true },
  });
  return rows.map((r) => ({ id: r.id, prevLabels: readLabels(r.labels) }));
}

/**
 * Drop the `INBOX`, `TRASH`, and `SPAM` labels from each (owned) thread.
 * "Archive" means "remove from every special folder" — running this from
 * Inbox, Trash, or Spam all converge on the same Archived state (no
 * INBOX, no TRASH, no SPAM). Returns a snapshot of the prior labels so
 * the caller can revert on provider throw.
 */
export async function archiveLocally(
  threadIds: string[],
  userId: string,
): Promise<LabelSnapshotRow[]> {
  const snap = await snapshot(threadIds, userId);
  for (const r of snap) {
    const next = r.prevLabels.filter((l) => l !== INBOX && l !== TRASH && l !== SPAM);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: next as unknown as Prisma.InputJsonValue },
    });
  }
  return snap;
}

/**
 * Add the `TRASH` label and remove the `INBOX` label from each (owned) thread.
 * Returns the prior-labels snapshot for revert.
 */
export async function trashLocally(
  threadIds: string[],
  userId: string,
): Promise<LabelSnapshotRow[]> {
  const snap = await snapshot(threadIds, userId);
  for (const r of snap) {
    const next = new Set(r.prevLabels.filter((l) => l !== INBOX));
    next.add(TRASH);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: [...next] as unknown as Prisma.InputJsonValue },
    });
  }
  return snap;
}

/**
 * Generic add/remove: applies `add` then drops `remove` from each (owned)
 * thread's labels. Returns the prior-labels snapshot for revert.
 */
export async function applyLabelsLocally(
  threadIds: string[],
  userId: string,
  add: string[],
  remove: string[],
): Promise<LabelSnapshotRow[]> {
  const snap = await snapshot(threadIds, userId);
  for (const r of snap) {
    const set = new Set(r.prevLabels.filter((l) => !remove.includes(l)));
    for (const a of add) set.add(a);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: [...set] as unknown as Prisma.InputJsonValue },
    });
  }
  return snap;
}

/**
 * Restore prior labels — used by the Server Actions when a provider call
 * throws to revert the optimistic local mutation. Only rows whose `id`
 * appears in the snapshot are touched; ownership is still enforced via the
 * `account: { userId }` filter so a stale snapshot can't be weaponized.
 */
export async function revertLabels(
  snapshot: LabelSnapshotRow[],
  userId: string,
  ids: string[],
): Promise<void> {
  const idSet = new Set(ids);
  const toRevert = snapshot.filter((s) => idSet.has(s.id));
  if (toRevert.length === 0) return;
  for (const r of toRevert) {
    await prisma.thread.updateMany({
      where: { id: r.id, account: { userId } },
      data: { labels: r.prevLabels as unknown as Prisma.InputJsonValue },
    });
  }
}
