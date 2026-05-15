# Tests — Unified Inbox UI

`test-author` agent writes these alongside the build. `npm test:run` and `npm test:e2e` must be green before the spec is marked done.

## Fixture strategy

- **Phishing HTML fixture** at `tests/fixtures/email-html/phish.html` containing:
  - `<script>alert(1)</script>`
  - `<img src="x" onerror="alert(1)">`
  - `<img src="https://emltrk.example/p?id=abc" width="1" height="1">` (tracker pixel)
  - `<a href="https://evil.example">paypal.com</a>` (deceptive link — passes through; the click-warning is out of scope for this spec)
  - A benign `<p>Hello</p>` for assertion that real content survives.
- **DB fixture**: a seeded `test.db` containing one `User`, two `MailAccount` rows (both `provider: "gmail"`), and four `Thread`s (mix of read/unread) with two messages each. Seed script in `tests/seed/inbox.ts`, invoked via `vitest`'s `globalSetup` or Playwright's `globalSetup`.
- **Provider mocks**: `GmailProvider.markRead` is mocked via the provider registry (a per-test `vi.spyOn(providerRegistry, "getProviderForAccount").mockResolvedValue({ markRead: vi.fn().mockResolvedValue(undefined), ...stubOthers })`). No MSW needed for the inbox unit tests — the only Gmail call this spec makes is `markRead`, and we exercise the wiring, not the adapter (already covered in gmail-provider tests).
- **SSE**: tests drive the bus directly (`emitInboxSyncEvent(userId, payload)`); Playwright e2e drives the bus from a test-only Route Handler injected via MSW in the dev runtime (alternative: import the emitter in the test harness, which Playwright supports via `global-setup.ts` running in Node).

## Unit tests (Vitest)

### `lib/email-html/sanitize.test.ts`
- Loads `tests/fixtures/email-html/phish.html`, runs `sanitizeEmailHtml`, asserts:
  - Output contains `<p>Hello</p>`.
  - Output does NOT contain `<script`.
  - Output does NOT contain `onerror`.
  - Output does NOT contain `emltrk.example` (tracker img removed).
  - Output does NOT contain `width="1"` (tracker pixel stripped).
- Edge cases:
  - Empty string in → empty string out.
  - HTML with only safe tags is preserved structurally (snapshot test on a small sample).
  - `<style>` block is removed.
  - `<iframe>` / `<object>` / `<embed>` are removed.
  - `javascript:` URLs in `<a href>` are stripped by DOMPurify (assert via a fixture with `<a href="javascript:alert(1)">x</a>`).

### `lib/realtime/inbox-events.test.ts`
- **Subscribe → emit → receive**: subscriber for `userA` receives a `SyncEvent` emitted on `userA`; payload arrives intact.
- **Channel isolation**: subscriber for `userA` receives nothing when an event is emitted for `userB`.
- **Unsubscribe**: after the returned `unsubscribe()` is called, no further events are delivered.
- **Multiple subscribers**: two subscribers on the same user both receive the event.
- **HMR singleton**: importing the module twice (via dynamic `import()` with cache busting) yields the same emitter (assert by reference) — protects against the `globalThis` cache regressing.

### `app/inbox/actions.test.ts` — Server Actions
Each test uses a fresh seeded test DB plus a session stub (`vi.spyOn(auth-module, "auth").mockResolvedValue({ user: { id: "u1" } })`).

- **`listThreads` happy path**: returns threads belonging to `u1`'s accounts, ordered by `lastMessageAt DESC`, with computed `unreadCount`.
- **`listThreads` with `accountId` filter**: returns only that account's threads.
- **`listThreads` rejects another user's account id**: when `u1` passes an `accountId` they don't own, returns `{ ok: true, data: { threads: [], nextCursor: null } }` (the inner `MailAccount.findMany` enforces ownership; no rows match, so empty list, no error). Assert no leak.
- **`listThreads` unauthorized**: with no session → `{ ok: false, error: "Unauthorized" }`.
- **`listThreads` invalid input** (`limit = -1`, `accountId = "not-a-cuid"`) → `{ ok: false, error: "Invalid input" }`.
- **`getThread` happy path**: returns thread + sanitized message bodies; `bodyHtml` no longer contains `<script>` from the phishing fixture (i.e., assert sanitizer wiring).
- **`getThread` for another user's thread** → `{ ok: false, error: "Not found" }`.
- **`getThread` unauthorized** → `{ ok: false, error: "Unauthorized" }`.
- **`markThreadRead` happy path**:
  - Seed thread with 2 unread messages.
  - Mock `getProviderForAccount` to return `{ markRead: vi.fn().mockResolvedValue(undefined), ... }`.
  - Call action.
  - Assert `markRead` was called once with `(["pm1", "pm2"], true)`.
  - Assert DB rows now have `isUnread = false` for those messages.
  - Returned `data.updatedCount === 2`.
- **`markThreadRead` no-unread**: thread already fully read → action returns `{ updatedCount: 0 }` and `markRead` is never called.
- **`markThreadRead` provider AuthError**: mock `markRead` to `throw new AuthError(...)`. Action returns `{ ok: false, error: <message> }`; DB rows are NOT updated.
- **`markThreadRead` for another user's thread** → action returns `{ ok: true, data: { updatedCount: 0 } }` (the `findMany` filters by `account.userId`; nothing to update). Assert provider was NOT called.

### `app/api/inbox/events/route.test.ts` — SSE Route Handler
- **Unauthorized**: no session → `Response` with status 401, no body stream.
- **Authorized + emit**: open the route with a session for `userA`, emit a `SyncEvent` via `emitInboxSyncEvent`, assert the first non-heartbeat chunk on the stream decodes to `data: <json>\n\n` with the expected payload.
- **Abort cleanup**: abort the request `signal`, then emit another event — assert the stream was closed and the listener was removed (count `bus.listenerCount("inbox:userA")` before/after).
- **Heartbeat** (timer-faked): advance fake timers by 26 s, assert one `: ping\n\n` chunk emitted.

### `lib/db/inbox-queries.test.ts`
- `listThreadsForUser` ordering, account filter, cursor pagination, empty result.
- `getThreadByIdForUser` ownership scoping.

## E2E tests (Playwright) — `tests/e2e/unified-inbox.spec.ts`

All scenarios run against the seeded `test.db`. Auth is faked via a test-only Auth.js Credentials provider that's gated behind `NODE_ENV === "test"` (already established in foundation tests; reuse).

### Scenario: inbox list
1. Sign in as `u1`.
2. Navigate to `/inbox`.
3. Assert the four seeded threads are visible, ordered by `lastMessageAt` desc.
4. Assert unread threads display an unread dot/badge.
5. Assert the account-switcher shows three chips: "All inboxes", account A's email, account B's email.

### Scenario: account filter
1. From `/inbox`, click account A's chip.
2. Assert URL becomes `/inbox?account=<accountAId>`.
3. Assert only account A's threads are listed.
4. Click "All inboxes" → URL back to `/inbox`, full list returns.

### Scenario: open thread + auto-mark-read
1. Click an unread thread.
2. Assert URL is `/inbox/<threadId>`.
3. Assert message bodies render: at least one `iframe[sandbox]` element present, plain-text `<pre>` for text-only messages.
4. Wait briefly (or use a `data-testid` on the trigger) for `markThreadRead` to settle.
5. Navigate back to `/inbox`.
6. Assert the unread badge on that thread row is gone.

### Scenario: real-time SSE update
1. On `/inbox`, note the current thread count.
2. From the test harness (a helper hitting a test-only `/api/_test/seed-thread` route, or via Playwright's `request.newContext()` calling a seeder), insert a new `Thread` row for `u1` and `emitInboxSyncEvent` (a test-only Route Handler trip-wire under `NODE_ENV === "test"`).
3. Assert the new thread appears in the list within 2 s **without** a page reload.

### Scenario: thread not found
1. Navigate to `/inbox/<some-cuid-that-doesnt-exist>`.
2. Assert the route's `not-found.tsx` content is shown.

### Scenario: HTML body sanitization (security)
1. Seed a thread whose `Message.bodyHtml` is the contents of `tests/fixtures/email-html/phish.html`.
2. Open the thread.
3. Inside the iframe (Playwright `frameLocator`), assert:
   - `<p>Hello</p>` text is present.
   - No `<script>` element exists.
   - No `<img>` with `width=1, height=1` exists.
4. Assert the iframe has `sandbox` attribute and that attribute does NOT include `allow-scripts`.

### Scenario: mobile viewport
1. Playwright project: `iPhone 13` (375 × 812).
2. Sign in, navigate to `/inbox`.
3. Assert the list is full-width; no thread pane visible.
4. Click a thread — assert the URL changes and the thread view fills the screen; assert a back chevron is present.
5. Click the back chevron → return to `/inbox`.

### Scenario: empty state
1. Sign in as a user with zero `MailAccount` rows.
2. Assert `/inbox` shows the "no mailboxes connected" empty state (already present in the placeholder UI; spec preserves it).

## Mocking strategy

- **Auth.js**: test-only Credentials provider; reuse from foundation. No real OAuth in tests.
- **Provider registry**: `vi.spyOn(providerRegistry, "getProviderForAccount")` returns a stub adapter exposing the methods this spec exercises (`markRead`). Other methods throw `NotImplementedError` — they're not called.
- **Inngest**: not invoked in this spec's tests. The realtime bus is exercised directly without running an Inngest function.
- **SSE in Playwright**: a tiny test-only seeder route inserts DB rows and emits a `SyncEvent`. The route is gated by `if (process.env.NODE_ENV !== "test") return new Response(null, { status: 404 })`.
- **Anthropic SDK**: not called in this spec.
- **MSW**: not needed (no provider HTTP calls in the inbox UI path).
