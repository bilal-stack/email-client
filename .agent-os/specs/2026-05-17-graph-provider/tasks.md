# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation.

## 1. Multi-provider token refresh (`lib/providers/auth.ts`) — `provider-adapter`
- Refactor `getMailboxSecret` so its provider-specific work lives behind a small dispatch:
  - Keep the existing `refreshGoogleToken` helper exactly as-is.
  - Add `refreshMicrosoftToken(refreshToken: string, scope: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: string }>`.
  - Replace the `if (row.provider !== "gmail") throw …` guard with a `switch (row.provider)`:
    - `"gmail"` → call `refreshGoogleToken`. **Preserve** the existing `refreshToken` on the secret (Google rarely rotates).
    - `"graph"` → call `refreshMicrosoftToken`. **Persist the response's new `refresh_token`** on the secret (MS rotates on every refresh).
    - `"imap"` → throw `Error("Unsupported provider for refresh: imap")` (lands in `imap-provider`).
- `refreshMicrosoftToken` POSTs `https://login.microsoftonline.com/${env.AZURE_AD_TENANT_ID}/oauth2/v2.0/token` with `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`, `scope` (re-passes the current scope set so the response includes the new tokens for the same scopes).
- On `invalid_grant`: throw `AuthError("Refresh token revoked")`. Do not delete the row.
- Verify by unit test: a Microsoft refresh whose response includes a NEW `refresh_token` → the re-encrypted `MailAccount.encryptedSecret` decrypts to a `MailboxSecret` whose `refreshToken` is the NEW value. A Google refresh that omits `refresh_token` → the stored `refreshToken` is unchanged.

## 2. Error mapping (`lib/providers/error-mapping.ts`) — `provider-adapter`
- Add a 410 branch:
  - `status === 410` AND `message` matches `/delta.?link|deltaToken|resync required/i` → `AuthError("Sync delta expired — reconnect required: …", { cause })`.
  - `status === 410` without the delta-link signature → `NotFoundError` (an explicit 410 from any other Graph endpoint is rare and most closely resembles a "gone" target).
- Verify the Graph error envelope (`{ error: { code: "ErrorAccessDenied", message: "…" } }`) flows through `pickMessage` unchanged. The existing code already reads `err.response?.data?.error?.message` — add a regression test using a Graph-shaped fixture rather than touching the mapper.

## 3. Graph adapter (`lib/providers/graph.ts`) — `provider-adapter`
- Implement `GraphProvider implements IEmailProvider`. Constructor: `(accountId: string)`.
- Every method wraps its work in `try { … } catch (e) { throw mapError(e); }`.
- Build a Graph client per call from the fresh secret:
  ```ts
  const secret = await getMailboxSecret(this.accountId);
  const client = Client.init({
    authProvider: (done) => done(null, secret.accessToken),
  });
  ```
- Method implementations (full mapping in `sub-specs/technical-spec.md`):
  - `listThreads(opts)` → `/me/mailFolders/inbox/messages` with `$top=opts.limit ?? 50`, `$orderby=receivedDateTime desc`, `$skiptoken=` from `opts.cursor`. Group results by `conversationId`; one `CanonicalThread` per conversation.
  - `getThread(id)` → `/me/messages?$filter=conversationId eq '{id}'&$orderby=receivedDateTime asc&$top=100`. The thread id IS the Graph `conversationId`.
  - `sendMessage(draft)` → `POST /me/sendMail`. Build the JSON message; encode attachments as `fileAttachment` items (base64 of `attachment.content`).
  - `reply(threadId, draft)` → three calls:
    1. `POST /me/messages/{draft.inReplyTo}/createReply` → returns a draft id.
    2. `PATCH /me/messages/{draftId}` with body, toRecipients, cc, bcc (the createReply pre-populates to/from; we overwrite if the caller supplied different recipients).
    3. `POST /me/messages/{draftId}/send`.
    4. On any intermediate failure, attempt `DELETE /me/messages/{draftId}` best-effort; ignore that delete's outcome.
  - `archive(ids)` → `POST /me/messages/{id}/move` per id with `{ destinationId: "archive" }` (well-known folder name). Bounded `Promise.all` concurrency 10.
  - `trash(ids)` → `POST /me/messages/{id}/move` per id with `{ destinationId: "deleteditems" }`. Same concurrency.
  - `markRead(ids, read)` → use `$batch` with one PATCH per id, body `{ isRead: read }`. Cap batch at 20 requests (Graph's `$batch` hard limit).
  - `setLabels(ids, add, remove)` → for each id: `GET /me/messages/{id}?$select=categories,parentFolderId` to read current categories AND folder, compute the union/diff with `add`/`remove` AFTER stripping the synthetic-label tokens (those map to folder/move + isRead — see technical spec for the mapping), then `PATCH /me/messages/{id}` with `{ categories: nextList }` plus any folder-move from a synthetic-label transition. Bounded concurrency 10. (`$batch` is *not* used here because each id requires a sequential read-then-write — splitting that across batch turns hurts more than it helps.)
  - `search(query, opts)` → `/me/messages?$search="${query}"&$top=opts.limit ?? 50`. Group by `conversationId` like `listThreads`. (No paginated cursor — `$search` does not surface `@odata.nextLink` reliably. Single-page only, matching Gmail's spec-deferred pagination here.)
  - `syncDelta(cursor)` → see task 4.
- Normalization helpers (not exported), modeled after the gmail.ts pattern:
  - `parseRecipients(list: Array<{ emailAddress: { name?: string; address: string } }>)` → `CanonicalAddress[]`.
  - `extractInternetHeader(message, name)` — Graph exposes `internetMessageHeaders?: Array<{ name, value }>` only when `$select=internetMessageHeaders` is set; we request it where threading headers matter (sync, getThread).
  - `attachmentsForMessage(messageId, client)` — fans out to `/me/messages/{id}/attachments?$select=id,name,contentType,size` when the message has `hasAttachments: true`. Returns `CanonicalAttachmentMeta[]`.
  - `normalizeMessage` / `normalizeThread` — the synthetic-label assembly lives here (see technical spec mapping table).
- Provider message IDs (`CanonicalMessage.id`) = Graph API id verbatim. Thread IDs (`CanonicalThread.id` and `CanonicalMessage.threadId`) = `conversationId` verbatim.

## 4. Delta sync — `provider-adapter`
- In `lib/providers/graph.ts`:
  - `syncDelta(cursor: string | null): Promise<DeltaResult>`:
    - If `cursor === null`: `GET /me/mailFolders/inbox/messages/delta?$top=1`. Drain `@odata.nextLink` pages **without normalizing** (just walk to find `@odata.deltaLink`). Return `{ newMessages: [], changedMessages: [], deletedIds: [], nextCursor: deltaLink }`. Matches the gmail-provider cold-start contract (no seed).
    - Otherwise call the cursor URL verbatim (`cursor` IS the `@odata.deltaLink` URL). Page through `@odata.nextLink`s until you see an `@odata.deltaLink`.
    - For each `value[]` entry:
      - If `@removed.reason` is present → push `entry.id` onto `deletedIds`.
      - Else, accumulate full message envelopes for normalization.
    - For all non-deleted entries with `hasAttachments: true`, fan out `attachmentsForMessage` calls (concurrency 10).
    - Normalize each to `CanonicalMessage` (with the synthetic-label assembly).
    - `newMessages` = messages whose ids we have *not* seen before (caller can't easily know this server-side; we pass everything as `newMessages` and let the writer's "filter existing by `providerMessageId`" path handle dedup — same pattern as gmail-sync).
    - `changedMessages` = stays empty in this spec. Graph's delta endpoint conflates new and updated as full envelopes; the writer's `createMany` with skip-existing handles "new", and updates (e.g. `isRead` flips) would silently miss. **This is a known gap, called out as risk #8 in the technical spec and deferred:** the synthetic-label change path is good enough for inbox-list correctness (the writer always sees the latest envelope on the next delta), and the lossy update is acceptable for an MVP.
    - `nextCursor` = the response's `@odata.deltaLink`.

## 5. Provider registry — `provider-adapter`
- In `lib/providers/index.ts`, change the `"graph"` branch of `buildProvider` from `new NotImplementedProvider()` to `new GraphProvider(accountId)`. Keep `"imap"` on `NotImplementedProvider` until that spec lands.
- Update `lib/providers/index.test.ts` to assert the Graph branch returns `GraphProvider`.

## 6. Inngest sync function — `provider-adapter`
- `lib/inngest/functions/graph-sync.ts`:
  - `inngest.createFunction({ id: "graph-sync-delta", concurrency: { limit: 1 } }, { cron: "*/1 * * * *" }, async ({ step }) => { ... })`.
  - `step.run("list-accounts", ...)` → all `MailAccount` rows where `provider = "graph"`.
  - For each account: `step.run("sync-${accountId}", ...)` → instantiate `GraphProvider`, call `syncDelta(account.syncCursor)`, then run the **exact same** Prisma transactional writeback used in `gmail-sync.ts` (factor the writer into a small shared helper if it makes the diff cleaner — call it `writeDelta(account, delta, tx)` and keep it next to the data, in `lib/inngest/functions/_write-delta.ts`; or copy-paste with a comment if extraction is fiddly. The Inngest function should not contain provider-specific logic.).
  - Emit `inboxSyncEvent` after the commit succeeds, same as `gmail-sync`. The unified inbox already listens for these via `inbox-events-listener` and refetches.
- Append `graphSyncDelta` to the array exported from `lib/inngest/functions/index.ts`.

## 7. Tests — `test-author`
- Per `sub-specs/tests.md`. All Graph HTTP calls mocked via MSW; the MS token endpoint (`https://login.microsoftonline.com/.../oauth2/v2.0/token`) mocked separately.
- Fixtures placed in `tests/fixtures/graph/`. Fixture *capture* is a manual step done during the build (not authored by `test-author`); the agent writes test cases that consume already-present fixtures and stubs missing ones with `// TODO: replace with real capture`.

## 8. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas: (a) the Microsoft refresh-token writeback path (rotated token persists before the function returns; no plaintext refresh token in logs), (b) `createReply` → `send` rollback (no orphan drafts on common-path failures), (c) error-message sanitization (Graph error envelopes can contain tenant identifiers — keep them off the public `message`).
- On pass: bump `.claude/CURRENT_SPEC` to `.agent-os/specs/2026-05-17-imap-provider/spec.md` *(spec folder not yet authored — planner produces it next).*
