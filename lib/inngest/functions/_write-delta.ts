// Shared transactional writer for provider deltas. Used by `gmail-sync.ts`
// and `graph-sync.ts` (and IMAP eventually) — every adapter produces the
// same `DeltaResult` shape, so the DB-write half is provider-agnostic.
//
// Idempotency relies on the `(accountId, providerMessageId)` unique constraint
// on `Message` (and `(accountId, providerThreadId)` on `Thread`). Thread
// writes use `upsert`; Message writes filter out already-inserted rows by
// `providerMessageId` before `createMany` (SQLite doesn't support
// `skipDuplicates`). The same delta window can replay safely.
//
// Returns the DB ids of the threads that were upserted during this run —
// callers use this to decide whether to fan out an SSE inbox-sync event.

import type { DeltaResult } from "@/lib/providers/types";
import type { CanonicalAddress, CanonicalMessage } from "@/lib/providers/types";
import type { Prisma } from "@prisma/client";

interface AccountInput {
  id: string;
  userId: string;
}

interface ThreadAggregate {
  providerThreadId: string;
  accountId: string;
  subject: string;
  lastMessageAt: Date;
  unreadCount: number;
  labels: string[];
  participants: CanonicalAddress[];
}

function aggregateThreads(messages: CanonicalMessage[]): Map<string, ThreadAggregate> {
  const byThread = new Map<string, ThreadAggregate>();
  for (const m of messages) {
    if (!m.threadId) continue;
    const existing = byThread.get(m.threadId);
    if (existing) {
      if (m.receivedAt > existing.lastMessageAt) {
        existing.lastMessageAt = m.receivedAt;
        // Use the most recent message's subject as the thread subject.
        existing.subject = m.subject || existing.subject;
      }
      if (m.isUnread) existing.unreadCount++;
      for (const l of m.labels) if (!existing.labels.includes(l)) existing.labels.push(l);
      const seen = new Set(existing.participants.map((p) => p.email));
      for (const a of [m.from, ...m.to, ...m.cc, ...m.bcc]) {
        if (a.email && !seen.has(a.email)) {
          existing.participants.push(a);
          seen.add(a.email);
        }
      }
    } else {
      const participants: CanonicalAddress[] = [];
      const seen = new Set<string>();
      for (const a of [m.from, ...m.to, ...m.cc, ...m.bcc]) {
        if (a.email && !seen.has(a.email)) {
          participants.push(a);
          seen.add(a.email);
        }
      }
      byThread.set(m.threadId, {
        providerThreadId: m.threadId,
        accountId: m.accountId,
        subject: m.subject,
        lastMessageAt: m.receivedAt,
        unreadCount: m.isUnread ? 1 : 0,
        labels: [...m.labels],
        participants,
      });
    }
  }
  return byThread;
}

export interface WriteDeltaResult {
  /** DB ids of every thread the run upserted (created or updated). */
  threadIds: string[];
  /**
   * DB ids of `Message` rows newly inserted in this commit. Empty on a
   * replay-only delta (every candidate row already existed by
   * `providerMessageId`). Callers use this to fan out
   * `inbox/message.created` Inngest events after the transaction commits.
   */
  newMessageDbIds: string[];
  /**
   * Maps each id in `newMessageDbIds` to its parent thread DB id. Lookup
   * used by the post-commit Inngest fan-out so each event carries the
   * thread id without a second DB round-trip.
   */
  messageIdToThreadDbId: Map<string, string>;
}

export async function writeDelta(params: {
  account: AccountInput;
  delta: DeltaResult;
  tx: Prisma.TransactionClient;
}): Promise<WriteDeltaResult> {
  const { account, delta, tx } = params;
  const providerThreadIdToDbId = new Map<string, string>();

  // ── 1. Upsert threads referenced by new messages ─────────────
  const threadAggregates = aggregateThreads(delta.newMessages);
  for (const agg of threadAggregates.values()) {
    const row = await tx.thread.upsert({
      where: {
        accountId_providerThreadId: {
          accountId: agg.accountId,
          providerThreadId: agg.providerThreadId,
        },
      },
      update: {
        subject: agg.subject,
        lastMessageAt: agg.lastMessageAt,
        labels: agg.labels as unknown as Prisma.InputJsonValue,
        participants: agg.participants as unknown as Prisma.InputJsonValue,
        // unreadCount is the count of unread messages in *this delta*.
        // A fully accurate per-thread count would require summing
        // `isUnread` across all stored messages for the thread — that
        // recompute is deferred to the unified-inbox-ui spec, which
        // does it server-side when listing threads.
        unreadCount: agg.unreadCount,
      },
      create: {
        accountId: agg.accountId,
        providerThreadId: agg.providerThreadId,
        subject: agg.subject,
        lastMessageAt: agg.lastMessageAt,
        unreadCount: agg.unreadCount,
        labels: agg.labels as unknown as Prisma.InputJsonValue,
        participants: agg.participants as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, providerThreadId: true },
    });
    providerThreadIdToDbId.set(row.providerThreadId, row.id);
  }

  // ── 2. createMany messages (filter-existing handles replays) ──
  // SQLite doesn't support `createMany({ skipDuplicates: true })`, so
  // we filter out already-inserted rows by `providerMessageId` first.
  // Tracks the providerMessageIds of rows newly inserted in this commit —
  // step 7 resolves these to DB ids for the Inngest fan-out return value.
  const newProviderMessageIds: string[] = [];
  const providerMessageIdToProviderThreadId = new Map<string, string>();
  if (delta.newMessages.length > 0) {
    const candidateRows = delta.newMessages
      .map((m) => {
        const threadDbId = providerThreadIdToDbId.get(m.threadId);
        if (!threadDbId) return null;
        return {
          threadId: threadDbId,
          accountId: m.accountId,
          providerMessageId: m.id,
          providerThreadId: m.threadId,
          from: m.from as unknown as Prisma.InputJsonValue,
          to: m.to as unknown as Prisma.InputJsonValue,
          cc: m.cc as unknown as Prisma.InputJsonValue,
          bcc: m.bcc as unknown as Prisma.InputJsonValue,
          subject: m.subject,
          snippet: m.snippet,
          bodyHtml: m.bodyHtml,
          bodyText: m.bodyText,
          receivedAt: m.receivedAt,
          isUnread: m.isUnread,
          labels: m.labels as unknown as Prisma.InputJsonValue,
          inReplyTo: m.inReplyTo,
          references: m.references as unknown as Prisma.InputJsonValue,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (candidateRows.length > 0) {
      const existing = await tx.message.findMany({
        where: {
          accountId: account.id,
          providerMessageId: { in: candidateRows.map((r) => r.providerMessageId) },
        },
        select: { providerMessageId: true },
      });
      const existingIds = new Set(existing.map((e) => e.providerMessageId));
      const newRows = candidateRows.filter((r) => !existingIds.has(r.providerMessageId));
      if (newRows.length > 0) {
        await tx.message.createMany({ data: newRows });
        for (const r of newRows) {
          newProviderMessageIds.push(r.providerMessageId);
          providerMessageIdToProviderThreadId.set(r.providerMessageId, r.providerThreadId);
        }
      }
    }
  }

  // ── 3. Insert attachment metadata (fetchedAt = null) ─────────
  const attachmentRows: Array<{
    messageId: string;
    providerAttachmentId: string;
    filename: string;
    mimeType: string;
    size: number;
  }> = [];
  if (delta.newMessages.some((m) => m.attachments.length > 0)) {
    // Look up the newly-inserted message DB ids by providerMessageId so
    // we can attach. `createMany` doesn't return rows, so this is the
    // simplest correct approach.
    const providerIds = delta.newMessages
      .filter((m) => m.attachments.length > 0)
      .map((m) => m.id);
    const inserted = await tx.message.findMany({
      where: {
        accountId: { in: [...new Set(delta.newMessages.map((m) => m.accountId))] },
        providerMessageId: { in: providerIds },
      },
      select: { id: true, providerMessageId: true },
    });
    const providerIdToDbId = new Map(inserted.map((r) => [r.providerMessageId, r.id]));
    for (const m of delta.newMessages) {
      const dbId = providerIdToDbId.get(m.id);
      if (!dbId) continue;
      for (const att of m.attachments) {
        attachmentRows.push({
          messageId: dbId,
          providerAttachmentId: att.id,
          filename: att.filename,
          mimeType: att.mimeType,
          size: att.size,
        });
      }
    }
  }
  if (attachmentRows.length > 0) {
    // Attachment has no unique constraint, so `skipDuplicates` won't
    // help on replays. Delete-then-insert keeps the table idempotent
    // on rerun of the same delta window. (Attachment bytes aren't
    // stored yet, so this is cheap.)
    // TODO(attachments-fetch spec): once `fetchedAt` is set after a
    // user downloads bytes, this delete-then-insert destroys that
    // state on every replay. Switch to per-row `upsert` keyed on
    // `(messageId, providerAttachmentId)` before that spec lands.
    const messageIds = [...new Set(attachmentRows.map((a) => a.messageId))];
    await tx.attachment.deleteMany({ where: { messageId: { in: messageIds } } });
    await tx.attachment.createMany({ data: attachmentRows });
  }

  // ── 3.5. Invalidate AISummary rows on threads that got new mail ──
  // Only new-message-touching deltas invalidate. `changedMessages` (label
  // flips, unread toggles) and `deletedIds` don't change what the summary
  // says, so they leave the row alone. `providerThreadIdToDbId` is
  // populated only by step 1 (which keys off `delta.newMessages`), so its
  // values are exactly the right set.
  const touchedThreadDbIds = [...providerThreadIdToDbId.values()];
  if (touchedThreadDbIds.length > 0) {
    await tx.aISummary.updateMany({
      where: { threadId: { in: touchedThreadDbIds }, invalidatedAt: null },
      data: { invalidatedAt: new Date() },
    });
  }

  // ── 4. Apply changedMessages (labels / unread toggles) ───────
  for (const change of delta.changedMessages) {
    await tx.message.updateMany({
      where: {
        accountId: account.id,
        providerMessageId: change.id,
      },
      data: {
        ...(change.isUnread !== undefined ? { isUnread: change.isUnread } : {}),
        ...(change.labels !== undefined
          ? { labels: change.labels as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  // ── 5. Delete messages flagged as removed ────────────────────
  if (delta.deletedIds.length > 0) {
    await tx.message.deleteMany({
      where: {
        accountId: account.id,
        providerMessageId: { in: delta.deletedIds },
      },
    });
  }

  // ── 6. Update sync cursor + lastSyncedAt ─────────────────────
  await tx.mailAccount.update({
    where: { id: account.id },
    data: {
      syncCursor: delta.nextCursor,
      lastSyncedAt: new Date(),
    },
  });

  // ── 7. Resolve newly-inserted message DB ids ─────────────────
  // The Inngest fan-out (`inbox/message.created` per new message) lives
  // OUTSIDE this transaction in the caller. We collect (messageDbId,
  // threadDbId) pairs here so the caller doesn't need a second DB read.
  // `createMany` doesn't return rows, hence the post-insert findMany.
  const newMessageDbIds: string[] = [];
  const messageIdToThreadDbId = new Map<string, string>();
  if (newProviderMessageIds.length > 0) {
    const inserted = await tx.message.findMany({
      where: {
        accountId: account.id,
        providerMessageId: { in: newProviderMessageIds },
      },
      select: { id: true, providerMessageId: true },
    });
    for (const row of inserted) {
      const providerThreadId = providerMessageIdToProviderThreadId.get(
        row.providerMessageId,
      );
      const threadDbId = providerThreadId
        ? providerThreadIdToDbId.get(providerThreadId)
        : undefined;
      if (!threadDbId) continue;
      newMessageDbIds.push(row.id);
      messageIdToThreadDbId.set(row.id, threadDbId);
    }
  }

  return {
    threadIds: [...providerThreadIdToDbId.values()],
    newMessageDbIds,
    messageIdToThreadDbId,
  };
}
