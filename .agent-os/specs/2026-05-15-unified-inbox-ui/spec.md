# Unified Inbox UI

## Goal
Ship the first user-visible mail surface. After this spec lands, a signed-in user with a connected Gmail account sees their real threads at `/inbox`, can filter by account (or view all inboxes together), opens a thread at `/inbox/[threadId]` to read message bodies rendered through the sandboxed-iframe pipeline, and watches the thread auto-mark-read via the Gmail adapter's `markRead`. The UI reads from the `Thread` / `Message` / `Attachment` tables populated by the Inngest sync (gmail-provider spec) — **never** calls the provider during a render. When the cron writes new mail, a Server-Sent Events stream from `/api/inbox/events` nudges open clients to invalidate the right TanStack Query keys; the new rows arrive without a refresh. Provider-agnostic: the route, the list, the thread view, and the SSE handler all consume `Thread.id` directly, so when Graph and IMAP adapters arrive they slot in with zero UI changes.

## User stories
1. **As a signed-in user**, I land on `/inbox` and see my Gmail threads ordered by `lastMessageAt` (descending), one row per thread, with sender(s), subject, snippet, time, and an unread badge.
2. **As a user with one or more connected mailboxes**, I see an account switcher at the top of `/inbox` — chips for "All inboxes" plus one chip per connected `MailAccount`. Clicking a chip filters the list; the choice is reflected in the URL (`?account=<id>` or absent for "all").
3. **As a user**, I click a thread row and arrive at `/inbox/[threadId]`. I see all messages in the thread ordered oldest → newest, with each message's HTML body rendered inside a sandboxed iframe and plain-text bodies rendered as `<pre>`.
4. **As a user**, when I open an unread thread, every unread `Message` in it is marked read — both in the provider (via `GmailProvider.markRead`) and in the local `Message` rows. The unread badge on the list row disappears immediately on return.
5. **As a user with the inbox open**, when the Inngest cron writes a new thread or new message to the DB, my list updates without me clicking refresh.
6. **As a user on mobile (<768 px)**, `/inbox` shows the list full-width; tapping a row navigates to `/inbox/[threadId]` as a full-screen view with a back chevron. On ≥768 px the same route renders as a split pane (list left, thread right).
7. **As a user**, if a fetch fails or the thread can't be found, I see a useful error state, not a blank screen.
8. **As a build agent (`ui-builder`)**, the routes, components, and Server Actions I implement read solely from the canonical `Thread` / `Message` shape — there is no `if (provider === "gmail")` branch anywhere in `app/inbox/**`.

## Non-goals
- **No compose / reply / forward.** No TipTap editor, no send action, no reply button. The composer lands in the `compose-reply-forward` spec.
- **No search input.** No search field, no search results page. The `q` parameter and search route ship with `search-labels-archive-delete`.
- **No label CRUD UI.** Labels render only as plain text where shown; add/remove buttons land in `search-labels-archive-delete`.
- **No archive / trash buttons.** Same spec as above.
- **No bulk-select or keyboard shortcuts (j/k/e/#).** Same spec as above.
- **No AI surfaces.** No summary panel, no priority chip, no draft suggestions, no "Show me the prompt" modal, no AI-priority sort. The thread view renders messages bottom-up by `receivedAt` only; the AI specs in Phase 4 will plug into the same view later via additive components (do not pre-bake hooks or placeholders here).
- **No attachment download.** Attachment metadata renders as a chip with filename + size, but clicking does nothing. The lazy-fetch handler lands later.
- **No reconnect-account flow.** If the sync surfaces an `AuthError` (e.g., stale `historyId`), the inbox shows a banner stating "reconnect required" — wiring the actual reconnect action is out of scope.
- **No threading reconstruction implementation.** Gmail threads natively; the UI reads `Thread.id` as-is. For non-Gmail providers, threading reconstruction is the *imap-provider* spec's responsibility (per `decisions.md`, header-based walk in the adapter). This spec only documents that the UI is provider-agnostic.
- **No SSE auth hardening beyond the session check** (no per-user channel ACL via a signed token, no Last-Event-Id resumption). MVP-grade: the handler scopes events to the authenticated user; replays after disconnect are out of scope.
- **No Postgres `LISTEN/NOTIFY`.** SQLite doesn't support it. We use an in-process Node `EventEmitter` shared between the Inngest function and the SSE route handler, which is sound because Next.js dev (and a single Vercel serverless region with the Inngest dev server) runs both inside one Node process. Cross-process fan-out is a deploy-vercel concern.

## In-scope surfaces

### Routes
- **`/inbox`** (server component) — renders the inbox list, account switcher, and (on ≥768 px) the empty-state right pane.
- **`/inbox/[threadId]`** (server component) — renders the thread view. On <768 px it is the only thing visible; on ≥768 px it occupies the right pane while `/inbox` continues to show the list on the left (achieved via the existing `app/inbox/layout.tsx` shell — the layout owns the split, the route owns its pane).
- **`/api/inbox/events`** (Route Handler, `GET`) — returns `text/event-stream`. One SSE event per sync commit, scoped to the signed-in user.

### Server Actions (`app/inbox/actions.ts`)
```ts
listThreads(input: { accountId?: string; cursor?: string; limit?: number })
  : Promise<{ ok: true; data: { threads: ThreadRow[]; nextCursor: string | null } } | { ok: false; error: string }>

getThread(input: { threadId: string })
  : Promise<{ ok: true; data: { thread: ThreadDetail; messages: MessageDetail[] } } | { ok: false; error: string }>

markThreadRead(input: { threadId: string })
  : Promise<{ ok: true } | { ok: false; error: string }>
```

`ThreadRow`, `ThreadDetail`, `MessageDetail` are render-shaped DTOs the actions produce by reading the `Thread` / `Message` tables (see technical-spec).

### Components
- **`app/inbox/_components/account-switcher.tsx`** (client) — chips bound to a `?account=` URL search param. Reads accounts from a server-prop seed; updates URL on click.
- **`app/inbox/_components/thread-list.tsx`** (client) — TanStack Query over `listThreads`. Renders rows; subscribes to the SSE stream to invalidate.
- **`app/inbox/_components/thread-list-row.tsx`** (server-rendered, server-component-friendly) — single row.
- **`app/inbox/_components/inbox-events-listener.tsx`** (client) — opens `EventSource("/api/inbox/events")`, calls `queryClient.invalidateQueries` for the relevant keys on each event. Mounted once inside `thread-list.tsx`.
- **`app/inbox/[threadId]/_components/thread-view.tsx`** (server) — fetches the thread via `getThread`, renders the message list.
- **`app/inbox/[threadId]/_components/message-card.tsx`** (server) — one message: from / to / time + body.
- **`app/inbox/[threadId]/_components/sandbox-iframe.tsx`** (client) — sandboxed iframe with `srcdoc` for HTML bodies. Calls into a server util that sanitizes via DOMPurify + tracker strip.
- **`app/inbox/[threadId]/_components/mark-read-trigger.tsx`** (client) — invokes `markThreadRead` once on mount via a Server Action call.
- **`app/inbox/loading.tsx`**, **`app/inbox/error.tsx`** — co-located states.
- **`app/inbox/[threadId]/loading.tsx`**, **`app/inbox/[threadId]/error.tsx`**, **`app/inbox/[threadId]/not-found.tsx`** — same.

### Library additions
- **`lib/email-html/sanitize.ts`** — exports `sanitizeEmailHtml(rawHtml: string): string`. Implements the `email-html-sanitize` skill: DOMPurify allow-list, tracker-pixel strip via DOM walk, returns the cleaned HTML string.
- **`lib/realtime/inbox-events.ts`** — exports a singleton Node `EventEmitter` plus typed `emitInboxSyncEvent(userId: string, payload: SyncEvent)` and `subscribeInboxSyncEvents(userId, listener)` helpers. See technical-spec.

### Sync integration (one-line edit to gmail-provider)
- **`lib/inngest/functions/gmail-sync.ts`** — after the existing `prisma.$transaction` commit, emit one event per account via `emitInboxSyncEvent(userId, { accountId, threadIds })`. This is the **only edit outside `app/inbox/**`** the `provider-adapter` agent needs to make for this spec; the change is a ~5-line addition. See technical-spec for the exact insertion point.

## Risks / open questions
1. **Single-process assumption for SSE fan-out.** The EventEmitter only works because Inngest dev and Next.js dev share a Node process, and a single serverless region typically runs both. *Mitigation:* documented as a known limitation in the spec; revisit during `deploy-vercel` (likely move to Postgres `LISTEN/NOTIFY` or a Redis pub/sub). For now this is the simplest thing that meets architectural rule 11.
2. **SSE through Vercel.** Vercel imposes a 30s default streaming timeout on the Hobby tier and supports longer streams on Pro. *Mitigation:* the route sends a heartbeat comment (`: ping\n\n`) every 25s; the client `EventSource` auto-reconnects, which is acceptable.
3. **`markRead` provider call latency on thread open.** The Server Action calls `GmailProvider.markRead` (which goes to Gmail) plus updates the DB; the user is already inside the thread view. *Mitigation:* the Server Action runs *after* the page renders (triggered by `mark-read-trigger.tsx` on mount), so the user sees the thread immediately. The DB write is best-effort; on failure we log and don't block the UI.
4. **Stale `Thread.unreadCount`.** The gmail-sync function only computes `unreadCount` from the current delta window (see comment in `gmail-sync.ts`). *Mitigation:* the inbox `listThreads` action recomputes `unreadCount` server-side via a `COUNT(*) WHERE isUnread = true` aggregate when assembling each `ThreadRow`. This is the SQL the gmail-sync comment promised. **Confirmed: no schema change.**
5. **HTML body height inside a sandboxed iframe.** Without scripts in the iframe, we can't `postMessage` its content height to the parent. *Mitigation:* the iframe gets a generous default `min-height` (e.g. `min(80vh, 1200px)`) and `style="height: auto"`; the iframe itself is allowed to scroll internally. We do not pursue auto-height for MVP.
6. **Iframe + CSP attribute browser support.** The HTML `csp` attribute on iframes is non-standard and only ships on Chrome. *Mitigation:* defense-in-depth — we rely primarily on `sandbox=""` (no `allow-scripts`) and the DOMPurify pass; the CSP attribute is a bonus when the browser honors it. The skill already specifies this combination.
7. **Account filter state location: URL vs. Zustand.** *Decision (not open):* **URL search params** (`?account=<accountId>`). Server components can read `searchParams` directly; refresh-stable; shareable. Zustand reserved for transient UI like selection within a session — not needed for v1 of the inbox. **Open follow-up:** if we later add multi-select filtering, revisit.
8. **`AuthError` from sync (stale historyId).** The gmail-provider spec maps this to a "reconnect required" error; the cron's run-history shows the failure but nothing surfaces to the UI. *Mitigation:* `listThreads` reads `MailAccount.lastSyncedAt` and, if it's older than ~5 minutes *and* there's a recent Inngest failure (heuristic), renders a yellow "Sync stalled — reconnect this account" banner. The reconnect action itself is out of scope; the banner just informs.

## Definition of done
- [ ] `/inbox` renders the signed-in user's threads from the DB, account switcher works, URL filter persists.
- [ ] `/inbox/[threadId]` renders messages oldest → newest with HTML bodies in the sandboxed iframe and plain-text fallbacks.
- [ ] Opening an unread thread calls `markThreadRead` which calls `GmailProvider.markRead` and updates local `Message.isUnread` rows.
- [ ] SSE handler at `/api/inbox/events` streams events; the Inngest function emits on commit; an open inbox client invalidates and re-fetches on each event.
- [ ] Mobile breakpoint at 768 px: list-only on small screens, split-pane on large.
- [ ] All async surfaces have `loading.tsx` / `error.tsx` / empty / `not-found.tsx` as applicable.
- [ ] All unit tests in `sub-specs/tests.md` pass under `npm test:run`.
- [ ] Playwright e2e scenarios in `sub-specs/tests.md` pass under `npm test:e2e` (with the dev server's Inngest function stubbed via MSW for sync events).
- [ ] No provider SDK import inside `app/inbox/**`. No `if (provider === ...)` branch in any inbox component or action.
- [ ] `security-reviewer` has signed off on the sandboxed-iframe pipeline (CSP, sandbox flags, DOMPurify config, tracker strip) and the SSE auth scoping.
- [ ] `.claude/CURRENT_SPEC` advanced to `.agent-os/specs/2026-05-15-unified-inbox-ui/spec.md` (this spec, until it ships) and then to `compose-reply-forward` on hand-off.
