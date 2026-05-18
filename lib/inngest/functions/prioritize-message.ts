// Inngest function: scores a newly-arrived message using Haiku, persists the
// score on a `PriorityScore` row, and fans an SSE `priority-updated` event
// out to open clients so the inbox row chip re-renders.
//
// Trigger: `inbox/message.created` — emitted from each provider sync
// function (`gmail-sync.ts` / `graph-sync.ts` / `imap-sync.ts`) after their
// `writeDelta` transaction commits.
//
// Per-user concurrency cap of 2 bounds the in-flight prioritization for a
// user. An initial-sync flood (e.g. 500 unread messages on first connect)
// drains at a steady rate; the queued events sit in Inngest until a slot is
// free. Idempotent because the `PriorityScore.messageId` `@unique` + upsert
// path overwrites an existing row in place.

import type { Prisma } from "@prisma/client";
import { prioritizeMessage } from "@/lib/ai/prioritize";
import { prisma } from "@/lib/db";
import { inngest } from "@/lib/inngest/client";
import type { InboxMessageCreatedEvent } from "@/lib/inngest/events";
import { emitPriorityUpdatedEvent } from "@/lib/realtime/inbox-events";

export const prioritizeMessageFn = inngest.createFunction(
  {
    id: "prioritize-message",
    concurrency: { limit: 2, key: "event.data.userId" },
  },
  { event: "inbox/message.created" },
  async ({ event, step }) => {
    const { messageId, threadId, userId } =
      event.data as InboxMessageCreatedEvent["data"];

    const result = await step.run("prioritize", () =>
      prioritizeMessage(messageId, userId),
    );

    await step.run("persist", () =>
      prisma.priorityScore.upsert({
        where: { messageId },
        create: {
          messageId,
          priority: result.priority,
          reason: result.reason,
          suggestedActions:
            result.suggestedActions as unknown as Prisma.InputJsonValue,
          riskFlag: result.riskFlag,
          model: result.model,
          promptVersion: result.promptVersion,
          usage: result.usage as unknown as Prisma.InputJsonValue,
          userMessageJson: result.userMessageJson,
        },
        update: {
          priority: result.priority,
          reason: result.reason,
          suggestedActions:
            result.suggestedActions as unknown as Prisma.InputJsonValue,
          riskFlag: result.riskFlag,
          model: result.model,
          promptVersion: result.promptVersion,
          usage: result.usage as unknown as Prisma.InputJsonValue,
          userMessageJson: result.userMessageJson,
          scoredAt: new Date(),
        },
      }),
    );

    // Best-effort SSE fan-out — the DB write already succeeded; an open
    // client that misses this event will pick up the score on the next
    // inbox-sync invalidation or on a hard reload.
    try {
      emitPriorityUpdatedEvent(userId, {
        threadId,
        scoredMessageIds: [messageId],
        at: Date.now(),
      });
    } catch (e) {
      const err = e as { name?: string; message?: string } | undefined;
      console.warn("priority-updated emit failed", {
        name: err?.name,
        message: err?.message,
      });
    }
  },
);
