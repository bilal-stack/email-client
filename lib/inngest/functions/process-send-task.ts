// Background worker for outbound mail. Picks up a `SendTask` row written by
// the `sendDraft` Server Action, calls the appropriate provider, persists
// the resulting Message into the local mail cache via `recordSentMessage`,
// then deletes the SendTask. Failure paths flip the task's `status` to
// `"failed"` with a canonicalized error string so the UI can offer retry.
//
// Why a worker at all (vs. doing the work inline in the action): the
// provider call dominates wall-time on a send (especially with attachments)
// and was the dominant contributor to the "page still loading 20 minutes"
// failure mode reported in manual testing. Moving it here makes the
// Server Action return in tens of milliseconds; the UI then shows a
// "sending…" indicator off the SendTask row and reacts to the SSE event
// emitted at the bottom of this function when the worker completes.

import { prisma } from "@/lib/db";
import { recordSentMessage } from "@/lib/db/record-sent-message";
import { inngest } from "@/lib/inngest/client";
import { INBOX_SEND_TASK_QUEUED } from "@/lib/inngest/events";
import {
  getSendTaskForProcessing,
  markSendTaskFailed,
  markSendTaskSending,
  markSendTaskSentAndDelete,
} from "@/lib/db/send-tasks";
import { getProviderForAccount } from "@/lib/providers";
import { canonicalizeProviderError } from "@/lib/providers/canonical-errors";
import { ProviderError } from "@/lib/providers/errors";
import type { CanonicalAddress, SendAttachment, SendDraft } from "@/lib/providers/types";
import {
  emitInboxSyncEvent,
  emitSendTaskCompletedEvent,
  emitSendTaskFailedEvent,
} from "@/lib/realtime/inbox-events";

function toCanonicalAddresses(raw: unknown): CanonicalAddress[] {
  if (!Array.isArray(raw)) return [];
  const out: CanonicalAddress[] = [];
  for (const v of raw) {
    if (!v || typeof v !== "object") continue;
    const obj = v as { name?: unknown; email?: unknown };
    if (typeof obj.email !== "string") continue;
    out.push(
      typeof obj.name === "string"
        ? { name: obj.name, email: obj.email }
        : { email: obj.email },
    );
  }
  return out;
}

function toStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === "string");
}

export const processSendTaskFn = inngest.createFunction(
  {
    id: "inbox-process-send-task",
    // Per-user concurrency cap. Different users can send in parallel; one
    // user firing five sends in five seconds still queues them in this
    // worker so a slow Gmail upload doesn't block their other sends from
    // STARTING — they just queue serially. Trade-off accepted; bump the
    // limit if email-power-users are a thing.
    concurrency: { limit: 4, key: "event.data.userId" },
    // Inngest's default retry policy retries 4 times with exponential
    // backoff. AuthError / NotFoundError thrown from inside the handler
    // bypass retry by being declared as non-retriable — see below.
  },
  { event: INBOX_SEND_TASK_QUEUED },
  async ({ event, step }) => {
    const { taskId, userId } = event.data;

    // Deliberately NOT wrapped in `step.run`. Inngest serializes step
    // results to JSON to memoize them across retries, which mangles the
    // attachment `Buffer` columns into plain `Record<string, number>`
    // objects on the way back. The task load is an idempotent read, so
    // letting it re-execute on each retry is fine — only the mutating
    // / side-effectful operations below need step memoization.
    const task = await getSendTaskForProcessing(taskId);
    if (!task) {
      // The user (or an admin tool) deleted the SendTask between enqueue
      // and worker run. Silently exit — there's nothing to send and
      // emitting a "failed" event would surface a phantom error to a
      // user who has already discarded the message.
      return { skipped: true } as const;
    }
    if (task.status === "sent") {
      // Idempotency belt: an Inngest retry can re-fire the event. If the
      // previous attempt finished but failed to delete the row before
      // markSendTaskSentAndDelete (vanishingly rare; would need a process
      // crash between provider success and delete), we'd see "sent"
      // status here. No-op rather than re-sending.
      return { duplicate: true } as const;
    }

    await step.run("mark-sending", () => markSendTaskSending(taskId));

    // Pull the account's emailAddress / displayName so recordSentMessage
    // can populate the local Message.from sensibly — outside the
    // sub-step boundary because this is a small read, not work worth
    // retrying as its own step.
    const account = await prisma.mailAccount.findUniqueOrThrow({
      where: { id: task.accountId },
      select: { emailAddress: true, displayName: true },
    });
    const fromAddress: CanonicalAddress = account.displayName
      ? { name: account.displayName, email: account.emailAddress }
      : { email: account.emailAddress };

    // Rebuild the provider-facing SendDraft from the SendTask row +
    // attachment table. Attachment bytes come back as `Buffer` because the
    // Prisma column is `Bytes`; provider adapters accept exactly that.
    const attachments: SendAttachment[] = task.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      content: Buffer.from(a.content),
    }));
    const draft: SendDraft = {
      to: toCanonicalAddresses(task.to),
      cc: toCanonicalAddresses(task.cc),
      bcc: toCanonicalAddresses(task.bcc),
      subject: task.subject,
      bodyHtml: task.bodyHtml,
      inReplyTo: task.inReplyTo ?? undefined,
      references: toStringArray(task.references),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    if (draft.cc?.length === 0) draft.cc = undefined;
    if (draft.bcc?.length === 0) draft.bcc = undefined;
    if (draft.references?.length === 0) draft.references = undefined;

    // The actual provider call — the slow part. Wrapped in a step so
    // Inngest can replay the rest of the function on retry without
    // re-doing the upload (Inngest caches step results between attempts).
    let result: { id: string; threadId: string };
    try {
      result = await step.run("provider-send", async () => {
        const provider = await getProviderForAccount(task.accountId);
        if (task.mode === "new" || !task.providerThreadId) {
          return await provider.sendMessage(draft);
        }
        const r = await provider.reply(task.providerThreadId, draft);
        // For replies the provider doesn't return a threadId — we already
        // have it on the task row.
        return { id: r.id, threadId: task.providerThreadId };
      });
    } catch (e) {
      // Map to a canonical user-facing string, persist on the task row,
      // emit the SSE failure event, and end the run. We do NOT re-throw
      // — re-throwing would let Inngest retry, but the canonicalizer has
      // already decided this is a user-actionable error.
      const error = canonicalizeProviderError(e, "send");
      await markSendTaskFailed(taskId, error);
      try {
        emitSendTaskFailedEvent(userId, { taskId, error, at: Date.now() });
      } catch {
        // SSE bus best-effort; the row carries the error for the next page load.
      }
      // ProviderError already canonicalized; non-ProviderError is unexpected
      // and worth surfacing in the run log without leaking specifics to the user.
      if (!(e instanceof ProviderError)) {
        const err = e as { name?: string; message?: string } | undefined;
        console.warn("process-send-task unexpected error", {
          name: err?.name,
          message: err?.message,
        });
      }
      return { failed: true, error } as const;
    }

    // Persist the Message + Thread locally. recordSentMessage is
    // idempotent on (accountId, providerMessageId) — replays via Inngest
    // retry are safe.
    const { threadDbId } = await step.run("record-sent-message", () =>
      recordSentMessage({
        accountId: task.accountId,
        fromAddress,
        draft,
        providerMessageId: result.id,
        providerThreadId: result.threadId,
      }),
    );

    // Delete the task (and attachment bytes via cascade) — we don't keep
    // "sent" rows around.
    await step.run("cleanup-task", () => markSendTaskSentAndDelete(taskId));

    // Push two SSE events:
    //  1. `inbox-sync` so any open inbox list refetches and the new Sent
    //     row appears without a manual reload (folder-agnostic — the
    //     listener invalidates every "inbox"-prefixed key).
    //  2. `send-task-completed` so the composer / toast can dismiss its
    //     in-flight indicator and (optionally) navigate to the thread.
    try {
      emitInboxSyncEvent(userId, {
        accountId: task.accountId,
        threadIds: [threadDbId],
        at: Date.now(),
      });
      emitSendTaskCompletedEvent(userId, {
        taskId,
        threadId: threadDbId,
        at: Date.now(),
      });
    } catch (e) {
      // SSE bus best-effort — the DB writes already succeeded and the
      // user will see the message on the next inbox refresh either way.
      const err = e as { name?: string; message?: string } | undefined;
      console.warn("send-task SSE emit failed", {
        name: err?.name,
        message: err?.message,
      });
    }

    return { ok: true, providerMessageId: result.id, threadDbId } as const;
  },
);
