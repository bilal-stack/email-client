import { prisma } from "@/lib/db";

export interface ThreadRow {
  id: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  snippet: string;
  fromName: string;
  participantCount: number;
  unreadCount: number;
  lastMessageAt: Date;
}

export async function listThreadsForUser(
  userId: string,
  opts: { accountId?: string; cursor?: string; limit?: number },
): Promise<{ threads: ThreadRow[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const accounts = await prisma.mailAccount.findMany({
    where: { userId, ...(opts.accountId ? { id: opts.accountId } : {}) },
    select: { id: true, emailAddress: true },
  });
  if (accounts.length === 0) return { threads: [], nextCursor: null };
  const accountIds = accounts.map((a) => a.id);
  const accountEmailById = new Map(accounts.map((a) => [a.id, a.emailAddress]));

  const threads = await prisma.thread.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: { lastMessageAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: {
      messages: {
        select: { id: true, snippet: true, from: true, receivedAt: true, isUnread: true },
        orderBy: { receivedAt: "desc" },
      },
    },
  });

  const nextCursor = threads.length > limit ? (threads[limit - 1]?.id ?? null) : null;
  const slice = threads.slice(0, limit);

  const rows: ThreadRow[] = slice.map((t) => {
    const latest = t.messages[0];
    const unread = t.messages.filter((m) => m.isUnread).length;
    const fromJson = (latest?.from ?? null) as unknown as { name?: string; email?: string } | null;
    return {
      id: t.id,
      accountId: t.accountId,
      accountEmail: accountEmailById.get(t.accountId) ?? "",
      subject: t.subject,
      snippet: latest?.snippet ?? "",
      fromName: fromJson?.name ?? fromJson?.email ?? "",
      participantCount: Array.isArray(t.participants) ? (t.participants as unknown[]).length : 0,
      unreadCount: unread,
      lastMessageAt: t.lastMessageAt,
    };
  });
  return { threads: rows, nextCursor };
}

export async function getThreadByIdForUser(userId: string, threadId: string) {
  return prisma.thread.findFirst({
    where: { id: threadId, account: { userId } },
    include: {
      account: { select: { id: true, emailAddress: true } },
      messages: {
        orderBy: { receivedAt: "asc" },
        include: { attachments: true },
      },
    },
  });
}
