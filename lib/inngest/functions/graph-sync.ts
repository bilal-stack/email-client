// Inngest cron function: pulls Microsoft Graph deltas every minute for every
// Graph-backed `MailAccount` row and writes them transactionally to the DB
// via the shared `writeDelta` helper.
//
// Mirrors `gmail-sync.ts` exactly except for the provider class instantiated
// and the `where: { provider: "graph" }` filter on the account scan. The
// canonical error taxonomy means `AuthError` from `GraphProvider.syncDelta`
// (including the stale `@odata.deltaLink` 410 case) propagates to Inngest's
// run log; the reconnect UI in `unified-inbox-ui` handles it.

import { prisma } from "@/lib/db";
import { writeDelta } from "@/lib/inngest/functions/_write-delta";
import { inngest } from "@/lib/inngest/client";
import { GraphProvider } from "@/lib/providers/graph";
import { AuthError } from "@/lib/providers/errors";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";

interface GraphAccountRow {
  id: string;
  syncCursor: string | null;
  userId: string;
}

export const graphSyncDelta = inngest.createFunction(
  {
    id: "graph-sync-delta",
    concurrency: { limit: 1 },
  },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const accounts = (await step.run("list-accounts", () =>
      prisma.mailAccount.findMany({
        where: { provider: "graph" },
        select: { id: true, syncCursor: true, userId: true },
      }),
    )) as GraphAccountRow[];

    for (const account of accounts) {
      await step.run(`sync-${account.id}`, async () => {
        const provider = new GraphProvider(account.id);
        let delta: Awaited<ReturnType<GraphProvider["syncDelta"]>>;
        try {
          delta = await provider.syncDelta(account.syncCursor);
        } catch (e) {
          // Same logic as gmail-sync: revoked/unrefreshable tokens shouldn't
          // turn into an infinite retry loop. Mark the account as needing
          // reconnect and bail; transient (timeout) errors are left alone
          // so Inngest's next cron tick gets a fresh shot.
          if (e instanceof AuthError) {
            console.warn("[graph-sync] AuthError — skipping until reconnect", {
              accountId: account.id,
              transient: e.transient,
              message: e.message,
            });
            if (!e.transient) {
              await prisma.mailAccount
                .update({
                  where: { id: account.id },
                  data: { needsReconnectAt: new Date() },
                })
                .catch(() => {
                  /* column may not exist yet in older deploys; ignore */
                });
            }
            return;
          }
          throw e;
        }

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
          // Best-effort: the DB commit already succeeded; SSE fan-out is opportunistic.
          // Log shape only — `e` here is an in-memory emitter error with no
          // token/provider state in scope today, but flattening to name+message
          // keeps the no-secrets-in-logs checklist honest for future drift.
          const err = e as { name?: string; message?: string } | undefined;
          console.warn("inbox-events emit failed", { name: err?.name, message: err?.message });
        }

        // Fan out one `inbox/message.created` per newly-inserted message so
        // the prioritizer can score it. Best-effort — see gmail-sync.ts for
        // the matching hygiene note.
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
