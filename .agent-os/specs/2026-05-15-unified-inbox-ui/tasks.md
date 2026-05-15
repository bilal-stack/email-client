# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation. Owning agent in brackets.

## 1. In-process realtime bus (`lib/realtime/inbox-events.ts`) — [`ui-builder`]
- New file. Export a singleton Node `EventEmitter`, keyed-by-userId emit/subscribe helpers, and the `SyncEvent` type. See `sub-specs/technical-spec.md` for the exact ~30-line skeleton.
- Must use `globalThis` caching so HMR in dev doesn't multiply emitters.

## 2. Sync function emits on commit — [`provider-adapter`]
- Edit `lib/inngest/functions/gmail-sync.ts`.
- After the `prisma.$transaction` block resolves successfully, look up `MailAccount.userId` (already in scope via the listing query — extend the `select` to include `userId`), then call `emitInboxSyncEvent(userId, { accountId: account.id, threadIds: [...] })`.
- `threadIds` = the set of `Thread.id` values written/upserted in this commit (collect during the transaction; if simpler, just emit the set of `providerThreadId` keys and let the client invalidate broadly — see technical-spec).
- **No other changes to gmail-sync.ts.** Do not introduce a new error path; if the emit itself throws, swallow + log (the DB commit already succeeded; SSE is best-effort).

## 3. SSE Route Handler (`app/api/inbox/events/route.ts`) — [`ui-builder`]
- `GET` handler. Returns `Response` with `text/event-stream`, `cache-control: no-cache, no-transform`, `connection: keep-alive`.
- Resolves the session via `auth()`. If no user, return 401.
- Subscribes to the bus with the user's id; writes `data: <json>\n\n` per event.
- Sends `: ping\n\n` every 25 s to keep Vercel's edge from timing out.
- Cleans up the subscription on `request.signal`'s `abort`.

## 4. HTML sanitizer (`lib/email-html/sanitize.ts`) — [`ui-builder`]
- Implement `sanitizeEmailHtml(rawHtml: string): string` per the `email-html-sanitize` skill.
- DOMPurify config (allow-list of tags and attrs) verbatim from the skill.
- Tracker-pixel strip: parse cleaned HTML with `linkedom`, walk `<img>` tags, drop those whose `src` matches the tracker domain regex list OR has `width=1` & `height=1`.
- Add `isomorphic-dompurify` and `linkedom` to `package.json` (npm install runs in the build phase, not here).
- Co-locate `sanitize.test.ts` (see `sub-specs/tests.md`).

## 5. Server Actions (`app/inbox/actions.ts`) — [`ui-builder`]
- Implement `listThreads`, `getThread`, `markThreadRead` per the technical spec.
- All three: Zod-validate input; resolve session; constrain queries to the signed-in user's `MailAccount` rows.
- `listThreads` returns thread rows with a server-computed `unreadCount = COUNT(messages WHERE isUnread)` aggregate.
- `getThread` returns the thread plus all its `Message`s ordered `receivedAt ASC`, with `bodyHtml` already passed through `sanitizeEmailHtml`.
- `markThreadRead`:
  1. Loads the thread + all its unread `Message` rows scoped to the user.
  2. Calls `getProviderForAccount(accountId).markRead(providerMessageIds, true)` — propagating any `AuthError` as `{ ok: false, error }`.
  3. On success, `updateMany({ isUnread: false })` on those rows.

## 6. Inbox list page (`app/inbox/page.tsx`) — [`ui-builder`]
- Replace the current placeholder. Server component.
- Reads `searchParams.account` for the filter; fetches initial threads via the same query the `listThreads` Server Action uses (factored into a shared `lib/db/inbox-queries.ts` so both server-component first paint AND the Server Action call the same code).
- Renders: `<AccountSwitcher accounts={...} active={...} />` over `<ThreadList initial={...} accountId={...} />` plus the empty-state right pane on ≥768 px.
- Co-locate `loading.tsx` and `error.tsx`.

## 7. `AccountSwitcher` component — [`ui-builder`]
- Client component. Props: `accounts: { id, emailAddress, displayName }[]`, `active: string | null`.
- Chips: "All inboxes" + one per account.
- Click: pushes to `/inbox?account=<id>` (or `/inbox` for "all") via `useRouter` from `next/navigation`.
- Visual: shadcn `Button` variant `outline` with an active-state ring.

## 8. `ThreadList` + `ThreadListRow` + `InboxEventsListener` — [`ui-builder`]
- `ThreadList` is a client component, wraps a TanStack Query `useQuery({ queryKey: ["inbox", accountId], queryFn: () => listThreads({ accountId }) })`, hydrated from the server-component `initial` prop via `initialData`.
- Renders `ThreadListRow` for each. Row links to `/inbox/[threadId]`.
- Mounts `InboxEventsListener` once. The listener opens `EventSource("/api/inbox/events")` and, on each message, calls `queryClient.invalidateQueries({ queryKey: ["inbox"] })` and `queryClient.invalidateQueries({ queryKey: ["thread"] })` (broad invalidation — fine for v1).
- Row layout: avatar (initial-letter fallback from sender), bold sender name (or count if multi-participant thread), subject, snippet, time, unread dot. Tailwind, mobile-friendly.

## 9. Thread view page (`app/inbox/[threadId]/page.tsx`) — [`ui-builder`]
- Server component. Reads `params.threadId`.
- Calls the shared `lib/db/inbox-queries.ts` `getThreadById(userId, threadId)`. If not found or not owned by the user, `notFound()`.
- Renders `<ThreadView thread={...} messages={...} />` plus `<MarkReadTrigger threadId={threadId} />`.
- Co-locate `loading.tsx`, `error.tsx`, `not-found.tsx`.

## 10. `ThreadView` + `MessageCard` — [`ui-builder`]
- `ThreadView` server component: header (subject + participants), then a list of `<MessageCard>` ordered oldest → newest.
- `MessageCard` server component: from / to / time, then either `<SandboxIframe html={message.bodyHtml} />` (if `bodyHtml`) or `<pre className="whitespace-pre-wrap">{message.bodyText}</pre>`.
- Attachment chips: list each `Attachment` as a non-interactive pill with filename + size; no click handler in this spec.

## 11. `SandboxIframe` — [`ui-builder`]
- Client component. Props: `html: string` (already sanitized server-side via `sanitizeEmailHtml`).
- Renders `<iframe srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" csp="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'" style={{ minHeight: "min(80vh, 1200px)", width: "100%", border: 0 }} />`.
- No script, no postMessage, no auto-height calculation — see open question 5 in `spec.md`.

## 12. `MarkReadTrigger` — [`ui-builder`]
- Client component, `"use client"`, takes `threadId` prop.
- `useEffect(() => { markThreadRead({ threadId }).catch(() => {}) }, [threadId])`.
- Renders nothing.

## 13. Layout adjustment for split pane — [`ui-builder`]
- Edit `app/inbox/layout.tsx` only as needed to support the ≥768 px split pane.
- The existing layout already has a sidebar slot; this spec uses the *main* area for split: the list on the left, the thread (the `[threadId]` child) on the right. Cleanest approach is **parallel routes** with `@list` and `@thread` slots, but to keep the spec small we instead **render both list and thread inside the `[threadId]` route on ≥768 px** — i.e., the thread page also renders the list. On <768 px, the thread page shows only the thread; the list is at `/inbox`. Implementation detail captured here so reviewers don't expect parallel-routes machinery.

## 14. Tests — [`test-author`]
- Per `sub-specs/tests.md`. Three concerns:
  1. Unit: `sanitize.ts` against the phishing fixture; `inbox-events.ts` emit/subscribe contract.
  2. Unit: server actions with Prisma against `file:./test.db`; provider call mocked through the registry.
  3. E2E (Playwright): sign-in fixture → inbox list visible → click thread → body iframe present → unread badge gone on back-navigation. Mobile-viewport variant.

## 15. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas: iframe `sandbox` flags, CSP, DOMPurify allow-list, SSE auth scoping, that `markThreadRead` only reaches the user's own accounts.
- On pass: bump `.claude/CURRENT_SPEC` to `.agent-os/specs/2026-05-XX-compose-reply-forward/spec.md` *(spec folder not yet authored — planner produces it next)*.
