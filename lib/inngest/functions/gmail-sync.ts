// Inngest cron function: pulls Gmail deltas every minute for every Gmail
// `MailAccount` row and writes them transactionally to the DB via the shared
// `writeDelta` helper (which all provider sync functions share).
//
// Error contract: `GmailProvider.syncDelta` throws canonical `ProviderError`
// subtypes. `AuthError` (including the stale-historyId case) propagates up to
// Inngest, which will surface it on the function run — the UI prompts a
// reconnect in the next spec.

import { prisma } from "@/lib/db";
import { writeDelta } from "@/lib/inngest/functions/_write-delta";
import { inngest } from "@/lib/inngest/client";
import { GmailProvider } from "@/lib/providers/gmail";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";

interface GmailAccountRow {
  id: string;
  syncCursor: string | null;
  userId: string;
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

        const touched = await prisma.$transaction((tx) =>
          writeDelta({ account, delta, tx }),
        );

        try {
          if (
            touched.threadIds.length > 0 ||
            delta.deletedIds.length > 0 ||
            delta.changedMessages.length > 0
          ) {
            emitInboxSyncEvent(account.userId, {
              accountId: account.id,
              threadIds: touched.threadIds,
              at: Date.now(),
            });
          }
        } catch (e) {
          // Best-effort: the DB commit already succeeded; SSE fan-out is opportunistic.
          // Log shape only — see graph-sync.ts for the same hygiene note.
          const err = e as { name?: string; message?: string } | undefined;
          console.warn("inbox-events emit failed", { name: err?.name, message: err?.message });
        }

        // Fan out one `inbox/message.created` per newly-inserted message so
        // the prioritizer (`functions/prioritize-message.ts`) can score it.
        // Best-effort — if Inngest enqueue fails, the DB commit already
        // succeeded and the user sees the message in the inbox; the chip
        // simply stays unscored.
        try {
          if (touched.newMessageDbIds.length > 0) {
            await inngest.send(
              touched.newMessageDbIds.map((messageId) => ({
                name: "inbox/message.created",
                data: {
                  messageId,
                  threadId: touched.messageIdToThreadDbId.get(messageId)!,
                  accountId: account.id,
                  userId: account.userId,
                },
              })),
            );
          }
        } catch (e) {
          const err = e as { name?: string; message?: string } | undefined;
          console.warn("inbox/message.created emit failed", {
            name: err?.name,
            message: err?.message,
          });
        }
      });
    }
  },
);
