// Inngest cron function: pulls Gmail deltas every minute for every Gmail
// `MailAccount` row and writes them transactionally to the DB.
//
// Idempotency relies on the `(accountId, providerMessageId)` unique constraint
// on `Message` (and `(accountId, providerThreadId)` on `Thread`) — Thread writes
// use `upsert`, Message writes filter out already-inserted rows by
// `providerMessageId` before `createMany` (SQLite doesn't support
// `skipDuplicates`). The same history window can replay safely.
//
// Error contract: `GmailProvider.syncDelta` throws canonical `ProviderError`
// subtypes. `AuthError` (including the stale-historyId case) propagates up to
// Inngest, which will surface it on the function run — the UI prompts a
// reconnect in the next spec.

import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import { GmailProvider } from "@/lib/providers/gmail";
import type { CanonicalAddress, CanonicalMessage } from "@/lib/providers/types";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";
import type { Prisma } from "@prisma/client";

interface GmailAccountRow {
  id: string;
  syncCursor: string | null;
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

export const gmailSyncDelta = inngest.createFunction(
  {
    id: "gmail-sync-delta",
    // Global limit: 1 means two cron firings won't overlap. Per-account
    // serialization would need a fan-out pattern (one event per account per
    // tick keyed on accountId) — not worth the complexity until we have
    // enough accounts that a single serial sync becomes a bottleneck.
    concurrency: { limit: 1 },
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const accounts = (await step.run("list-accounts", () =>
      prisma.mailAccount.findMany({
        where: { provider: "gmail" },
        select: { id: true, syncCursor: true, userId: true },
      }),
    )) as GmailAccountRow[];

    for (const account of accounts) {
      await step.run(`sync-${account.id}`, async () => {
        const provider = new GmailProvider(account.id);
        const delta = await provider.syncDelta(account.syncCursor);

        // Declared outside the transaction callback so we can read the
        // touched thread DB ids after the commit succeeds (for the SSE emit).
        const providerThreadIdToDbId = new Map<string, string>();

        await prisma.$transaction(async (tx) => {
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
        });

        try {
          const touched = [...providerThreadIdToDbId.values()];
          if (
            touched.length > 0 ||
            delta.deletedIds.length > 0 ||
            delta.changedMessages.length > 0
          ) {
            emitInboxSyncEvent(account.userId, {
              accountId: account.id,
              threadIds: touched,
              at: Date.now(),
            });
          }
        } catch (e) {
          // Best-effort: the DB commit already succeeded; SSE fan-out is opportunistic.
          console.warn("inbox-events emit failed", e);
        }
      });
    }
  },
);
