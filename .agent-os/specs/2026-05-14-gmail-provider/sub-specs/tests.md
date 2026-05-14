# Tests — Gmail Provider

`test-author` agent writes these alongside the build. `npm test:run` must be green before the spec is marked done. **No E2E in this spec** — Playwright coverage for the inbox lands in `unified-inbox-ui`.

## Fixture strategy

- All Gmail HTTP calls are mocked via **MSW**. The OAuth refresh endpoint (`https://oauth2.googleapis.com/token`) is mocked separately.
- Fixtures live in `tests/fixtures/gmail/`:
  - `threads.list.basic.json` — two threads, with `nextPageToken`.
  - `threads.list.paginated.page2.json` — final page, no `nextPageToken`.
  - `threads.get.full.json` — one thread with three messages: plain text only, multipart/alternative, multipart with attachment.
  - `messages.send.ok.json` — minimal success response with `id` and `threadId`.
  - `messages.batchModify.ok.json` — empty 204-style response.
  - `history.list.added.json` — single `messagesAdded` event.
  - `history.list.deleted.json` — single `messagesDeleted` event.
  - `history.list.labels.json` — `labelsAdded` + `labelsRemoved` events with the `UNREAD` label.
  - `history.list.paginated.{page1,page2}.json` — exercises `nextPageToken` traversal.
  - `history.list.expired.json` — 404 with `historyId not found` message.
  - `messages.get.full.json` — single message used by sync to fetch added IDs.
  - `getProfile.json` — used when `cursor == null` to seed `nextCursor`.
  - `errors.401.json`, `errors.429.json`, `errors.404.json`, `errors.500.json` — synthetic error envelopes for the error-mapping tests.
- **Capture is manual.** A developer runs the adapter once against a real test mailbox to record responses (cleaning PII), commits the JSON. `test-author` writes the test cases assuming fixtures exist; for fixtures that don't yet, it lays down a hand-written stub with a `// TODO: replace with real capture` comment.

## Unit tests (Vitest)

### `lib/providers/error-mapping.test.ts`
- 401 → `AuthError`.
- 403 with `insufficientPermissions` message → `AuthError`.
- 404 with normal message → `NotFoundError`.
- 404 with `historyId not found` message → `AuthError` with "Sync history expired — reconnect required" in the message.
- 429 with `Retry-After: 30` → `RateLimitError` whose `retryAfterSeconds === 30`.
- 500 → `TransientError`.
- 503 → `TransientError`.
- Network error (no `status`) → `TransientError`.
- `invalid_grant` body → `AuthError`.
- Unknown status (e.g. 418) → `UnknownProviderError`.
- All mapped errors preserve the original via `.cause`.

### `lib/providers/auth.test.ts` — `getMailboxSecret`
- **Token still valid**: `expiresAt` is 10 minutes in the future → returns the decrypted secret without hitting the refresh endpoint (MSW asserts no call).
- **Token within 60s skew**: `expiresAt` is 30 s away → calls refresh endpoint, persists re-encrypted secret to `MailAccount`, returns the fresh secret with the new `accessToken`.
- **Token expired**: `expiresAt` is in the past → same as above.
- **`invalid_grant` from refresh endpoint** → throws `AuthError`; row is *not* mutated.
- **Round-trip integrity**: after refresh, decrypt the row's new ciphertext and confirm the plaintext matches the returned secret.
- **Crypto isolation**: the plaintext is never present in the row's `encryptedSecret` bytes (assert by buffer scan).

### `lib/providers/gmail.test.ts` — adapter methods
Each test sets up MSW handlers for the relevant Gmail endpoint(s) using fixtures from `tests/fixtures/gmail/`.

- `listThreads({ limit: 50 })`:
  - Returns normalized `CanonicalThread[]` with the correct `subject`, `participants`, `unreadCount`, `lastMessageAt`.
  - Maps `nextPageToken` → `nextCursor`.
  - Passing `cursor` sets `pageToken` on the outgoing call.
  - Passing `label` sets `labelIds`.
- `getThread(id)`:
  - Normalizes a three-message thread, including the attachment-bearing message's `attachments[]`.
  - `bodyHtml` and `bodyText` are populated from the right MIME parts.
  - `inReplyTo` and `references` are extracted from headers.
  - `isUnread` reflects `UNREAD` label presence.
- `sendMessage(draft)`:
  - Builds an RFC 2822 string with the expected headers (snapshot match on the decoded `raw` field).
  - Returns `{ id, threadId }` from the API response.
- `reply(threadId, draft)`:
  - Sets `threadId` on the outgoing call.
  - Includes `In-Reply-To` and `References` headers.
- `archive([id1, id2])`:
  - Single `batchModify` call with `removeLabelIds: ["INBOX"]` and both ids.
- `trash([id1, id2])`:
  - Two `trash` calls observed (bounded concurrency); both ids covered.
- `markRead(ids, true)` and `markRead(ids, false)`:
  - Outgoing `batchModify` has `UNREAD` in the correct list.
- `setLabels(ids, ["LBL_A"], ["LBL_B"])`:
  - Outgoing payload mirrors inputs.
- `search("from:foo has:attachment")`:
  - `q` parameter passes through verbatim.
- **Error mapping wiring**: a forced MSW 401 on `threads.list` causes `listThreads` to throw `AuthError`. (Spot-check; full mapping coverage lives in `error-mapping.test.ts`.)

### `lib/providers/gmail.syncDelta.test.ts`
- **Null cursor** → calls `getProfile`, returns `{ newMessages: [], changedMessages: [], deletedIds: [], nextCursor: "<profile.historyId>" }`.
- **Added events** → fetches each new message id via `messages.get`, returns normalized `newMessages`. `nextCursor` is the largest `historyId` seen.
- **Deleted events** → populates `deletedIds`; no `messages.get` calls for deleted ids.
- **Added then deleted in same window** → id is in `deletedIds`, *not* in `newMessages`.
- **Label add/remove events** → `changedMessages` contains the message with `isUnread` toggled correctly.
- **Paginated history** → both pages consumed; final `nextCursor` is the max across all pages.
- **Expired history** (`history.list.expired.json`) → throws `AuthError` with "Sync history expired — reconnect required" message.
- **Concurrency cap** → with 25 added ids, MSW observes max 10 in-flight `messages.get` requests.

### `lib/providers/index.test.ts`
- `getProviderForAccount(id)` returns a `GmailProvider` for a `provider: "gmail"` row.
- Returns a `NotImplementedProvider` for `"graph"` / `"imap"`.

### `lib/inngest/functions/gmail-sync.test.ts`
- Given a `MailAccount` with `syncCursor = "12345"` and a mocked `GmailProvider.syncDelta` that returns:
  ```
  { newMessages: [m1, m2], changedMessages: [{ id: m3, isUnread: false }], deletedIds: [m4], nextCursor: "67890" }
  ```
  the function:
  - Upserts `Thread` rows referenced by `m1` / `m2`.
  - `createMany` writes `m1` and `m2` with `skipDuplicates: true`.
  - Inserts `Attachment` rows from `m1` / `m2` with `fetchedAt = null`.
  - `updateMany` toggles `m3.isUnread` to `false`.
  - `deleteMany` removes `m4`.
  - Updates `MailAccount.syncCursor = "67890"` and `lastSyncedAt`.
- **Idempotency**: running the same delta twice produces the same DB state (no duplicate messages, no double-decrement of unread counters).
- **Transactional rollback**: a forced Prisma error mid-write leaves `MailAccount.syncCursor` unchanged.

## Mocking strategy

- **MSW** handles all `https://gmail.googleapis.com/*` and `https://oauth2.googleapis.com/token` requests. No real network in any test.
- **Prisma** runs against a fresh `file:./test.db` (the foundation pattern) with the migration applied before the suite.
- **Inngest** functions are invoked directly as plain async functions in tests — the cron + serve harness is not exercised here (covered in foundation's inngest-wiring e2e).
- No tokens (real or fake) appear in test output. Snapshots redact `access_token` / `refresh_token` strings.

## E2E (Playwright)

**N/A in this spec.** Inbox + thread view tests land in `unified-inbox-ui`.
