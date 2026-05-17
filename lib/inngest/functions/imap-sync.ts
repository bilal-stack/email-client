// Inngest cron function: pulls IMAP UID-range deltas every minute for every
// IMAP-backed `MailAccount` row and writes them transactionally to the DB
// via the shared `writeDelta` helper.
//
// Mirrors `gmail-sync.ts` / `graph-sync.ts` exactly except for the provider
// class instantiated and the `where: { provider: "imap" }` filter. The
// canonical error taxonomy means `AuthError` from `ImapProvider.syncDelta`
// (including the UIDVALIDITY-drift case) propagates to Inngest's run log;
// the reconnect UI in `unified-inbox-ui` handles it.
//
// IMAP IDLE is deliberately out of scope (see spec non-goals) — we poll on
// the same 60-second cadence as the other adapters.

import { prisma } from "@/lib/db";
import { writeDelta } from "@/lib/inngest/functions/_write-delta";
import { inngest } from "@/lib/inngest/client";
import { ImapProvider } from "@/lib/providers/imap";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";

interface ImapAccountRow {
  id: string;
  syncCursor: string | null;
  userId: string;
}

export const imapSyncPoll = inngest.createFunction(
  {
    id: "imap-sync-poll",
    concurrency: { limit: 1 },
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const accounts = (await step.run("list-accounts", () =>
      prisma.mailAccount.findMany({
        where: { provider: "imap" },
        select: { id: true, syncCursor: true, userId: true },
      }),
    )) as ImapAccountRow[];

    for (const account of accounts) {
      await step.run(`sync-${account.id}`, async () => {
        const provider = new ImapProvider(account.id);
        const delta = await provider.syncDelta(account.syncCursor);

        const touched = await prisma.$transaction((tx) =>
          writeDelta({ account, delta, tx }),
        );

        try {
          if (touched.threadIds.length > 0 || delta.deletedIds.length > 0) {
            emitInboxSyncEvent(account.userId, {
              accountId: account.id,
              threadIds: touched.threadIds,
              at: Date.now(),
            });
          }
        } catch (e) {
          // Best-effort: DB commit already succeeded; SSE fan-out is opportunistic.
          // Sanitized log shape — no secrets in scope, but flatten to name+message
          // so the no-secrets-in-logs checklist stays honest.
          const err = e as { name?: string; message?: string } | undefined;
          console.warn("inbox-events emit failed", { name: err?.name, message: err?.message });
        }
      });
    }
  },
);
