# Search, Labels, Archive, Delete

## Goal
Round out the inbox CRUD surface. After this spec lands, the user can: type a query into a search bar at the top of `/inbox` and see provider-agnostic results at `/inbox/search?q=...`; archive a thread (single or bulk); move a thread to trash (single or bulk); add or remove labels on a thread (single or bulk); select multiple threads via checkboxes; and drive all of the above from the keyboard (`j`/`k` to move between threads, `e` to archive, `#` to trash, `x` to toggle selection, `/` to focus the search input). All actions route through the canonical `IEmailProvider` methods (`search` / `archive` / `trash` / `setLabels`) — UI never branches on provider. Local DB rows are mutated optimistically and a successful provider call locks them in; a provider throw reverts the optimistic state.

## User stories
1. **As a signed-in user**, I see a search input at the top of `/inbox`. Typing a query and pressing Enter navigates to `/inbox/search?q=<query>`, where I see threads matching the query across all my connected mailboxes (currently just Gmail, but the contract is provider-agnostic).
2. **As a user looking at a thread row**, I can click an "Archive" icon button to archive that thread. The row disappears from the inbox immediately (optimistic); the provider call runs in the background. On provider failure the row reappears and an inline error chip shows briefly.
3. **As a user looking at a thread row**, I can click a "Trash" icon button with the same UX as archive.
4. **As a user**, I can open a "Labels" dropdown on any thread to check/uncheck labels from a list of labels currently in use across my mailbox. Confirming applies `IEmailProvider.setLabels(threadId, add, remove)` and updates the local row.
5. **As a user**, I can hover any thread row and a checkbox appears at the left edge. Clicking it selects the thread. While at least one thread is selected, a bulk-action toolbar slides into view above the list with **Archive selected**, **Trash selected**, and **Labels** controls.
6. **As a user**, I can drive everything from the keyboard:
   - `j` / `k` — move the "focused" thread down / up (visual highlight, not a selection)
   - `Enter` — open the focused thread
   - `x` — toggle selection of the focused thread (also `Space` for accessibility)
   - `e` — archive the focused thread (or all selected when selection is non-empty)
   - `#` — trash the focused thread (or all selected)
   - `/` — focus the search input
   - `Esc` — clear selection / blur search
7. **As a user on a thread view**, the existing thread header gains **Archive** and **Trash** buttons (alongside the Reply / Reply all / Forward buttons added in the previous spec). Clicking either applies to the whole thread and navigates back to `/inbox`.
8. **As a build agent (`ui-builder`)**, none of the new code branches on `provider === "gmail"` etc. All mutations call `getProviderForAccount(account.id).{archive|trash|setLabels|search}` — the canonical interface.

## Non-goals
- **No AI-powered search.** Natural-language → structured query is `ai-search` territory (out of roadmap entirely). Search forwards the raw user query string to `IEmailProvider.search(query)`, which delegates to provider-native search syntax (Gmail accepts `from:`, `has:attachment`, etc. as-is — power users can use those; we don't transform).
- **No label management UI** (create / rename / delete labels). We only let users apply or remove labels that *already exist* on some message in their mailbox. Creating a new label needs the provider's label-creation API which `IEmailProvider` doesn't expose.
- **No smart filters in search results** (no per-account scope filter, no date filter chip, etc.). Just a thread list of results. Power users can compose filters into the query string (`from:bob`).
- **No snooze, star, mute, mark-as-spam, mark-as-important.** Out of scope for the eval submission.
- **No "Move to folder" UI for Graph / IMAP**. Provider-agnostic label semantics handle this when those adapters land.
- **No undo toast** ("Archived. Undo within 5s.") — nice-to-have, defer.
- **No keyboard-shortcut help modal** (`?` to show shortcuts). Inline tooltips on buttons are enough.
- **No drag-and-drop** to archive or label. Click only.
- **No search history / recent queries dropdown.** Plain input.
- **No "Search this thread"** — search is global.
- **No labels CRUD via Server Action other than what `setLabels` exposes** — applying or removing existing labels only.

## In-scope surfaces

### Routes
- **`/inbox/search?q=<query>&account=<id>?`** (server component) — renders the same split-pane shell as `/inbox`, but the list is `searchThreadsForUser(userId, query, { accountId? })` results instead of the local DB list. Reuses `ThreadList` / `ThreadListRow`. Search-input value pre-populated from the `q` query param.
- The existing `/inbox` route gains the search bar in the layout shell and the bulk-action toolbar above the list.

### Server Actions (`app/inbox/actions.ts` — additive, alongside existing actions)
```ts
searchThreads(input: { query: string; accountId?: string; cursor?: string; limit?: number })
  : Promise<{ ok: true; data: { threads: SearchResultRow[]; nextCursor: string | null } } | { ok: false; error: string }>

archiveThreads(input: { threadIds: string[] })
  : Promise<{ ok: true; data: { archivedCount: number } } | { ok: false; error: string }>

trashThreads(input: { threadIds: string[] })
  : Promise<{ ok: true; data: { trashedCount: number } } | { ok: false; error: string }>

setThreadLabels(input: { threadIds: string[]; add: string[]; remove: string[] })
  : Promise<{ ok: true; data: { updatedCount: number } } | { ok: false; error: string }>

listAvailableLabels(input: { accountId?: string })
  : Promise<{ ok: true; data: { labels: string[] } } | { ok: false; error: string }>
```

All Zod-validated, all userId-scoped, all dispatch via `getProviderForAccount(account.id).{...}`.

### Components (`app/inbox/_components/`)
- **`search-input.tsx`** (client) — controlled input wired to `useRouter().push(\`/inbox/search?q=...\`)` on Enter. Shows current query when on the search route. Mounted in `app/inbox/layout.tsx` header (left of the Compose button).
- **`bulk-action-bar.tsx`** (client) — appears above `ThreadList` when `selectedThreadIds.size > 0`. Shows count + Archive / Trash / Labels buttons. Uses a small Zustand store for selection state shared with thread rows.
- **`labels-popover.tsx`** (client) — `Popover` content showing checkboxes for each label in `availableLabels`, hooked to `setThreadLabels`.
- **`thread-list-row.tsx`** (edit) — adds a checkbox at the left edge, hover-visible Archive / Trash icon buttons at the right edge, optional `focused` visual state for keyboard nav.
- **`thread-list.tsx`** (edit) — registers the keyboard-shortcut hook, manages `focusedIndex`, scrolls the focused row into view.

### Thread-view additions
- **`app/inbox/[threadId]/_components/thread-view.tsx`** — append **Archive** and **Trash** buttons to the existing header (next to Reply / Reply all / Forward).

### Library (`lib/`)
- **`lib/inbox/selection-store.ts`** — Zustand slice for `selectedThreadIds: Set<string>` + setters. Client-only.
- **`lib/inbox/keyboard.ts`** — `useInboxKeyboard({ rows, onArchive, onTrash, ... })` React hook. Captures `keydown` on `document`; ignores events when the target is an `<input>`, `<textarea>`, or contenteditable (so composer/search aren't broken).
- **`lib/db/inbox-mutations.ts`** — server-side optimistic-DB mutations (matches DB to what provider does):
  - `archiveLocally(threadIds, userId)` — removes the `"INBOX"` label from the JSON `labels` column on each `Thread` row.
  - `trashLocally(threadIds, userId)` — same pattern with `"TRASH"` added.
  - `applyLabelsLocally(threadIds, userId, add, remove)` — generic.
  - Used inside the Server Actions BEFORE the provider call (optimistic) and reverted on throw.

## Risks / open questions

1. **Local-vs-provider drift on archive/trash failure.** *Mitigation:* the server action runs `applyLocally → call provider`. On provider throw, it reverts the local state and returns `{ ok: false }`. The UI is also optimistic on the client side, so the user sees revert if the round-trip fails. Final consistency is reconciled by the next Inngest sync (every 60s) which fetches the authoritative label set.

2. **`labels` JSON column edits are non-atomic across concurrent calls.** *Mitigation:* small surface in dev (single user, single device); we accept last-write-wins. A `deploy-vercel` follow-up could promote `labels` to a separate join table if real concurrency demands it.

3. **Search relevance is provider-dependent.** Gmail's search is fuzzy and language-aware; Graph and IMAP search differ. *Decision (not open):* document that result ordering and ranking is whatever the provider returns — we don't post-process.

4. **Inbox view needs to filter out archived/trashed threads.** Today `listThreadsForUser` returns ALL threads with no filter. We add a filter: only threads whose `labels` JSON contains `"INBOX"`. Trash is excluded the same way (a `TRASH` label means it's in trash). *Edge:* threads in neither inbox nor trash (e.g. archive-only) won't show — correct behavior.

5. **Bulk operations across multiple accounts.** If a user selects threads from Gmail-account-A AND Gmail-account-B, the action needs to fan out per-account. *Decision:* the server action groups `threadIds` by `accountId`, dispatches one provider call per group. Errors on one account don't roll back the others — partial success is allowed and `updatedCount` reflects what actually happened.

6. **Keyboard shortcuts and the composer.** The composer is a different route (`/inbox/compose/new`, etc.) so its mount unmounts the inbox's keyboard hook. No conflict.

7. **Labels popover loading.** `listAvailableLabels` is a server action that returns a deduped list of labels across the user's mailboxes. We call it lazily when the popover opens, not on every page load.

8. **Search route doesn't have a real-time push.** The inbox subscribes to SSE for new mail; the search route does not. New mail arriving during a search session won't be reflected. *Acceptable:* searches are point-in-time queries.

## Definition of done
- [ ] `/inbox/search?q=...` renders provider-agnostic results via `IEmailProvider.search`.
- [ ] Search input in the layout header navigates on Enter; pre-fills from `q` when on the search route.
- [ ] Thread row hover shows Archive + Trash icon buttons; checkboxes appear on hover (always visible when selected); clicking a checkbox toggles selection.
- [ ] Bulk-action toolbar appears when selection is non-empty; Archive / Trash / Labels buttons fan out per-account.
- [ ] Labels popover lists existing labels (fetched lazily) and applies `setThreadLabels` on confirm.
- [ ] Thread view header has Archive + Trash buttons in addition to the existing Reply / Reply all / Forward.
- [ ] Keyboard shortcuts (`j/k/Enter/x/e/#/`/`/`Esc`) wired in `useInboxKeyboard`; respect input/contenteditable focus.
- [ ] `listThreadsForUser` filters to only threads with the `INBOX` label.
- [ ] Optimistic local mutations + revert on provider throw.
- [ ] All unit tests in `sub-specs/tests.md` pass; existing tests still green.
- [ ] No provider SDK import in `app/inbox/**`. No `if (provider === ...)` branch.
- [ ] `security-reviewer` PASS: ownership scoping on every thread mutation, Zod input validation, no token leakage on errors.
- [ ] `.claude/CURRENT_SPEC` advanced to the next spec (`graph-provider`).
