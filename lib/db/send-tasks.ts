// CRUD helpers for the SendTask + SendTaskAttachment tables. Used by the
// `sendDraft` Server Action (enqueue side) and the `process-send-task`
// Inngest function (worker side). Kept here so neither caller has to spell
// out the cross-table transaction.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type SendTaskStatus = "queued" | "sending" | "sent" | "failed";

export type SendTaskMode = "new" | "reply" | "reply-all" | "forward";

export interface CreateSendTaskInput {
  userId: string;
  accountId: string;
  mode: SendTaskMode;
  threadId: string | null;
  providerThreadId: string | null;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  subject: string;
  bodyHtml: string;
  inReplyTo: string | null;
  references: readonly string[];
  attachments: ReadonlyArray<{
    filename: string;
    mimeType: string;
    size: number;
    content: Buffer;
  }>;
}

/**
 * Persist a new SendTask and its attachments in a single transaction.
 * Returns the task DB id; callers immediately enqueue an Inngest event
 * carrying just that id.
 */
export async function createSendTask(input: CreateSendTaskInput): Promise<{ taskId: string }> {
  const task = await prisma.$transaction(async (tx) => {
    const row = await tx.sendTask.create({
      data: {
        userId: input.userId,
        accountId: input.accountId,
        mode: input.mode,
        threadId: input.threadId,
        providerThreadId: input.providerThreadId,
        to: input.to as Prisma.InputJsonValue,
        cc: input.cc as Prisma.InputJsonValue,
        bcc: input.bcc as Prisma.InputJsonValue,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        inReplyTo: input.inReplyTo,
        references: input.references as unknown as Prisma.InputJsonValue,
        status: "queued",
      },
      select: { id: true },
    });
    if (input.attachments.length > 0) {
      await tx.sendTaskAttachment.createMany({
        data: input.attachments.map((a) => ({
          taskId: row.id,
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
          content: a.content,
        })),
      });
    }
    return row;
  });
  return { taskId: task.id };
}

/**
 * Load a task plus its attachments. The worker calls this once at the top
 * of the run; nothing else in the pipeline re-reads the row.
 *
 * Returns `null` when the row was deleted (e.g. the user discarded it from
 * the outbox UI before the worker picked it up) — caller treats this as a
 * silent no-op.
 */
export async function getSendTaskForProcessing(taskId: string) {
  return prisma.sendTask.findUnique({
    where: { id: taskId },
    include: {
      attachments: {
        select: {
          id: true,
          filename: true,
          mimeType: true,
          size: true,
          content: true,
        },
      },
    },
  });
}

/**
 * Flip status → "sending" and bump `attempts`. Done as a separate write so
 * the UI's polling / SSE can show a distinct "sending now" state vs
 * "queued, waiting for worker".
 */
export async function markSendTaskSending(taskId: string): Promise<void> {
  await prisma.sendTask.update({
    where: { id: taskId },
    data: { status: "sending", attempts: { increment: 1 } },
  });
}

/**
 * Provider accepted the send. We delete the row (and its attachments, via
 * cascade) — there's no value in keeping a "sent" row around; the actual
 * Message row in the mail cache is the source of truth from here on.
 */
export async function markSendTaskSentAndDelete(taskId: string): Promise<void> {
  await prisma.sendTask.delete({ where: { id: taskId } });
}

/**
 * Worker hit an error it shouldn't retry — or has run out of retries.
 * Persist the canonical error message on the row so the UI can offer
 * "retry" / "discard" without consulting an Inngest run log.
 */
export async function markSendTaskFailed(
  taskId: string,
  error: string,
): Promise<void> {
  await prisma.sendTask.update({
    where: { id: taskId },
    data: { status: "failed", error },
  });
}
