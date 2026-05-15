# Technical Spec — Unified Inbox UI

## State store choices

| Concern | Choice | Why |
|---|---|---|
| Account filter (`accountId`) | **URL search param** `?account=<id>` | Server-component-readable via `searchParams`; refresh-stable; shareable links. Zustand for transient filter state would force everything through a client component and lose the SSR first paint. |
| Selected thread | **URL** (it's just the route `/inbox/[threadId]`) | Same reasoning. No store needed. |
| Server cache | **TanStack Query** | Per `tech-stack.md` and architectural rule 11. Keys: `["inbox", accountId ?? null]`, `["thread", threadId]`. |
| Anything else client-side | None this spec | We do not introduce a Zustand slice for v1. If keyboard-shortcut multi-select arrives in `search-labels-archive-delete`, that spec adds the slice. |

The TanStack Query keys live in `app/inbox/_lib/query-keys.ts`:

```ts
export const queryKeys = {
  inbox: (accountId: string | null) => ["inbox", accountId] as const,
  thread: (threadId: string) => ["thread", threadId] as const,
};
```

## Shared DB query helpers (`lib/db/inbox-queries.ts`)

Both the server-component first paint and the `listThreads` Server Action call into this so we don't double-implement the query.

```ts
import { prisma } from "@/lib/db";

export interface ThreadRow {
  id: string;
  accountId: string;
  accountEmail: string;
  subject: string;
  snippet: string; // from most-recent message
  fromName: string; // most-recent message's `from.name ?? from.email`
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

  const nextCursor = threads.length > limit ? threads[limit - 1]!.id : null;
  const slice = threads.slice(0, limit);

  const rows: ThreadRow[] = slice.map((t) => {
    const latest = t.messages[0];
    const unread = t.messages.filter((m) => m.isUnread).length;
    const fromJson = latest?.from as { name?: string; email: string } | null;
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
  const thread = await prisma.thread.findFirst({
    where: { id: threadId, account: { userId } },
    include: {
      account: { select: { id: true, emailAddress: true } },
      messages: {
        orderBy: { receivedAt: "asc" },
        include: { attachments: true },
      },
    },
  });
  return thread;
}
```

The `unreadCount` recompute lives in this helper (point 4 in `spec.md` risks) — the gmail-sync function's delta-window count is overwritten by this aggregate at read time.

## Server Action signatures (`app/inbox/actions.ts`)

```ts
"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getThreadByIdForUser, listThreadsForUser } from "@/lib/db/inbox-queries";
import { getProviderForAccount } from "@/lib/providers";
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";

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
  thread: { id: string; subject: string; accountEmail: string };
  messages: Array<{
    id: string;
    fromName: string;
    fromEmail: string;
    toLine: string;
    receivedAt: Date;
    bodyHtml: string | null; // already sanitized
    bodyText: string | null;
    attachments: Array<{ filename: string; size: number; mimeType: string }>;
  }>;
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
      thread: { id: t.id, subject: t.subject, accountEmail: t.account.emailAddress },
      messages: t.messages.map((m) => ({
        id: m.id,
        fromName: (m.from as { name?: string }).name ?? "",
        fromEmail: (m.from as { email: string }).email,
        toLine: ((m.to as Array<{ email: string }>) ?? []).map((a) => a.email).join(", "),
        receivedAt: m.receivedAt,
        bodyHtml: m.bodyHtml ? sanitizeEmailHtml(m.bodyHtml) : null,
        bodyText: m.bodyText,
        attachments: m.attachments.map((a) => ({
          filename: a.filename,
          size: a.size,
          mimeType: a.mimeType,
        })),
      })),
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

  // Group by account — every message in a thread is the same account in practice,
  // but the cast is cheap insurance.
  const byAccount = new Map<string, string[]>();
  for (const m of messages) {
    const list = byAccount.get(m.accountId) ?? [];
    list.push(m.providerMessageId);
    byAccount.set(m.accountId, list);
  }

  for (const [accountId, ids] of byAccount) {
    const provider = await getProviderForAccount(accountId);
    await provider.markRead(ids, true); // may throw AuthError; surfaced as { ok: false }
  }

  const upd = await prisma.message.updateMany({
    where: { id: { in: messages.map((m) => m.id) } },
    data: { isUnread: false },
  });
  return { ok: true, data: { updatedCount: upd.count } };
}
```

## SSE Route Handler (`app/api/inbox/events/route.ts`)

```ts
import { auth } from "@/lib/auth";
import { subscribeInboxSyncEvents, type SyncEvent } from "@/lib/realtime/inbox-events";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("Unauthorized", { status: 401 });
  const userId = session.user.id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const onEvent = (e: SyncEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      const unsubscribe = subscribeInboxSyncEvents(userId, onEvent);

      // Heartbeat: comment lines (lines starting with ":") are ignored by
      // EventSource but keep intermediaries from closing the connection.
      const heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(`: ping\n\n`));
      }, 25_000);

      const cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
```

## In-process realtime bus (`lib/realtime/inbox-events.ts`)

```ts
import { EventEmitter } from "node:events";

export interface SyncEvent {
  accountId: string;
  threadIds: string[]; // Thread.id values touched this sync commit
  at: number; // epoch ms
}

// HMR in dev can re-evaluate this module and produce duplicate emitters,
// which leads to dropped events. Cache on globalThis so we keep one instance
// per Node process across re-evals.
const globalKey = Symbol.for("email-client.inbox-events.emitter");
type GlobalWithBus = typeof globalThis & { [globalKey]?: EventEmitter };
const g = globalThis as GlobalWithBus;
const bus: EventEmitter = (g[globalKey] ??= new EventEmitter().setMaxListeners(1000));

function channel(userId: string) {
  return `inbox:${userId}`;
}

export function emitInboxSyncEvent(userId: string, event: SyncEvent): void {
  bus.emit(channel(userId), event);
}

export function subscribeInboxSyncEvents(
  userId: string,
  listener: (e: SyncEvent) => void,
): () => void {
  const ch = channel(userId);
  bus.on(ch, listener);
  return () => bus.off(ch, listener);
}
```

## Sync-function edit (`lib/inngest/functions/gmail-sync.ts`)

Two changes only:

1. Extend the `list-accounts` select to include `userId`:
   ```ts
   prisma.mailAccount.findMany({
     where: { provider: "gmail" },
     select: { id: true, syncCursor: true, userId: true },
   });
   ```
2. Inside the existing `step.run("sync-${account.id}", ...)`, *after* `prisma.$transaction` resolves successfully, collect the touched thread DB ids (from the `providerThreadIdToDbId` map already built during the transaction) and emit:
   ```ts
   import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";
   // ... after the await prisma.$transaction(...) block:
   try {
     const touched = [...providerThreadIdToDbId.values()];
     if (touched.length > 0 || delta.deletedIds.length > 0 || delta.changedMessages.length > 0) {
       emitInboxSyncEvent(account.userId, {
         accountId: account.id,
         threadIds: touched,
         at: Date.now(),
       });
     }
   } catch (e) {
     // Best-effort; the DB commit already succeeded. Log and continue.
     console.warn("inbox-events emit failed", e);
   }
   ```

`providerThreadIdToDbId` is declared inside the transaction callback; lift its declaration out of the callback so it's reachable after `await prisma.$transaction(...)`. No other behavior changes.

## HTML sanitizer (`lib/email-html/sanitize.ts`)

Implements the `email-html-sanitize` skill verbatim. Skeleton:

```ts
import DOMPurify from "isomorphic-dompurify";
import { parseHTML } from "linkedom";

const TRACKER_DOMAINS = [
  /\bmailchimp\.com\b/i,
  /\bsendgrid\.net\b/i,
  /\bgodaddy\.com\b/i,
  /\bhubspot\.com\b/i,
  /\bsalesforce\.com\b/i,
  /\bmkt[\d]+\.com\b/i,
  /\bpixel\b/i,
  /\btrack\b/i,
  /\bbeacon\b/i,
  /\bemltrk\b/i,
];

export function sanitizeEmailHtml(rawHtml: string): string {
  const cleaned = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
      "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5",
      "h6", "hr", "i", "img", "li", "ol", "p", "pre", "small", "span", "strong", "sub", "sup",
      "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
    ],
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "width", "height", "align"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    ALLOW_DATA_ATTR: false,
  });

  const { document } = parseHTML(`<!doctype html><html><body>${cleaned}</body></html>`);
  for (const img of [...document.querySelectorAll("img")]) {
    const src = img.getAttribute("src") ?? "";
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");
    const isTinyPixel = w === "1" && h === "1";
    const isTrackerHost = TRACKER_DOMAINS.some((re) => re.test(src));
    if (isTinyPixel || isTrackerHost) img.remove();
  }
  return document.body.innerHTML;
}
```

## Sandboxed iframe component

```tsx
"use client";

export function SandboxIframe({ html }: { html: string }) {
  return (
    <iframe
      title="Email body"
      srcDoc={html}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      // The `csp` attribute is Chrome-only as of 2026 — a defense-in-depth bonus.
      // The primary defenses are `sandbox` (no `allow-scripts`) and the prior
      // DOMPurify pass.
      csp="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"
      className="w-full border-0"
      style={{ minHeight: "min(80vh, 1200px)", width: "100%" }}
    />
  );
}
```

## SSE client integration

```tsx
"use client";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function InboxEventsListener() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/inbox/events");
    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transient drops; nothing for us to do.
    };
    return () => es.close();
  }, [qc]);
  return null;
}
```

## Mobile breakpoints

- **`< 768 px`**: `/inbox` shows the list full-width. Tapping a row navigates to `/inbox/[threadId]` which renders only the thread view, with a `<Link href="/inbox">` back chevron in the header. No split pane.
- **`≥ 768 px`**: `/inbox/[threadId]` renders the list on the left (320 px column) and the thread on the right (1fr). `/inbox` (no threadId) renders only the list (or list + empty-state CTA on the right). Implemented inside the routes themselves rather than via parallel-route slots — see `tasks.md` task 13 for the rationale.

Tailwind realization: `className="grid md:grid-cols-[320px_1fr] grid-cols-1"` on the layout's `<main>`, with the list rendered conditionally on mobile based on whether `params.threadId` is present.

## Threading reconstruction (documentation only)

The inbox UI consumes `Thread.id` from the DB; **it does not build threads.** Each provider adapter is responsible for either:
- **Native threading** (Gmail's `threadId`, Graph's `conversationId`) — pass through verbatim to `CanonicalMessage.threadId` / `CanonicalThread.id`. (Gmail already does this in the gmail-provider spec.)
- **Header-based reconstruction** (IMAP) — walk RFC 5322 `Message-ID` / `In-Reply-To` / `References` headers at sync time and persist a synthetic `providerThreadId` on the message row. (Lands in the `imap-provider` spec per `decisions.md`.)

This spec exists to render `Thread` rows; the source of those rows is intentionally not its concern.

## Out of scope (recap)
Compose, search, label CRUD, archive, trash, AI surfaces, attachment download, bulk-select, keyboard shortcuts, reconnect-account flow, Postgres `LISTEN/NOTIFY`, cross-process SSE fan-out.
