# Tests — Search, Labels, Archive, Delete

## Unit (Vitest)

### `lib/db/inbox-mutations.test.ts` (new)
- **`archiveLocally` happy path**: thread with `["INBOX", "STARRED"]` → after call, labels are `["STARRED"]`.
- **`archiveLocally` is idempotent**: calling twice leaves labels unchanged the second time.
- **`archiveLocally` ownership scoping**: passing another user's thread ID has no effect (no row touched, no error).
- **`trashLocally` happy path**: thread with `["INBOX"]` → after call, labels include `"TRASH"` and NOT `"INBOX"`.
- **`trashLocally` from already-trashed**: labels stay `["TRASH"]` (no duplicate).
- **`applyLabelsLocally` add only**: thread with `["INBOX"]`, add `["Work"]` → result includes both.
- **`applyLabelsLocally` remove only**: thread with `["INBOX", "Work"]`, remove `["Work"]` → result is `["INBOX"]`.
- **`applyLabelsLocally` add + remove combined**: works as set union/difference.
- **`applyLabelsLocally` no-op**: empty add + remove → labels unchanged.

### `app/inbox/actions.test.ts` (extend the existing file)

For each new Server Action, follow the same `vi.mock("@/lib/auth")` + `vi.mock("@/lib/providers")` pattern as the compose tests.

**`searchThreads`:**
- Unauthorized when no session.
- Invalid input (empty query) → `{ ok: false, error: "Invalid input" }`.
- Single account: calls `provider.search(query, { limit })`, returns merged + sorted result.
- Multi-account: queries each account's provider, merges, sorts by `lastMessageAt desc`.
- Provider throws on one account in multi-account flow → still returns the successful account's results (partial success).

**`archiveThreads`:**
- Unauthorized.
- Empty `threadIds` → Zod rejects (min 1).
- Happy path single account: `provider.archive(messageIds)` called, `Thread.labels` no longer contains `"INBOX"`.
- Multi-account: groups by `accountId`, fans out one provider call per group.
- Ownership: passing a thread the user doesn't own returns `{ ok: false, error: "Forbidden: thread not owned" }`, no DB write.
- Provider throws: local labels revert to pre-action snapshot (re-query and assert).
- Partial failure (multi-account): account A succeeds, account B's provider throws → account A's threads stay archived, account B's revert, `updatedCount` reflects A's count only.

**`trashThreads`:** mirror archive, but assert `"TRASH"` is added and `"INBOX"` removed.

**`setThreadLabels`:**
- Unauthorized + Invalid + Ownership: same patterns.
- Happy path: `provider.setLabels(messageIds, add, remove)` called, local Thread.labels reflects the diff.
- Add only / remove only / both.
- Multi-account fanout.
- Provider revert on throw.

**`listAvailableLabels`:**
- Unauthorized.
- Returns deduped + sorted union of labels across user's threads.
- Filters by `accountId` when supplied.

### `lib/inbox/selection-store.test.ts` (new)
- `toggle` adds when absent, removes when present.
- `clear` empties the set.
- `selectMany` replaces existing selection.
- `has` returns correct boolean.
- `asArray` returns ordered array (insertion order).

### `lib/inbox/keyboard.test.ts` (optional — covered well by e2e if we had auth bypass; skip for now)

### `lib/db/inbox-queries.test.ts` (extend)
- Existing tests still pass.
- **New test**: `listThreadsForUser` excludes threads without `"INBOX"` in their labels.
- **New test**: threads with `"INBOX"` AND `"TRASH"` are excluded (treat as trashed).

## E2E (Playwright)

`tests/e2e/inbox-actions.spec.ts` — scaffolded with `test.fixme` per the no-auth-bypass convention.

- `test.fixme("search bar at top of /inbox navigates to /inbox/search?q=...")`
- `test.fixme("clicking Archive on a row removes it from the list optimistically")`
- `test.fixme("clicking Trash on a row removes it from the list optimistically")`
- `test.fixme("provider failure on archive reverts the row")`
- `test.fixme("bulk select via checkboxes shows the action toolbar")`
- `test.fixme("bulk archive removes all selected rows")`
- `test.fixme("Labels popover lists existing labels and applies on confirm")`
- `test.fixme("keyboard: j/k moves focused row; e archives focused or selected; # trashes; / focuses search; Esc clears")`
- `test.fixme("thread view header has Archive + Trash buttons that go back to /inbox")`

## Mocking strategy
- MSW: not needed (no new HTTP calls outside provider methods which are already mocked via `getProviderForAccount`).
- Prisma: real test SQLite DB via existing `tests/setup/global.ts`.
- Auth + provider: `vi.mock` the same way the compose tests do.
- Selection store: tested in isolation by importing the hook + calling its methods directly (no React render needed since Zustand is framework-agnostic).
