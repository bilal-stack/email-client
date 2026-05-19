"use server";

import type { DraftDTO } from "@/app/inbox/compose/dto";
import { auth } from "@/lib/auth";
import {
  type DraftMode,
  deleteDraftForUser,
  getDraftByIdForUser,
  getDraftForUser,
  upsertDraftForUser,
} from "@/lib/compose/draft-queries";
import { validateAttachments } from "@/lib/compose/upload-guard";
import { prisma } from "@/lib/db";
import { createSendTask } from "@/lib/db/send-tasks";
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";
import { INBOX_SEND_TASK_QUEUED } from "@/lib/inngest/events";
import { inngest } from "@/lib/inngest/client";
import type { CanonicalAddress } from "@/lib/providers/types";
import { z } from "zod";

type Action<T> = Promise<{ ok: true; data: T } | { ok: false; error: string }>;

const addressSchema = z.object({
  name: z.string().optional(),
  email: z.string().email(),
});

const draftModeSchema = z.enum(["new", "reply", "reply-all", "forward"]);

// ─── upsertDraft (autosave) ──────────────────────────────────────────────
const upsertDraftInput = z.object({
  draftId: z.string().cuid().optional(),
  accountId: z.string().cuid(),
  threadId: z.string().cuid().nullable(),
  mode: draftModeSchema,
  to: z.array(addressSchema),
  cc: z.array(addressSchema),
  bcc: z.array(addressSchema),
  subject: z.string().max(998),
  bodyHtml: z.string().max(2_000_000),
  inReplyTo: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});

export async function upsertDraft(
  input: z.infer<typeof upsertDraftInput>,
): Action<{ draftId: string; updatedAt: Date }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = upsertDraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const userId = session.user.id;

  const account = await prisma.mailAccount.findFirst({
    where: { id: parsed.data.accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false, error: "Account not found" };

  if (parsed.data.threadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: parsed.data.threadId, account: { userId } },
      select: { id: true },
    });
    if (!thread) return { ok: false, error: "Thread not found" };
  }

  const row = await upsertDraftForUser(userId, parsed.data);
  return { ok: true, data: { draftId: row.id, updatedAt: row.updatedAt } };
}

// ─── discardDraft ────────────────────────────────────────────────────────
const discardDraftInput = z.object({ draftId: z.string().cuid() });

export async function discardDraft(
  input: z.infer<typeof discardDraftInput>,
): Action<Record<string, never>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = discardDraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const owned = await getDraftByIdForUser(session.user.id, parsed.data.draftId);
  if (!owned) return { ok: false, error: "Draft not found" };

  await deleteDraftForUser(session.user.id, parsed.data.draftId);
  return { ok: true, data: {} };
}

// ─── getDraft ────────────────────────────────────────────────────────────
const getDraftInput = z.object({
  threadId: z.string().cuid().nullable(),
  mode: draftModeSchema,
});

export async function getDraft(input: z.infer<typeof getDraftInput>): Action<DraftDTO | null> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = getDraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const row = await getDraftForUser(session.user.id, parsed.data);
  if (!row) return { ok: true, data: null };

  return {
    ok: true,
    data: {
      id: row.id,
      accountId: row.accountId,
      threadId: row.threadId,
      mode: row.mode as DraftMode,
      to: jsonAsAddresses(row.to),
      cc: jsonAsAddresses(row.cc),
      bcc: jsonAsAddresses(row.bcc),
      subject: row.subject,
      bodyHtml: row.bodyHtml,
      inReplyTo: jsonAsStrings(row.inReplyTo),
      references: jsonAsStrings(row.references),
      updatedAt: row.updatedAt,
    },
  };
}

// ─── sendDraft (FormData) ────────────────────────────────────────────────
const sendDraftFormSchema = z.object({
  draftId: z.string().cuid().optional(),
  accountId: z.string().cuid(),
  threadId: z.string().cuid().nullable(),
  mode: draftModeSchema,
  to: z.array(addressSchema).min(1, "At least one recipient is required"),
  cc: z.array(addressSchema),
  bcc: z.array(addressSchema),
  subject: z.string().max(998),
  bodyHtml: z.string().max(2_000_000),
  inReplyTo: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});

function readField(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

function parseJsonField<T>(fd: FormData, key: string, fallback: T): T {
  const raw = readField(fd, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Enqueue a send. The actual provider call happens in the
 * `process-send-task` Inngest worker — this action is intentionally fast
 * (no upload time, no Gmail API round-trip) so the user's "Send" click
 * returns instantly.
 *
 * Returns the `sendTaskId` so the UI can correlate SSE completion events
 * back to the toast / outbox row it's showing.
 */
export async function sendDraft(
  formData: FormData,
): Action<{ sendTaskId: string }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const userId = session.user.id;

  const rawDraftId = readField(formData, "draftId");
  const rawThreadId = readField(formData, "threadId");
  const candidate = {
    draftId: rawDraftId || undefined,
    accountId: readField(formData, "accountId"),
    threadId: rawThreadId === "" ? null : rawThreadId,
    mode: readField(formData, "mode"),
    to: parseJsonField<unknown[]>(formData, "to", []),
    cc: parseJsonField<unknown[]>(formData, "cc", []),
    bcc: parseJsonField<unknown[]>(formData, "bcc", []),
    subject: readField(formData, "subject"),
    bodyHtml: readField(formData, "bodyHtml"),
    inReplyTo: parseJsonField<string[]>(formData, "inReplyTo", []),
    references: parseJsonField<string[]>(formData, "references", []),
  };
  const parsed = sendDraftFormSchema.safeParse(candidate);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return { ok: false, error: first?.message ?? "Invalid input" };
  }

  // Attachment validation MUST run inline — it's the cheap defense against
  // a 5GB upload pinning the SendTask row. Bytes get pulled into Buffers
  // here and persisted into the SendTaskAttachment table; the worker
  // streams them out at send time without re-reading the original Files.
  const files = formData.getAll("attachments").filter((v): v is File => v instanceof File);
  const attachmentsResult = await validateAttachments(files);
  if (!attachmentsResult.ok) return { ok: false, error: attachmentsResult.error };

  const account = await prisma.mailAccount.findFirst({
    where: { id: parsed.data.accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false, error: "Account not found" };

  // Capture providerThreadId at enqueue time so the worker doesn't have to
  // re-read it later. A thread deleted in-flight between enqueue and worker
  // run no longer blocks the send.
  let providerThreadId: string | null = null;
  if (parsed.data.threadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: parsed.data.threadId, account: { userId } },
      select: { providerThreadId: true },
    });
    if (!thread) return { ok: false, error: "Thread not found" };
    providerThreadId = thread.providerThreadId;
  }

  // Sanitize HTML inline — sanitize-html is sync-ish and fast, and we want
  // a single source of truth for the cleaned body that goes into the DB
  // (so a retry doesn't re-sanitize and risk a different result).
  const sanitizedHtml = await sanitizeEmailHtml(parsed.data.bodyHtml);

  // Persist the SendTask + attachment bytes, then enqueue the Inngest
  // event. We do NOT optimistically write the Message row yet — the
  // recordSentMessage call lives inside the worker so the (Thread,
  // Message, label) state only flips after the provider has actually
  // accepted the send. The UI shows "Sending…" off of the SendTask row.
  const { taskId } = await createSendTask({
    userId,
    accountId: parsed.data.accountId,
    mode: parsed.data.mode,
    threadId: parsed.data.threadId,
    providerThreadId,
    to: parsed.data.to,
    cc: parsed.data.cc,
    bcc: parsed.data.bcc,
    subject: parsed.data.subject,
    bodyHtml: sanitizedHtml,
    inReplyTo:
      parsed.data.inReplyTo && parsed.data.inReplyTo.length > 0
        ? (parsed.data.inReplyTo[parsed.data.inReplyTo.length - 1] ?? null)
        : null,
    references: parsed.data.references ?? [],
    attachments: attachmentsResult.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      // `SendAttachment` doesn't carry an explicit `size` — derive it from
      // the byte buffer so the worker can render a "12 KB" hint without
      // re-streaming the bytes.
      size: a.content.byteLength,
      content: a.content,
    })),
  });

  // Enqueue last — if this throws, the orphaned SendTask row will sit in
  // status='queued' until manually reaped. Cheap, simple recovery target
  // for a future "outbox" UI; for now the worker can re-pick on
  // restart-via-cron if we add one.
  try {
    await inngest.send({
      name: INBOX_SEND_TASK_QUEUED,
      data: { taskId, userId, accountId: parsed.data.accountId },
    });
  } catch (e) {
    // Inngest is down / unreachable. Surface a retryable error and leave
    // the task row in place — the user can resubmit (which dedupes via
    // the draft row, but creates a new SendTask; that's acceptable for
    // dev). We don't expose the underlying message.
    const err = e as { name?: string; message?: string } | undefined;
    console.warn("inngest.send failed", { name: err?.name, message: err?.message });
    return {
      ok: false,
      error:
        "Couldn't queue your message right now. Please try again in a moment.",
    };
  }

  // Discard the draft now that it's safely captured in a SendTask. If the
  // background send fails, the SendTask row holds the body, so the user
  // can retry from the outbox UI without re-typing.
  if (parsed.data.draftId) {
    try {
      await deleteDraftForUser(userId, parsed.data.draftId);
    } catch (e) {
      const err = e as { name?: string; message?: string } | undefined;
      console.warn("deleteDraftForUser failed", {
        name: err?.name,
        message: err?.message,
      });
    }
  }

  return { ok: true, data: { sendTaskId: taskId } };
}

// ─── Outbox (in-flight SendTask) management ─────────────────────────────
//
// These actions back the small "outbox" status surface in the layout: a
// list of tasks currently queued / sending / failed, plus the two recovery
// affordances we offer (retry / discard). The list is intentionally tiny —
// successful tasks delete themselves, so the only rows here are work-in-
// progress or work the user needs to act on.

export interface OutboxTaskDTO {
  id: string;
  accountId: string;
  status: "queued" | "sending" | "failed";
  subject: string;
  /// `null` for queued/sending — populated only once the worker has given
  /// up and persisted a canonical error string.
  error: string | null;
  /// Most recent state-flip timestamp; the row sorts by this for display.
  updatedAt: Date;
}

/**
 * List the user's in-flight (queued / sending / failed) send tasks. The
 * UI polls / SSE-invalidates this so the outbox pill stays current.
 */
export async function listPendingSendTasks(): Action<{ tasks: OutboxTaskDTO[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const rows = await prisma.sendTask.findMany({
    where: { userId: session.user.id, status: { in: ["queued", "sending", "failed"] } },
    select: {
      id: true,
      accountId: true,
      status: true,
      subject: true,
      error: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 25,
  });
  return {
    ok: true,
    data: {
      tasks: rows.map((r) => ({
        id: r.id,
        accountId: r.accountId,
        status: r.status as OutboxTaskDTO["status"],
        subject: r.subject,
        error: r.error,
        updatedAt: r.updatedAt,
      })),
    },
  };
}

const taskIdSchema = z.object({ taskId: z.string().cuid() });

/**
 * Re-enqueue a failed send. We flip the task status back to "queued",
 * null out the error, and emit the same Inngest event the original send
 * did. The worker picks it up exactly as if it were a fresh task.
 */
export async function retrySendTask(
  input: z.infer<typeof taskIdSchema>,
): Action<Record<string, never>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = taskIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  // Ownership check + status read in one go. We refuse to retry anything
  // already in flight (queued / sending) — that's a no-op pretending to
  // be a retry, which is more confusing than rejecting.
  const task = await prisma.sendTask.findFirst({
    where: { id: parsed.data.taskId, userId: session.user.id },
    select: { id: true, status: true, accountId: true, userId: true },
  });
  if (!task) return { ok: false, error: "Task not found" };
  if (task.status !== "failed") {
    return { ok: false, error: "This message isn't in a failed state." };
  }

  await prisma.sendTask.update({
    where: { id: task.id },
    data: { status: "queued", error: null },
  });

  try {
    await inngest.send({
      name: INBOX_SEND_TASK_QUEUED,
      data: { taskId: task.id, userId: task.userId, accountId: task.accountId },
    });
  } catch (e) {
    const err = e as { name?: string; message?: string } | undefined;
    console.warn("inngest.send (retry) failed", { name: err?.name, message: err?.message });
    // Roll the status back so the UI doesn't get stuck showing "queued"
    // forever — the user can press retry again.
    await prisma.sendTask
      .update({ where: { id: task.id }, data: { status: "failed" } })
      .catch(() => {});
    return {
      ok: false,
      error: "Couldn't queue the retry right now. Please try again in a moment.",
    };
  }
  return { ok: true, data: {} };
}

/**
 * Discard a failed (or stuck queued) send. Deletes the SendTask row and
 * its attachments via cascade.
 */
export async function discardSendTask(
  input: z.infer<typeof taskIdSchema>,
): Action<Record<string, never>> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = taskIdSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  // Ownership-scoped delete. `deleteMany` returns count==0 silently when
  // the row doesn't exist or belongs to someone else, which is the
  // no-leak behavior we want.
  await prisma.sendTask.deleteMany({
    where: { id: parsed.data.taskId, userId: session.user.id },
  });
  return { ok: true, data: {} };
}

// ─── helpers ─────────────────────────────────────────────────────────────
function jsonAsAddresses(v: unknown): CanonicalAddress[] {
  if (!Array.isArray(v)) return [];
  const out: CanonicalAddress[] = [];
  for (const raw of v) {
    if (raw && typeof raw === "object") {
      const r = raw as { name?: unknown; email?: unknown };
      if (typeof r.email === "string") {
        out.push(
          typeof r.name === "string" ? { name: r.name, email: r.email } : { email: r.email },
        );
      }
    }
  }
  return out;
}

function jsonAsStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}
