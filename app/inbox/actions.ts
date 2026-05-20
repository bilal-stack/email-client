"use server";

import type { ThreadDTO, ThreadMessageDTO } from "@/app/inbox/_lib/dto";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  applyLabelsLocally,
  archiveLocally,
  revertLabels,
  trashLocally,
} from "@/lib/db/inbox-mutations";
import {
  type DraftRow,
  type ThreadRow,
  getThreadByIdForUser,
  listDraftsForUser,
  listThreadsForUser,
} from "@/lib/db/inbox-queries";
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";
import { getProviderForAccount } from "@/lib/providers";
import { canonicalizeProviderError } from "@/lib/providers/canonical-errors";
import { z } from "zod";

type Action<T> = Promise<{ ok: true; data: T } | { ok: false; error: string }>;

const listThreadsInput = z.object({
  accountId: z.string().cuid().optional(),
  cursor: z.string().cuid().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  sort: z.enum(["priority", "time"]).optional(),
  folder: z.enum(["inbox", "sent", "archived", "spam", "trash", "all"]).optional(),
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

const listDraftsInput = z.object({
  accountId: z.string().cuid().optional(),
});

/**
 * List the user's drafts. Drafts live in their own table and don't fit the
 * `ThreadRow` shape, so the drafts folder routes here instead of going
 * through `listThreads`. See `lib/db/inbox-queries.ts → listDraftsForUser`.
 */
export async function listDraftsAction(
  input: z.infer<typeof listDraftsInput>,
): Action<{ drafts: DraftRow[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = listDraftsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  const data = await listDraftsForUser(session.user.id, parsed.data);
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
        labels: Array.isArray(t.labels)
          ? (t.labels as unknown[]).filter((l): l is string => typeof l === "string")
          : [],
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
    // Funnel every ProviderError subtype through the canonicalizer so we
    // never echo Graph's raw envelope (which can carry tenant ids) or any
    // other provider-flavored detail. AuthError → "Please reconnect this
    // account" — the UI keys off that phrase to surface a reconnect button.
    return { ok: false, error: canonicalizeProviderError(e, "markRead") };
  }

  const upd = await prisma.message.updateMany({
    where: { id: { in: messages.map((m) => m.id) } },
    data: { isUnread: false },
  });
  return { ok: true, data: { updatedCount: upd.count } };
}

// ───────────────────── search, archive, trash, labels ──────────────────────

const idArray = z.array(z.string().cuid()).min(1).max(500);

const searchThreadsInput = z.object({
  query: z.string().min(1).max(1024),
  accountId: z.string().cuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export interface SearchResultRow {
  id: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  snippet: string;
  fromName: string;
  participantCount: number;
  unreadCount: number;
  lastMessageAt: Date;
  // Search results bypass the prioritizer (the search call hits the provider
  // directly, not the local PriorityScore-aware listThreads path). The chip
  // slots stay null so the row renderer falls back to the "not yet scored"
  // placeholder — same shape as the inbox row would carry pre-score.
  priority: number | null;
  reason: string | null;
  riskFlag: "phish" | "promo" | "ok" | null;
}

/**
 * Provider-agnostic search across the user's connected mailboxes. Each account
 * is queried in parallel via `provider.search(query)`. Results are merged + sorted
 * by `lastMessageAt desc` and capped at `limit`. Partial success: if account A
 * succeeds and account B's provider throws, we return A's results with an
 * `error` field; this matches the inbox UX where partial data > all-or-nothing.
 */
export async function searchThreads(
  input: z.input<typeof searchThreadsInput>,
): Action<{ threads: SearchResultRow[]; nextCursor: string | null }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = searchThreadsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const accounts = await prisma.mailAccount.findMany({
    where: {
      userId: session.user.id,
      ...(parsed.data.accountId ? { id: parsed.data.accountId } : {}),
    },
    select: { id: true, emailAddress: true },
  });
  if (accounts.length === 0) return { ok: true, data: { threads: [], nextCursor: null } };

  const merged: SearchResultRow[] = [];
  await Promise.allSettled(
    accounts.map(async (a) => {
      const provider = await getProviderForAccount(a.id);
      const result = await provider.search(parsed.data.query, { limit: parsed.data.limit });
      for (const t of result.items) {
        merged.push({
          id: t.id,
          accountId: a.id,
          accountEmail: a.emailAddress,
          subject: t.subject,
          snippet: t.snippet,
          fromName: t.participants[0]?.name ?? t.participants[0]?.email ?? "",
          participantCount: t.participants.length,
          unreadCount: t.unreadCount,
          lastMessageAt: t.lastMessageAt,
          priority: null,
          reason: null,
          riskFlag: null,
        });
      }
    }),
  );

  merged.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());
  return {
    ok: true,
    data: {
      threads: merged.slice(0, parsed.data.limit),
      nextCursor: null,
    },
  };
}

const mutateThreadsInput = z.object({ threadIds: idArray });

interface OwnedThreadRow {
  id: string;
  accountId: string;
  providerMessageIds: string[];
}

/**
 * Load the user's threads filtered to a set of ids, returning each thread's
 * accountId + provider message ids. Rejects the whole batch if any thread is
 * unowned (returns `null` in that case so callers can short-circuit).
 */
async function loadOwnedThreads(
  threadIds: string[],
  userId: string,
): Promise<OwnedThreadRow[] | null> {
  const rows = await prisma.thread.findMany({
    where: { id: { in: threadIds }, account: { userId } },
    select: {
      id: true,
      accountId: true,
      messages: { select: { providerMessageId: true } },
    },
  });
  if (rows.length !== threadIds.length) return null;
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    providerMessageIds: r.messages.map((m) => m.providerMessageId),
  }));
}

function groupBy<T, K extends string>(items: T[], keyOf: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = keyOf(item);
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

interface FanoutResult {
  updatedCount: number;
  failedAccountIds: string[];
}

/**
 * Hard ceiling on a single provider mutation call (archive / trash /
 * setLabels). Without this, a hanging Google or Microsoft endpoint would
 * keep the Server Action's HTTP request socket open until Node's keepalive
 * killed it (minutes), which in dev exhausts Chrome's 6-connections-per-host
 * budget and locks the whole tab. 20 s is comfortably above p99 for these
 * calls and short enough that a hung call surfaces as a normal action
 * failure (the local mutation is then reverted via `revertLabels`).
 */
const PROVIDER_MUTATION_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${label} timed out after ${ms}ms`), {
            name: "TimeoutError",
          }),
        ),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function fanoutPerAccount(
  rows: OwnedThreadRow[],
  call: (accountId: string, providerMessageIds: string[]) => Promise<void>,
): Promise<FanoutResult> {
  const byAccount = groupBy(rows, (r) => r.accountId as string);
  const accountIds = Object.keys(byAccount);
  const results = await Promise.allSettled(
    accountIds.map(async (accountId) => {
      const group = byAccount[accountId] ?? [];
      const messageIds = group.flatMap((r) => r.providerMessageIds);
      if (messageIds.length === 0) return group.length;
      await withTimeout(
        call(accountId, messageIds),
        PROVIDER_MUTATION_TIMEOUT_MS,
        `provider mutation for ${accountId}`,
      );
      return group.length;
    }),
  );
  let updatedCount = 0;
  const failedAccountIds: string[] = [];
  for (const [i, res] of results.entries()) {
    const accountId = accountIds[i];
    if (!accountId) continue;
    if (res.status === "fulfilled") updatedCount += res.value;
    else failedAccountIds.push(accountId);
  }
  return { updatedCount, failedAccountIds };
}

function idsForAccounts(rows: OwnedThreadRow[], accountIds: string[]): string[] {
  const set = new Set(accountIds);
  return rows.filter((r) => set.has(r.accountId)).map((r) => r.id);
}

/**
 * Archive (remove the INBOX label) on each owned thread. Optimistic local
 * mutation runs first, then per-account provider fan-out. Any account whose
 * provider call throws gets its threads' labels reverted from the snapshot.
 */
export async function archiveThreads(
  input: z.infer<typeof mutateThreadsInput>,
): Action<{ updatedCount: number; failedAccountIds: string[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = mutateThreadsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const owned = await loadOwnedThreads(parsed.data.threadIds, session.user.id);
  if (!owned) return { ok: false, error: "Forbidden: thread not owned" };

  const snap = await archiveLocally(parsed.data.threadIds, session.user.id);
  const result = await fanoutPerAccount(owned, async (_accountId, messageIds) => {
    const provider = await getProviderForAccount(_accountId);
    await provider.archive(messageIds);
  });
  if (result.failedAccountIds.length > 0) {
    await revertLabels(snap, session.user.id, idsForAccounts(owned, result.failedAccountIds));
  }
  return { ok: true, data: result };
}

/**
 * Move to trash. Same flow as archive, different provider call + label diff.
 */
export async function trashThreads(
  input: z.infer<typeof mutateThreadsInput>,
): Action<{ updatedCount: number; failedAccountIds: string[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = mutateThreadsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const owned = await loadOwnedThreads(parsed.data.threadIds, session.user.id);
  if (!owned) return { ok: false, error: "Forbidden: thread not owned" };

  const snap = await trashLocally(parsed.data.threadIds, session.user.id);
  const result = await fanoutPerAccount(owned, async (_accountId, messageIds) => {
    const provider = await getProviderForAccount(_accountId);
    await provider.trash(messageIds);
  });
  if (result.failedAccountIds.length > 0) {
    await revertLabels(snap, session.user.id, idsForAccounts(owned, result.failedAccountIds));
  }
  return { ok: true, data: result };
}

const setThreadLabelsInput = z.object({
  threadIds: idArray,
  add: z.array(z.string().max(256)).max(50).default([]),
  remove: z.array(z.string().max(256)).max(50).default([]),
});

/**
 * Add and/or remove labels on owned threads. Add and remove can both be
 * empty (no-op). Per-account fan-out; revert on partial failure.
 */
export async function setThreadLabels(
  input: z.input<typeof setThreadLabelsInput>,
): Action<{ updatedCount: number; failedAccountIds: string[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = setThreadLabelsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  if (parsed.data.add.length === 0 && parsed.data.remove.length === 0) {
    return { ok: true, data: { updatedCount: 0, failedAccountIds: [] } };
  }

  const owned = await loadOwnedThreads(parsed.data.threadIds, session.user.id);
  if (!owned) return { ok: false, error: "Forbidden: thread not owned" };

  const snap = await applyLabelsLocally(
    parsed.data.threadIds,
    session.user.id,
    parsed.data.add,
    parsed.data.remove,
  );
  const result = await fanoutPerAccount(owned, async (_accountId, messageIds) => {
    const provider = await getProviderForAccount(_accountId);
    await provider.setLabels(messageIds, parsed.data.add, parsed.data.remove);
  });
  if (result.failedAccountIds.length > 0) {
    await revertLabels(snap, session.user.id, idsForAccounts(owned, result.failedAccountIds));
  }
  return { ok: true, data: result };
}

const getLabelsForThreadsInput = z.object({ threadIds: idArray });

/**
 * Return the union of labels currently applied to the given (owned) threads.
 * Used by the bulk labels popover so it can pre-check labels that are on at
 * least one selected thread — without this seed, the diff against `checked`
 * would only ever produce additions, and bulk-remove via the UI is impossible.
 *
 * Ownership-scoped via `account: { userId }`; an unowned thread id is silently
 * dropped (no leak about whether the id exists).
 */
export async function getLabelsForThreads(
  input: z.infer<typeof getLabelsForThreadsInput>,
): Action<{ labels: string[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = getLabelsForThreadsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const rows = await prisma.thread.findMany({
    where: { id: { in: parsed.data.threadIds }, account: { userId: session.user.id } },
    select: { labels: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.labels)) {
      for (const l of r.labels as unknown[]) {
        if (typeof l === "string") set.add(l);
      }
    }
  }
  return { ok: true, data: { labels: [...set].sort() } };
}

const listLabelsInput = z.object({ accountId: z.string().cuid().optional() });

/**
 * List every label currently in use across the user's threads. Deduped +
 * sorted. UI calls this lazily when the labels popover opens.
 */
export async function listAvailableLabels(
  input: z.infer<typeof listLabelsInput>,
): Action<{ labels: string[] }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };
  const parsed = listLabelsInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const rows = await prisma.thread.findMany({
    where: {
      account: {
        userId: session.user.id,
        ...(parsed.data.accountId ? { id: parsed.data.accountId } : {}),
      },
    },
    select: { labels: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    if (Array.isArray(r.labels)) {
      for (const l of r.labels as unknown[]) {
        if (typeof l === "string") set.add(l);
      }
    }
  }
  return { ok: true, data: { labels: [...set].sort() } };
}
