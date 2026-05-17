# Tasks

Ordered. Owning agent in brackets.

## 1. Local optimistic mutations (`lib/db/inbox-mutations.ts`) — [`ui-builder`]
- Export `archiveLocally(threadIds: string[], userId: string)`, `trashLocally(threadIds: string[], userId: string)`, `applyLabelsLocally(threadIds: string[], userId: string, add: string[], remove: string[])`.
- All three:
  - Load threads `WHERE id IN (...) AND account.userId = userId` (ownership).
  - Compute the new `labels` JSON for each based on the operation.
  - `prisma.thread.update` each row.
  - Return the previous labels per id so the caller can revert on provider throw.

## 2. Server Actions — additions to `app/inbox/actions.ts` — [`ui-builder`]
- Add `searchThreads`, `archiveThreads`, `trashThreads`, `setThreadLabels`, `listAvailableLabels`.
- Each Zod-validates input + `await auth()` (return `Unauthorized` if no session).
- `archiveThreads` / `trashThreads` / `setThreadLabels` flow:
  1. Group `threadIds` by `accountId` via a single DB query (`thread.findMany({ select: { id, accountId, account: { select: { userId } } } })` filtered to user-owned).
  2. Reject if any thread isn't owned (return early with `Forbidden`).
  3. Snapshot the affected rows' current labels (call into `inbox-mutations` to get them).
  4. Apply the local mutation (optimistic).
  5. For each `accountId` group, get `provider = getProviderForAccount(accountId)`, call `provider.archive(providerMessageIds)` / `provider.trash(providerMessageIds)` / `provider.setLabels(providerMessageIds, add, remove)`. Note: providers operate on **message ids**, not thread ids — load message ids from each thread.
  6. On any provider throw, revert the affected rows' labels via `applyLabelsLocally` with the snapshot.
  7. Return `{ ok: true, data: { <count> } }` summing successful accounts.
- `searchThreads`:
  1. Validate query string (non-empty, max length).
  2. Group: if `accountId` provided, single account; else loop all user's accounts.
  3. For each account, call `provider.search(query, { limit })`.
  4. Merge results, sort by `lastMessageAt desc`, return as `SearchResultRow[]` (same shape as `ThreadRow`).
- `listAvailableLabels`:
  1. Query `prisma.thread.findMany({ where: { account: { userId } }, select: { labels: true } })`.
  2. Flatten `labels` arrays, dedupe, sort, return.

## 3. Inbox query filter — [`ui-builder`]
- Edit `lib/db/inbox-queries.ts` → `listThreadsForUser`: add a `WHERE` clause to filter to threads where the JSON `labels` array contains `"INBOX"`. SQLite + Prisma's Json column means using `prisma.$queryRaw` for the array-contains check OR fetching all and filtering in JS (the inbox-query test asserts the count anyway; filter-in-JS is fine for small N).
- Document the choice with an inline comment.

## 4. Selection store (`lib/inbox/selection-store.ts`) — [`ui-builder`]
- `"use client"`. Zustand slice with `selectedThreadIds: Set<string>` + `toggle(id)`, `clear()`, `selectMany(ids)`.
- Exported as `useInboxSelection`.

## 5. Keyboard hook (`lib/inbox/keyboard.ts`) — [`ui-builder`]
- `"use client"`. `useInboxKeyboard({ rows, onOpen, onArchive, onTrash, onToggleSelect, onFocusSearch })`:
  - Attaches `keydown` to `document`; cleans up on unmount.
  - Ignores when `target` is `<input>`, `<textarea>`, or `[contenteditable=true]`.
  - Tracks `focusedIndex` in local state; `j`/`k` move it; `Enter` calls `onOpen(rows[focusedIndex].id)`.
  - `x` (and `Space`) → `onToggleSelect(rows[focusedIndex].id)`.
  - `e` → `onArchive(selectedIds.size > 0 ? selectedIds : [rows[focusedIndex].id])`.
  - `#` → `onTrash(...)` same pattern.
  - `/` → `onFocusSearch()`.
  - `Esc` → `clear()` selection.
  - Returns `{ focusedIndex }` for visual highlighting.

## 6. Search input — [`ui-builder`]
- `app/inbox/_components/search-input.tsx` (`"use client"`). Controlled input bound to `useState` + URL sync.
- On Enter: `router.push(\`/inbox/search?q=\${encodeURIComponent(value)}\`)`.
- Reads initial value from `useSearchParams().get("q")`.
- Exposes `focus()` via `useImperativeHandle` so the keyboard hook can focus it via `/`.

## 7. Search route (`app/inbox/search/page.tsx` + loading.tsx + error.tsx) — [`ui-builder`]
- Server component. Reads `searchParams.q` and optional `searchParams.account`.
- If `q` is empty → render the same split-pane shell with an empty-state pane (no search yet).
- Else → call `searchThreads` Server Action (via Server Component call), render `<ThreadList />` with results.
- Share the same `<SearchInput />` from the layout — pre-fills via `q` param.

## 8. Bulk action bar — [`ui-builder`]
- `app/inbox/_components/bulk-action-bar.tsx` (`"use client"`). Subscribes to selection store.
- Renders only when `selectedThreadIds.size > 0`.
- Shows count, Archive, Trash, Labels button (opens popover).
- Wires to `archiveThreads`, `trashThreads`, `setThreadLabels` Server Actions.
- On success: clears selection.

## 9. Labels popover — [`ui-builder`]
- `app/inbox/_components/labels-popover.tsx` (`"use client"`). On open, fires `listAvailableLabels` (cached in TanStack Query for the session).
- Checkboxes for each label; computes `add`/`remove` diff from initial state.
- Apply button → `setThreadLabels(threadIds, add, remove)`.

## 10. Thread row updates — [`ui-builder`]
- Edit `app/inbox/_components/thread-list-row.tsx`:
  - Add a checkbox at the left edge (hover-visible; always-visible when selected).
  - Add hover-visible Archive + Trash icon buttons at the right edge.
  - Accept a `focused?: boolean` prop for the keyboard nav highlight.
- Edit `app/inbox/_components/thread-list.tsx`:
  - Mount `useInboxKeyboard`.
  - Pass `focused={i === focusedIndex}` to each row.
  - Scroll the focused row into view via `scrollIntoView({ block: "nearest" })`.

## 11. Thread view archive + trash — [`ui-builder`]
- Edit `app/inbox/[threadId]/_components/thread-view.tsx`: append Archive + Trash buttons next to Reply / Reply all / Forward.
- Buttons call the same `archiveThreads` / `trashThreads` Server Actions, then `router.push("/inbox")`.

## 12. Tests — [`test-author`]
Per `sub-specs/tests.md`:
- Unit: `lib/db/inbox-mutations.test.ts` (archive/trash/applyLabels happy + ownership + revert returns prior).
- Unit: Server Action additions in `app/inbox/actions.test.ts` (extend existing file): searchThreads, archiveThreads, trashThreads, setThreadLabels, listAvailableLabels — happy path, ownership, multi-account fanout, provider-failure-reverts.
- Unit: `lib/inbox/selection-store.test.ts` (toggle/clear/selectMany).
- E2E: `tests/e2e/inbox-actions.spec.ts` scaffolded with `test.fixme` per the no-auth-bypass convention.

## 13. Hand-off
- `security-reviewer` runs `/security-review`. Focus areas:
  - Ownership scoping on every thread mutation
  - Optimistic-revert path covers all action types
  - Zod validation on every input
  - Multi-account fanout doesn't leak threads across accounts
- On pass: bump `.claude/CURRENT_SPEC` to the next spec (`graph-provider`).
