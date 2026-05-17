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

  // Only the latest message is needed to populate the row (snippet + from);
  // unread count is a SQL aggregation, not a JS filter over every row. This
  // replaces a pathological `include: { messages: true }` that previously
  // shipped every message body across the wire just to count unread.
  const threads = await prisma.thread.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: { lastMessageAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: {
      messages: {
        take: 1,
        orderBy: { receivedAt: "desc" },
        select: { id: true, snippet: true, from: true, receivedAt: true },
      },
      _count: { select: { messages: { where: { isUnread: true } } } },
    },
  });

  // Filter to threads currently in the inbox: must have INBOX label AND must
  // not have TRASH. SQLite + Prisma doesn't expose a clean JSON-array contains
  // predicate, so we filter in JS — fine for the page-sized result set; the
  // `deploy-vercel` migration to Postgres can switch to `WHERE labels @>` if
  // perf demands.
  const inInbox = threads.filter((t) => {
    const labels = Array.isArray(t.labels) ? (t.labels as unknown[]) : [];
    let hasInbox = false;
    let hasTrash = false;
    for (const l of labels) {
      if (l === "INBOX") hasInbox = true;
      else if (l === "TRASH") hasTrash = true;
    }
    return hasInbox && !hasTrash;
  });

  const nextCursor = inInbox.length > limit ? (inInbox[limit - 1]?.id ?? null) : null;
  const slice = inInbox.slice(0, limit);

  const rows: ThreadRow[] = slice.map((t) => {
    const latest = t.messages[0];
    const fromJson = (latest?.from ?? null) as unknown as { name?: string; email?: string } | null;
    return {
      id: t.id,
      accountId: t.accountId,
      accountEmail: accountEmailById.get(t.accountId) ?? "",
      subject: t.subject,
      snippet: latest?.snippet ?? "",
      fromName: fromJson?.name ?? fromJson?.email ?? "",
      participantCount: Array.isArray(t.participants) ? (t.participants as unknown[]).length : 0,
      unreadCount: t._count.messages,
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
