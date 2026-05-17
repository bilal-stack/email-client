# Tests — Graph Provider

`test-author` agent writes these alongside the build. `npm test:run` must be green before the spec is marked done. **No E2E in this spec** — the inbox / thread / composer / search / labels surfaces are already covered by the Playwright suite from `unified-inbox-ui` and `search-labels-archive-delete`; running them against a Graph-backed account is a manual smoke step in the build hand-off, not an automated test deliverable here. (Reason: the Playwright setup is wired against the SQLite test DB + a stubbed provider; making it cleanly pick "graph" vs "gmail" per scenario doubles the harness without adding signal — the same UI code paths are already proven.)

## Fixture strategy

- All Graph HTTP calls are mocked via **MSW** with handlers anchored on `https://graph.microsoft.com/v1.0/*`. The Microsoft token endpoint (`https://login.microsoftonline.com/.../oauth2/v2.0/token`) is mocked separately.
- Fixtures live in `tests/fixtures/graph/`:
  - `messages.list.basic.json` — five messages from two conversations (one with a single message, one with three), one with `hasAttachments: true`. Includes `@odata.nextLink`.
  - `messages.list.paginated.page2.json` — final page, no `nextLink`.
  - `messages.threadById.json` — `$filter=conversationId eq '…'` result with three messages and `internetMessageHeaders`.
  - `sendMail.ok.json` — empty 202 response.
  - `createReply.json` — minimal draft envelope returned by `/createReply` (includes the draft `id`).
  - `patchMessage.ok.json` — empty 200 response.
  - `move.toArchive.json` / `move.toDeletedItems.json` — relocated message envelopes (we discard the body but the handler needs a 200).
  - `batch.markRead.json` — `$batch` envelope showing 3 PATCH sub-requests, all 200.
  - `messages.delta.coldStart.{page1,page2}.json` — empty-payload pages culminating in `@odata.deltaLink`.
  - `messages.delta.incremental.page1.json` — two new messages (one with `hasAttachments: true`), one removed entry, ends with `@odata.deltaLink`.
  - `messages.delta.expired.json` — `410 Gone` with a Graph error envelope mentioning `deltaToken`.
  - `attachments.list.json` — two `fileAttachment` items with `id`, `name`, `contentType`, `size`.
  - `mailFolders.inbox.json` / `mailFolders.archive.json` / etc. — well-known-folder lookup responses used by the in-process folder-id cache.
  - `search.results.json` — three messages from two conversations matching a query string.
  - `errors.401.json`, `errors.429.json`, `errors.500.json`, `errors.410.deltaLink.json` — synthetic error envelopes for the error-mapping spot checks.
  - `oauth.refresh.ok.json` — MS token endpoint response with a NEW `refresh_token`, used by the rotation test.
- **Capture is manual.** Same convention as gmail-provider: a developer runs the adapter against a real test mailbox once to capture, scrubs PII, commits. `test-author` writes test cases against fixtures that exist; for fixtures that don't yet exist, lays down a hand-written stub with `// TODO: replace with real capture`.

## Unit tests (Vitest)

### `lib/providers/error-mapping.test.ts` (additions)
The existing file covers Gmail mappings end-to-end. Add to it:
- **410 with `@odata.deltaLink` message** (`errors.410.deltaLink.json`) → `AuthError` whose message contains "Sync delta expired — reconnect required".
- **410 with a non-delta message** → `NotFoundError`.
- **Graph-shaped error envelope** (`{ error: { code: "ErrorAccessDenied", message: "Access is denied." } }`) on a 403 with `insufficientPermissions`-equivalent text → `AuthError` (asserts `pickMessage` handles Graph's envelope identically to Gmail's).
- 401 / 429 / 500 with Graph-shaped envelopes still map the same as for Gmail (regression spot check; one assertion each).

### `lib/providers/auth.test.ts` (additions)
- **Microsoft refresh rotates the refresh token**: seed a `MailAccount` row with `provider: "graph"` and `expiresAt` in the past; MSW returns `oauth.refresh.ok.json` with a NEW `refresh_token`; after the call, decrypt the row's new `encryptedSecret` and assert `secret.refreshToken === <new token>` (NOT the stored one).
- **Google refresh preserves the existing refresh token** (regression): unchanged behavior for `provider: "gmail"` whose refresh response omits `refresh_token`.
- **Microsoft `invalid_grant` from refresh endpoint** → throws `AuthError`; the row is **not** mutated.
- **Unsupported provider for refresh** (e.g. `"imap"` with an expired token) → throws a clear `Error`; no DB writes.
- **Round-trip integrity** for the Graph path: decrypt the post-refresh ciphertext and confirm the full plaintext matches the returned `MailboxSecret`, including the rotated `refreshToken`.

### `lib/providers/graph.test.ts` — adapter methods
Each test sets up MSW handlers for the relevant Graph endpoint(s) using fixtures from `tests/fixtures/graph/`.

- `listThreads({ limit: 50 })`:
  - Returns normalized `CanonicalThread[]` with correct `subject`, `participants`, `unreadCount`, `lastMessageAt`.
  - Maps `$skiptoken` from `@odata.nextLink` to `nextCursor`.
  - Passing `cursor` flows back into the outgoing request's `$skiptoken`.
  - Conversation grouping: the multi-message conversation collapses into a single `CanonicalThread` whose `messageIds` lists every message in receivedDateTime order.
- `getThread(id)`:
  - Outgoing request has `$filter=conversationId eq '{id}'`.
  - Normalizes all three fixture messages.
  - `bodyHtml` populated from `body.contentType="html"`; `bodyText` null in this fixture.
  - `inReplyTo` and `references` extracted from `internetMessageHeaders`.
  - `isUnread` reflects `!isRead`.
- `sendMessage(draft)`:
  - Outgoing `POST /me/sendMail` body matches the `buildGraphMessage` shape (snapshot the recipient lists + attachment base64).
  - Follow-up `GET /me/mailFolders/sentitems/messages?$top=1` is observed.
  - Return value `{ id, threadId }` comes from the follow-up fetch.
- `reply(threadId, draft)`:
  - Three calls observed in order: `createReply`, `PATCH /me/messages/{draftId}`, `POST /me/messages/{draftId}/send`.
  - On a forced 500 from step 2, a best-effort `DELETE /me/messages/{draftId}` is observed; the function throws `TransientError` (via `mapError`).
- `archive([id1, id2])`:
  - Two `POST /me/messages/{id}/move` calls observed, body `{ destinationId: "archive" }`.
- `trash([id1, id2])`:
  - Two `POST /me/messages/{id}/move` calls, body `{ destinationId: "deleteditems" }`.
- `markRead([a, b, c], true)`:
  - Single `POST /$batch` observed with three PATCH sub-requests, each body `{ isRead: true }`.
  - With 25 ids: TWO `$batch` calls (20 + 5).
- `setLabels([id], ["Work"], ["INBOX"])`:
  - Pre-read `GET /me/messages/{id}?$select=categories,parentFolderId,isRead` observed.
  - Subsequent `PATCH /me/messages/{id}` payload sets `categories: [...existing, "Work"]`.
  - Subsequent `POST /me/messages/{id}/move` to `archive` observed (because `remove ["INBOX"]` triggers an archive move).
- `setLabels([id], ["UNREAD"], [])` and `setLabels([id], [], ["UNREAD"])`:
  - `PATCH` body sets `isRead: false` / `isRead: true` respectively; `categories` unchanged.
- `search("project alpha")`:
  - Outgoing request includes `$search="project alpha"` and `ConsistencyLevel: eventual` header.
  - Query containing `"` is escaped (`escapeSearchTerm` test).
  - Conversation grouping mirrors `listThreads`.
- **Error mapping wiring**: a forced MSW 401 on `messages` causes `listThreads` to throw `AuthError`. Spot-check.
- **Folder-id cache**: across two `archive` calls in the same `GraphProvider` instance, the well-known-folder lookup for `archive` is observed exactly once (cached on the instance).

### `lib/providers/graph.syncDelta.test.ts`
- **Null cursor (cold start)**: drains `messages.delta.coldStart.{page1,page2}.json` (each page empty `value: []`) and returns `{ newMessages: [], changedMessages: [], deletedIds: [], nextCursor: "<deltaLink-from-page2>" }`. No attachment fetches.
- **Incremental delta with new + removed entries**: from `messages.delta.incremental.page1.json` returns `newMessages` with the two non-removed envelopes (normalized) and `deletedIds` with the one removed id. `changedMessages` is empty.
- **Attachment fanout**: of two new messages, one has `hasAttachments: true`. MSW observes exactly one `/me/messages/{id}/attachments` call; the resulting `CanonicalMessage.attachments` has the two items from `attachments.list.json`.
- **Synthetic-label assembly on an unread inbox message**: returned `labels` contains both `"INBOX"` and `"UNREAD"` (assert dedupe — neither appears twice even if `categories` contained them).
- **Synthetic-label assembly on a read sentitems message**: returned `labels` contains `"SENT"` and does NOT contain `"UNREAD"`.
- **Expired delta link**: MSW returns 410 from `errors.410.deltaLink.json` → `syncDelta` throws `AuthError` whose message contains "Sync delta expired — reconnect required".
- **Concurrency cap on attachment fanout**: with 25 attachment-bearing messages, MSW observes max 10 in-flight `/attachments` requests at any moment.

### `lib/providers/index.test.ts` (additions)
- `buildProvider("graph", id)` returns a `GraphProvider` (not `NotImplementedProvider`).
- `buildProvider("imap", id)` still returns `NotImplementedProvider` (regression).

### `lib/inngest/functions/_write-delta.test.ts` (new — exercises the shared helper extracted from gmail-sync)
- Given a fixture `DeltaResult` containing two new messages on a single new thread, one update to an existing message (label change), and one deleted id:
  - Upserts a `Thread` row whose `providerThreadId` matches the input.
  - `createMany` writes the two `Message` rows (with the existing-filter dedup path covered by a separate fixture that pre-seeds one of the two ids — assert only the new id is inserted).
  - Inserts `Attachment` rows for the attachment-bearing message; `fetchedAt` is null.
  - `updateMany` toggles `isUnread` for the changed message.
  - `deleteMany` removes the deleted id.
  - Updates `MailAccount.syncCursor` and `lastSyncedAt` on the account row.
  - Returns `{ threadIds: [<dbId>] }` for the caller's SSE-emit gate.
- **Idempotency**: running the same delta twice produces the same DB state. No duplicate messages, no double attachments.
- (These tests cover BOTH the gmail-sync and graph-sync writers, since the helper is shared. The existing `lib/inngest/functions/gmail-sync.test.ts` should be trimmed of writer-mechanics tests that now live here, leaving only the gmail-specific orchestration coverage.)

### `lib/inngest/functions/graph-sync.test.ts`
Trimmed compared to gmail-sync.test.ts now that writer mechanics live in `_write-delta.test.ts`.
- Given a `MailAccount` with `provider: "graph"` and `syncCursor: "https://graph.microsoft.com/.../delta?$deltatoken=abc"`, and a mocked `GraphProvider.syncDelta` returning a non-empty delta:
  - `writeDelta` is invoked once with the right arguments.
  - `emitInboxSyncEvent` is called for the account's `userId` with the `threadIds` returned by `writeDelta`.
- Given a `MailAccount` whose `syncDelta` throws `AuthError` (stale delta link):
  - The error propagates to Inngest (the function does not swallow it).
  - `syncCursor` is **not** advanced (transaction never starts).
  - `lastSyncedAt` is **not** updated.
  - No SSE is emitted.
- A `MailAccount` with `provider: "gmail"` is NOT touched by this function (filter scope).

## Mocking strategy

- **MSW** handles all `https://graph.microsoft.com/*` and `https://login.microsoftonline.com/*` requests. No real network in any test.
- **Prisma** runs against the fresh `file:./test.db` (the foundation pattern) with the existing migrations applied — **no new migrations**, per `database-schema.md`.
- **Inngest** functions are invoked directly as plain async functions in tests (existing pattern).
- No tokens (real or fake) appear in test output. Snapshots redact `access_token` / `refresh_token` strings; both Microsoft and Google token bodies are redacted by the same redactor.
- The `@microsoft/microsoft-graph-client` library is **not** mocked — MSW intercepts its `fetch` calls (the SDK uses `fetch` under the hood per its v3 release). If the build agent finds the SDK swallowing MSW interception (unlikely), fall back to mocking the client at the module boundary.

## E2E (Playwright)

**N/A in this spec.** Manual smoke is the path: a developer runs `npm dev` + `npm inngest:dev`, signs in via the existing Microsoft Entra ID button, sends themselves a test message, and verifies it appears in the unified inbox within 60 seconds. The hand-off checklist in `tasks.md#8` calls this out explicitly.
