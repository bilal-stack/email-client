"use server";

import type { ThreadDTO, ThreadMessageDTO } from "@/app/inbox/_lib/dto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { type ThreadRow, getThreadByIdForUser, listThreadsForUser } from "@/lib/db/inbox-queries";
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";
import { getProviderForAccount } from "@/lib/providers";
import { z } from "zod";

type Action<T> = Promise<{ ok: true; data: T } | { ok: false; error: string }>;

const listThreadsInput = z.object({
  accountId: z.string().cuid().optional(),
  cursor: z.string().cuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export async function listThreads(input: z.infer<typeof listThreadsInput>): Action<{
  threads: ThreadRow[];
  nextCursor: string | null;
}> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = listThreadsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const data = await listThreadsForUser(session.user.id, parsed.data);
  return { ok: true, data };
}

const getThreadInput = z.object({ threadId: z.string().cuid() });

export async function getThread(input: z.infer<typeof getThreadInput>): Action<{
  thread: ThreadDTO;
  messages: ThreadMessageDTO[];
}> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = getThreadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const t = await getThreadByIdForUser(session.user.id, parsed.data.threadId);
  if (!t) return { ok: false, error: "Not found" };

  return {
    ok: true,
    data: {
      thread: {
        id: t.id,
        subject: t.subject,
        accountId: t.account.id,
        accountEmail: t.account.emailAddress,
      },
      messages: await Promise.all(
        t.messages.map(async (m) => {
          const fromJson = m.from as unknown as { name?: string; email?: string } | null;
          const toJsonRaw = m.to as unknown;
          const toJson = Array.isArray(toJsonRaw) ? (toJsonRaw as Array<{ email?: string }>) : [];
          return {
            id: m.id,
            fromName: fromJson?.name ?? "",
            fromEmail: fromJson?.email ?? "",
            toLine: toJson
              .map((a) => a.email)
              .filter((e): e is string => Boolean(e))
              .join(", "),
            receivedAt: m.receivedAt,
            bodyHtml: m.bodyHtml ? await sanitizeEmailHtml(m.bodyHtml) : null,
            bodyText: m.bodyText,
            attachments: m.attachments.map((a) => ({
              id: a.id,
              filename: a.filename,
              size: a.size,
              mimeType: a.mimeType,
            })),
          };
        }),
      ),
    },
  };
}

const markThreadReadInput = z.object({ threadId: z.string().cuid() });

export async function markThreadRead(
  input: z.infer<typeof markThreadReadInput>,
): Action<{ updatedCount: number }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = markThreadReadInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const messages = await prisma.message.findMany({
    where: {
      threadId: parsed.data.threadId,
      account: { userId: session.user.id },
      isUnread: true,
    },
    select: { id: true, accountId: true, providerMessageId: true },
  });
  if (messages.length === 0) return { ok: true, data: { updatedCount: 0 } };

  const byAccount = new Map<string, string[]>();
  for (const m of messages) {
    const list = byAccount.get(m.accountId) ?? [];
    list.push(m.providerMessageId);
    byAccount.set(m.accountId, list);
  }

  try {
    for (const [accountId, ids] of byAccount) {
      const provider = await getProviderForAccount(accountId);
      await provider.markRead(ids, true);
    }
  } catch (e) {
    // Canonicalize: never bubble raw provider error strings (could contain
    // URLs / path fragments). If it's an AuthError keep the public reason
    // so the UI can prompt reconnect; otherwise a generic message.
    const isAuth =
      e instanceof Error &&
      (e.constructor.name === "AuthError" || /reconnect required/i.test(e.message));
    const msg = isAuth && e instanceof Error ? e.message : "Failed to mark as read";
    return { ok: false, error: msg };
  }

  const upd = await prisma.message.updateMany({
    where: { id: { in: messages.map((m) => m.id) } },
    data: { isUnread: false },
  });
  return { ok: true, data: { updatedCount: upd.count } };
}
