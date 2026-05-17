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
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";
import { getProviderForAccount } from "@/lib/providers";
import { canonicalizeProviderError } from "@/lib/providers/canonical-errors";
import { ProviderError } from "@/lib/providers/errors";
import type { CanonicalAddress, SendDraft } from "@/lib/providers/types";
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

export async function sendDraft(
  formData: FormData,
): Action<{ providerMessageId: string; providerThreadId: string }> {
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

  const files = formData.getAll("attachments").filter((v): v is File => v instanceof File);
  const attachmentsResult = await validateAttachments(files);
  if (!attachmentsResult.ok) return { ok: false, error: attachmentsResult.error };

  const account = await prisma.mailAccount.findFirst({
    where: { id: parsed.data.accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: false, error: "Account not found" };

  let providerThreadId: string | null = null;
  if (parsed.data.threadId) {
    const thread = await prisma.thread.findFirst({
      where: { id: parsed.data.threadId, account: { userId } },
      select: { providerThreadId: true },
    });
    if (!thread) return { ok: false, error: "Thread not found" };
    providerThreadId = thread.providerThreadId;
  }

  const sanitizedHtml = await sanitizeEmailHtml(parsed.data.bodyHtml);

  const draft: SendDraft = {
    to: parsed.data.to,
    cc: parsed.data.cc.length > 0 ? parsed.data.cc : undefined,
    bcc: parsed.data.bcc.length > 0 ? parsed.data.bcc : undefined,
    subject: parsed.data.subject,
    bodyHtml: sanitizedHtml,
    inReplyTo:
      parsed.data.inReplyTo && parsed.data.inReplyTo.length > 0
        ? parsed.data.inReplyTo[parsed.data.inReplyTo.length - 1]
        : undefined,
    references:
      parsed.data.references && parsed.data.references.length > 0
        ? parsed.data.references
        : undefined,
    attachments:
      attachmentsResult.attachments.length > 0 ? attachmentsResult.attachments : undefined,
  };

  try {
    const provider = await getProviderForAccount(parsed.data.accountId);
    if (parsed.data.mode === "new" || providerThreadId === null) {
      const result = await provider.sendMessage(draft);
      if (parsed.data.draftId) {
        await deleteDraftForUser(userId, parsed.data.draftId);
      }
      return {
        ok: true,
        data: { providerMessageId: result.id, providerThreadId: result.threadId },
      };
    }
    const result = await provider.reply(providerThreadId, draft);
    if (parsed.data.draftId) {
      await deleteDraftForUser(userId, parsed.data.draftId);
    }
    return {
      ok: true,
      data: { providerMessageId: result.id, providerThreadId },
    };
  } catch (e) {
    // Draft row deliberately preserved on send failure — the user keeps their
    // work and can retry. See spec.md risk #10.
    //
    // Never echo `e.message` verbatim. The Graph adapter's `pickMessage` (and
    // any future provider with a verbose error envelope) can carry tenant ids
    // or request ids the user shouldn't see. `canonicalizeProviderError` maps
    // each ProviderError subclass to a fixed action-flavored string.
    if (e instanceof ProviderError) {
      return { ok: false, error: canonicalizeProviderError(e, "send") };
    }
    return { ok: false, error: "Failed to send. Please try again." };
  }
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
