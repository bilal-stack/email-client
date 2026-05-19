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
  /// AI priority score attached to the row for sort + chip rendering.
  /// `null` when no score has been computed yet — the row renders a
  /// placeholder chip. The score chosen for the row is the highest-priority
  /// unread message's score, or the most-recent message's score if all read.
  priority: number | null;
  reason: string | null;
  riskFlag: "phish" | "promo" | "ok" | null;
}

export type InboxSort = "priority" | "time";

/// Logical mail folder. Every value except `"drafts"` is resolved against
/// `Thread.labels`. `"drafts"` is a separate code path that reads the
/// `Draft` table and is intentionally NOT supported by `listThreadsForUser`
/// — callers route to `listDraftsForUser` instead. See `app/inbox/page.tsx`.
export type InboxFolder =
  | "inbox"
  | "sent"
  | "archived"
  | "spam"
  | "trash"
  | "all";

export interface ListThreadsOptions {
  accountId?: string;
  cursor?: string;
  limit?: number;
  /// Default `"priority"`. Selects the order of returned rows.
  /// `"priority"` — by computed displayPriority DESC, then lastMessageAt DESC.
  /// `"time"` — by lastMessageAt DESC (the original behavior).
  sort?: InboxSort;
  /// Default `"inbox"`. Selects which subset of the user's threads to return.
  /// See `InboxFolder` for the semantics of each value. `"drafts"` is NOT
  /// accepted here — it sources from the `Draft` table, not `Thread`.
  folder?: InboxFolder;
}

/**
 * Predicate-style filter applied in JS against a thread's `labels` array.
 * Provider conventions (kept in lockstep across adapters):
 *   - INBOX    → message landed in the inbox (Gmail INBOX; Graph "inbox" folder)
 *   - SENT     → user sent it (Gmail SENT; Graph "sentitems")
 *   - TRASH    → user-trashed
 *   - SPAM     → provider-classified spam (Gmail SPAM; Graph "junkemail")
 *
 * "Archived" is the absence of INBOX without being TRASH/SPAM — Gmail's
 * archive action removes INBOX; Graph's archive moves to a folder we map
 * the same way at sync time.
 */
function threadMatchesFolder(labels: unknown[], folder: InboxFolder): boolean {
  let hasInbox = false;
  let hasSent = false;
  let hasTrash = false;
  let hasSpam = false;
  for (const l of labels) {
    if (l === "INBOX") hasInbox = true;
    else if (l === "SENT") hasSent = true;
    else if (l === "TRASH") hasTrash = true;
    else if (l === "SPAM") hasSpam = true;
  }
  switch (folder) {
    case "inbox":
      // Standard inbox view: must be in INBOX, must not be trashed. A SENT-
      // labeled thread that ALSO has INBOX (e.g. you replied to yourself, or
      // a thread you started got a reply) still shows here — that's correct.
      return hasInbox && !hasTrash && !hasSpam;
    case "sent":
      // Anything the user sent. Trash wins (a trashed sent thread shouldn't
      // resurface in Sent), but spam doesn't apply (provider won't tag your
      // own outgoing mail as spam).
      return hasSent && !hasTrash;
    case "archived":
      // Archived = not currently in INBOX AND not SPAM/TRASH. SENT items
      // that have been archived (no INBOX) WOULD match here too — that's
      // intentional; archive is a state, not a folder, so a sent-then-
      // archived thread legitimately lives in both views.
      return !hasInbox && !hasTrash && !hasSpam;
    case "spam":
      return hasSpam && !hasTrash;
    case "trash":
      return hasTrash;
    case "all":
      // "All mail" view — everything except trashed.
      return !hasTrash;
  }
}

export async function listThreadsForUser(
  userId: string,
  opts: ListThreadsOptions,
): Promise<{ threads: ThreadRow[]; nextCursor: string | null }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const sort: InboxSort = opts.sort ?? "priority";
  const folder: InboxFolder = opts.folder ?? "inbox";
  const accounts = await prisma.mailAccount.findMany({
    where: { userId, ...(opts.accountId ? { id: opts.accountId } : {}) },
    select: { id: true, emailAddress: true },
  });
  if (accounts.length === 0) return { threads: [], nextCursor: null };
  const accountIds = accounts.map((a) => a.id);
  const accountEmailById = new Map(accounts.map((a) => [a.id, a.emailAddress]));

  // We need a per-thread message set wide enough to pick the
  // highest-priority unread (or fall back to the most recent if all read).
  // Fetching every message on every thread regresses the query — taking
  // the last 50 by receivedAt is the practical bound (`unreadCount` rarely
  // exceeds this; tests can adjust later).
  //
  // We always fetch the latest (for the row snippet) and use the same set
  // for the priority lookup.
  const threads = await prisma.thread.findMany({
    where: { accountId: { in: accountIds } },
    orderBy: { lastMessageAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
    include: {
      messages: {
        take: 50,
        orderBy: { receivedAt: "desc" },
        select: {
          id: true,
          snippet: true,
          from: true,
          receivedAt: true,
          isUnread: true,
        },
      },
      _count: { select: { messages: { where: { isUnread: true } } } },
    },
  });

  // Filter to threads in the selected folder. SQLite + Prisma doesn't expose
  // a clean JSON-array contains predicate, so we filter in JS — fine for the
  // page-sized result set; the `deploy-vercel` migration to Postgres can
  // switch to `WHERE labels @>` if perf demands.
  const inInbox = threads.filter((t) => {
    const labels = Array.isArray(t.labels) ? (t.labels as unknown[]) : [];
    return threadMatchesFolder(labels, folder);
  });

  // Per-thread candidate message id: the unread set if any, otherwise the
  // single most-recent message. Flatten the union for one PriorityScore
  // findMany.
  const candidateIdsByThread = new Map<string, string[]>();
  const allCandidateIds: string[] = [];
  for (const t of inInbox) {
    const unread = t.messages.filter((m) => m.isUnread).map((m) => m.id);
    const ids =
      unread.length > 0 ? unread : t.messages.length > 0 ? [t.messages[0]!.id] : [];
    candidateIdsByThread.set(t.id, ids);
    for (const id of ids) allCandidateIds.push(id);
  }
  const scoreByMessageId = new Map<
    string,
    { priority: number; reason: string; riskFlag: string }
  >();
  if (allCandidateIds.length > 0) {
    const scores = await prisma.priorityScore.findMany({
      where: { messageId: { in: allCandidateIds } },
      select: { messageId: true, priority: true, reason: true, riskFlag: true },
    });
    for (const s of scores) {
      scoreByMessageId.set(s.messageId, {
        priority: s.priority,
        reason: s.reason,
        riskFlag: s.riskFlag,
      });
    }
  }

  // Build the row with the chosen score: among unread messages, the highest
  // `priority` wins (with ties broken by the natural unread order); if no
  // unread message has a score, fall back to the most-recent message's
  // score. Threads with no score yet render `priority: null`.
  type RowDraft = ThreadRow;
  const drafts: RowDraft[] = inInbox.map((t) => {
    const candidateIds = candidateIdsByThread.get(t.id) ?? [];
    const unreadIds = new Set(
      t.messages.filter((m) => m.isUnread).map((m) => m.id),
    );

    let chosen: { priority: number; reason: string; riskFlag: string } | null = null;
    if (unreadIds.size > 0) {
      for (const id of candidateIds) {
        if (!unreadIds.has(id)) continue;
        const s = scoreByMessageId.get(id);
        if (!s) continue;
        if (!chosen || s.priority > chosen.priority) chosen = s;
      }
    } else if (candidateIds.length > 0) {
      const s = scoreByMessageId.get(candidateIds[0]!);
      if (s) chosen = s;
    }

    const latest = t.messages[0];
    const fromJson = (latest?.from ?? null) as unknown as {
      name?: string;
      email?: string;
    } | null;

    const riskFlagNarrowed: "phish" | "promo" | "ok" | null =
      chosen && (chosen.riskFlag === "phish" || chosen.riskFlag === "promo" || chosen.riskFlag === "ok")
        ? chosen.riskFlag
        : null;

    return {
      id: t.id,
      accountId: t.accountId,
      accountEmail: accountEmailById.get(t.accountId) ?? "",
      subject: t.subject,
      snippet: latest?.snippet ?? "",
      fromName: fromJson?.name ?? fromJson?.email ?? "",
      participantCount: Array.isArray(t.participants)
        ? (t.participants as unknown[]).length
        : 0,
      unreadCount: t._count.messages,
      lastMessageAt: t.lastMessageAt,
      priority: chosen?.priority ?? null,
      reason: chosen?.reason ?? null,
      riskFlag: riskFlagNarrowed,
    };
  });

  // Sort. `"time"` keeps the existing `lastMessageAt DESC` order (which is
  // already what the SQL `orderBy` produced). `"priority"` re-sorts the
  // page in JS by displayPriority DESC, ties broken by lastMessageAt DESC.
  // Null priority treats as 3 so brand-new (still-being-scored) messages
  // settle in the middle rather than sinking to the bottom.
  if (sort === "priority") {
    drafts.sort((a, b) => {
      const ap = a.priority ?? 3;
      const bp = b.priority ?? 3;
      if (ap !== bp) return bp - ap;
      return b.lastMessageAt.getTime() - a.lastMessageAt.getTime();
    });
  }

  // Cursor pagination semantics are unchanged — the SQL fetch already
  // applied the cursor against the `lastMessageAt DESC` SQL order, so the
  // cursor lookup returns "the next page in time order." For the
  // priority-sorted page, the page boundary still rolls forward by time;
  // a future spec can introduce a richer cursor if needed.
  const nextCursor =
    drafts.length > limit ? (drafts[limit - 1]?.id ?? null) : null;
  const slice = drafts.slice(0, limit);

  return { threads: slice, nextCursor };
}

// ─── Drafts (separate code path — sources from `Draft` table) ──────────
//
// The drafts folder doesn't fit the `Thread`-based `ThreadRow` shape because
// a draft can be pre-thread (a brand-new compose with `threadId === null`).
// We return a parallel row type so the UI can render drafts in the same
// list slot without the Server Action layer pretending drafts are threads.

export interface DraftRow {
  /// The Draft.id — DOES NOT collide with Thread.id.
  id: string;
  accountId: string;
  accountEmail: string;
  /// The thread this draft is attached to, if any. `null` for a brand-new
  /// compose; the row's "Open" link goes to /inbox/compose/new in that case.
  threadId: string | null;
  mode: "new" | "reply" | "reply-all" | "forward";
  subject: string;
  /// Plain-text preview of the body — keeps the row visually consistent with
  /// a ThreadRow's `snippet`.
  snippet: string;
  /// "To: foo@bar, baz@qux" condensed to a single line — empty if no recipients yet.
  toLine: string;
  updatedAt: Date;
}

/**
 * List every draft for the user, optionally scoped to one account. Sorted by
 * `updatedAt DESC` so the freshest draft is at the top. Returns a cap of 100
 * rows; the drafts folder is small in practice (single-digit per account)
 * and there's no pagination story for it yet.
 */
export async function listDraftsForUser(
  userId: string,
  opts: { accountId?: string } = {},
): Promise<{ drafts: DraftRow[] }> {
  const rows = await prisma.draft.findMany({
    where: { userId, ...(opts.accountId ? { accountId: opts.accountId } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 100,
    include: { account: { select: { emailAddress: true } } },
  });

  const drafts: DraftRow[] = rows.map((r) => {
    const toArr = Array.isArray(r.to) ? (r.to as Array<{ email?: string }>) : [];
    const toLine = toArr
      .map((a) => a.email)
      .filter((e): e is string => Boolean(e))
      .join(", ");
    // Best-effort plain-text snippet from the HTML body. We only strip tags
    // and collapse whitespace — full sanitization is overkill for a list-row
    // preview that never gets rendered as HTML.
    const snippet = String(r.bodyHtml ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    return {
      id: r.id,
      accountId: r.accountId,
      accountEmail: r.account.emailAddress,
      threadId: r.threadId,
      mode: r.mode as DraftRow["mode"],
      subject: r.subject,
      snippet,
      toLine,
      updatedAt: r.updatedAt,
    };
  });

  return { drafts };
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
