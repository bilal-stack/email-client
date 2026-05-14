# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation.

## 1. Prisma schema additions — `provider-adapter`
- Add `Thread`, `Message`, `Attachment` models per `sub-specs/database-schema.md`.
- Indexes: `(accountId, receivedAt DESC)`, `(threadId, receivedAt ASC)`.
- Unique: `(accountId, providerMessageId)` for idempotent sync.
- Run `npm db:migrate` to generate the migration. Commit both schema and migration.

## 2. Error mapping (`lib/providers/error-mapping.ts`) — `provider-adapter`
- Export `mapError(e: unknown): ProviderError`.
- Detect `gaxios` / `googleapis` errors via `e.code` / `e.response?.status`.
- Map 401 → `AuthError`, 404 → `NotFoundError`, 429 → `RateLimitError` (parse `Retry-After`), 5xx + network → `TransientError`, OAuth `invalid_grant` → `AuthError`, History API "historyId not found" 404 → `AuthError` with "Sync history expired — reconnect required" message (UI prompts a reconnect; reconnect runs the cold-start `getProfile().historyId` path).
- Anything else → `UnknownProviderError`, preserve original via `{ cause: e }`.

## 3. Token-refresh helper (`lib/providers/auth.ts`) — `provider-adapter`
- Export `MailboxSecret` type (accessToken, refreshToken, expiresAt, scope).
- Export `getMailboxSecret(accountId: string): Promise<MailboxSecret>`.
  - Read `MailAccount` row.
  - Decrypt `encryptedSecret` / `secretIv` / `secretTag` via `lib/auth/crypto.ts`. JSON-parse the plaintext.
  - If `expiresAt` is within 60s of now or past, call Google's OAuth refresh endpoint (`https://oauth2.googleapis.com/token`) with the stored `refreshToken`.
  - On success, re-encrypt the new secret, update the `MailAccount` row, return the fresh secret.
  - On `invalid_grant` from the refresh endpoint, throw `AuthError` (the row is *not* deleted).
- Do **not** coalesce concurrent refreshes in-process. Google's refresh endpoint is idempotent; two concurrent refreshes is benign. (Premature optimization for an MVP single-user workflow.)

## 4. Gmail adapter (`lib/providers/gmail.ts`) — `provider-adapter`
- Implement `GmailProvider implements IEmailProvider`. Constructor: `(accountId: string)`.
- Every method wraps its work in `try { ... } catch (e) { throw mapError(e); }`.
- Every method calls `getMailboxSecret(this.accountId)` to obtain an access token, then builds a `google.gmail({ version: "v1", auth: oauth2Client })` instance.
- Implementations:
  - `listThreads(opts)` → `users.threads.list` with `pageToken=opts.cursor`, `maxResults=opts.limit ?? 50`, optional `labelIds`. Normalize results.
  - `getThread(id)` → `users.threads.get` with `format: "full"`. Normalize all messages.
  - `sendMessage(draft)` → build RFC 2822, base64url-encode, `users.messages.send`.
  - `reply(threadId, draft)` → same as `sendMessage` but include `threadId` and set `In-Reply-To` / `References` headers from `draft`.
  - `archive(ids)` → `users.messages.batchModify` with `removeLabelIds: ["INBOX"]`.
  - `trash(ids)` → loop `users.messages.trash` (no batch endpoint for this op); bounded `Promise.all` concurrency 10.
  - `markRead(ids, read)` → `users.messages.batchModify` toggling `UNREAD` label.
  - `setLabels(ids, add, remove)` → `users.messages.batchModify` with `addLabelIds` / `removeLabelIds`.
  - `search(query, opts)` → `users.threads.list` with `q=query`.
  - `syncDelta(cursor)` → see task 5.
- Normalization helpers live next to the class (not exported):
  - `parseHeaders(payload)` → addresses, subject, In-Reply-To, References.
  - `extractBodies(payload)` → `{ bodyHtml, bodyText }`, walking `multipart/*` parts.
  - `extractAttachments(payload)` → metadata only.
- Provider message IDs and thread IDs are passed through verbatim as `CanonicalMessage.id` / `CanonicalThread.id`.

## 5. Delta sync — `provider-adapter`
- In `lib/providers/gmail.ts`:
  - `syncDelta(cursor: string | null): Promise<DeltaResult>`:
    - If `cursor` is null, return an empty `DeltaResult` with `nextCursor = "<currentHistoryId>"` fetched from `users.getProfile`. (Full-mailbox seed is deferred — out of scope per `spec.md` non-goals.)
    - Otherwise call `users.history.list({ startHistoryId: cursor, historyTypes: ["messageAdded","messageDeleted","labelAdded","labelRemoved"] })`, paginating until `nextPageToken` is empty.
    - Collapse all `messageAdded` events into a set of new message IDs, batch-fetch them via bounded `messages.get` (concurrency 10), normalize, accumulate as `newMessages`.
    - `messageDeleted` → `deletedIds`.
    - `labelAdded` / `labelRemoved` → fold into `changedMessages` keyed by message id.
    - `nextCursor` = the largest `historyId` seen (or the response's terminal `historyId`).

## 6. Provider registry (`lib/providers/index.ts`) — `provider-adapter`
- Export `getProviderForAccount(accountId: string): Promise<IEmailProvider>`.
- Read `MailAccount.provider`; branch on `"gmail"` → `new GmailProvider(accountId)`; `"graph"` / `"imap"` → `NotImplementedProvider`.

## 7. Inngest sync function — `provider-adapter`
- `lib/inngest/functions/gmail-sync.ts`:
  - `inngest.createFunction({ id: "gmail-sync-delta" }, { cron: "* * * * *" }, async ({ step }) => { ... })`.
  - `step.run("list-accounts", ...)` → all `MailAccount` rows where `provider = "gmail"`.
  - For each account: `step.run("sync-{accountId}", ...)` → instantiate `GmailProvider`, call `syncDelta(account.syncCursor)`, then a Prisma transaction:
    - Upsert `Thread` rows.
    - `createMany` `Message` rows with `skipDuplicates: true` (the `(accountId, providerMessageId)` unique constraint guarantees idempotency).
    - Insert `Attachment` rows with `fetchedAt = null`.
    - Apply `changedMessages` (label / unread updates) with `updateMany`.
    - `deleteMany` for `deletedIds`.
    - Update `MailAccount.syncCursor` and `lastSyncedAt`.
- Register the function in `app/api/inngest/route.ts`.

## 8. Tests — `test-author`
- Per `sub-specs/tests.md`. All Gmail HTTP calls mocked via MSW; OAuth refresh endpoint mocked separately.
- Fixtures placed in `tests/fixtures/gmail/`. Fixture *capture* is a manual step done during the build (not authored by `test-author`); the agent writes test cases that consume already-present fixtures, and stubs missing fixtures with minimal hand-written JSON noted with `// TODO: replace with real capture`.

## 9. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas: token-refresh writeback (no plaintext leak), error-message sanitization (no tokens in logs), Prisma query safety.
- On pass: bump `.claude/CURRENT_SPEC` to `.agent-os/specs/2026-05-14-unified-inbox-ui/spec.md` *(spec folder not yet authored — planner produces it next).*
