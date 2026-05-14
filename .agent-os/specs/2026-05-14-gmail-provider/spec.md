# Gmail Provider

## Goal
Ship the first concrete `IEmailProvider` adapter: Gmail via the official `googleapis` SDK. After this spec lands, a signed-in Google user has their mailbox readable end-to-end on the server — threads list, full thread fetch, send / reply, archive / trash, read-state, label CRUD, search, and incremental delta sync via the Gmail History API run on a cron. New `Thread` / `Message` / `Attachment` Prisma tables back the cache; an Inngest function pulls deltas every 60 seconds and writes idempotently. This spec is **server-side only** — no UI changes. The unified inbox renders against these DB rows in the next spec.

## User stories
1. **As a signed-in Google user**, my mailbox is reachable through the canonical `IEmailProvider` interface — list threads, open a thread, send a reply, archive, trash, mark read, label, and search all work against my real Gmail account.
2. **As a signed-in Google user**, when a new message arrives in Gmail, the background sync picks it up within ~60 seconds and writes a `Message` row to the DB without duplicating prior messages.
3. **As a build agent (`provider-adapter`)**, I find `lib/providers/gmail.ts` implementing every `IEmailProvider` method, with token refresh delegated to `lib/providers/auth.ts` and errors mapped to the canonical taxonomy in `lib/providers/errors.ts`.
4. **As a build agent (`test-author`)**, I can run `npm test:run` and see the Gmail adapter covered by MSW-replayed fixture tests for every method, plus the token-refresh path, error mapping, and the delta-sync Inngest function.

## Non-goals
- **No UI.** Inbox list, thread view, account switcher, SSE push — all deferred to `unified-inbox-ui`.
- **No compose UI.** `sendMessage` / `reply` are reachable only via the adapter API; the TipTap composer lands in `compose-reply-forward`.
- **No Graph or IMAP adapter.** Those are their own roadmap entries.
- **No AI features.** Summaries, drafts, prioritization are Phase 4.
- **No Gmail push (Pub/Sub `users.watch`).** We pull via the History API on a 60-second cron. Push subscriptions add infra (Cloud Pub/Sub topic + verified endpoint) without earning eval signal at this stage.
- **No attachment download body fetching during sync.** Sync stores attachment *metadata* only (`fetchedAt = null`); the bytes are fetched lazily on user request — that handler lands with the UI spec.
- **No fixture recording.** The test plan describes which fixtures each test needs; capturing real Gmail responses into `tests/fixtures/gmail/*.json` is a one-time manual step performed during the build, not a spec deliverable.
- **No full re-sync flow** (e.g. when a `historyId` is older than Gmail's ~7-day window). Detection lands here (we map the 404 from `users.history.list` to a `TransientError` with a `needsFullResync` flag *open question — see risks*); the actual re-sync implementation is deferred.
- **No multi-account fan-out.** The Inngest cron iterates Gmail `MailAccount` rows for the signed-in user; multi-tenant scheduling concerns are out of scope.

## In-scope surfaces
- **`lib/providers/gmail.ts`** — `GmailProvider` class implementing `IEmailProvider`. Constructor takes `accountId: string`.
- **`lib/providers/auth.ts`** — new module. Exports `getMailboxSecret(accountId): Promise<MailboxSecret>` that decrypts via `lib/auth/crypto.ts`, refreshes Google OAuth tokens if `expiresAt` is past (or within a 60s skew), re-encrypts, and writes back to `MailAccount`.
- **`lib/providers/error-mapping.ts`** — new module. Exports `mapError(e: unknown): ProviderError` (Gmail-specific HTTP code → canonical taxonomy).
- **`lib/providers/index.ts`** — provider registry. Selects an adapter from a `MailAccount.provider` string. Gmail wired up; Graph and IMAP throw `NotImplementedError`.
- **`lib/inngest/functions/gmail-sync.ts`** — Inngest cron function `gmail-sync-delta`, schedule `*/1 * * * *` (every minute), invokes `GmailProvider.syncDelta(account.syncCursor)` for each Gmail `MailAccount`, writes `Thread` / `Message` / `Attachment` rows transactionally, updates `MailAccount.syncCursor` and `lastSyncedAt`.
- **`prisma/schema.prisma`** — adds `Thread`, `Message`, `Attachment` models (see `sub-specs/database-schema.md`). Migration generated via `npm db:migrate`.
- **`app/api/inngest/route.ts`** — register the new `gmailSyncDelta` function in the `serve({ functions: [...] })` array.

## Risks / open questions
1. **History window expiry.** Gmail's History API only retains ~7 days. If `MailAccount.syncCursor` is older, `users.history.list` returns a `404` with `historyId not found`. *Mitigation:* `mapError` translates this to an `AuthError` with a "Sync history expired — reconnect required" message. The UI (in `unified-inbox-ui`) surfaces a reconnect prompt; reconnect runs the cold-start path (no cursor → `getProfile().historyId`), which is equivalent to a fresh resync. **No new error subclass.**
2. **Batch endpoint vs. parallel fetch.** Gmail's batch endpoint is documented but uses multipart/mixed and is awkward via `googleapis`. *Mitigation:* use bounded `Promise.all` with a concurrency cap (10) on `messages.get` calls. Revisit only if quota becomes an issue.
3. **Token refresh race.** Two concurrent adapter calls could each see an expired token and both attempt a refresh. *Mitigation:* accept it. Google's refresh endpoint is idempotent and the loser just overwrites with an equivalent token. No in-process coalescing — premature optimization for an MVP.
4. **Refresh-token revocation.** A revoked refresh token returns `400 invalid_grant`. *Mitigation:* mapped to `AuthError` so the UI (in the next spec) can prompt re-connect. The `MailAccount` row is **not** auto-deleted; reconnect flow lands in `unified-inbox-ui`.
5. **Quota / rate limits.** Gmail enforces 250 quota units / user / second. *Mitigation:* the 60s cron with bounded concurrency keeps us well under. `RateLimitError` with `retryAfterSeconds` from the `Retry-After` header is surfaced for the caller (Inngest will retry the step).
6. **`historyId` vs. message IDs in deltas.** `users.history.list` returns event types (`messagesAdded`, `messagesDeleted`, `labelsAdded`, `labelsRemoved`). We must enumerate all event types to fully reconstruct `DeltaResult`. *Mitigation:* technical spec enumerates the mapping; tests cover each event type.

## Definition of done
- [ ] `lib/providers/gmail.ts` implements all ten `IEmailProvider` methods.
- [ ] `lib/providers/auth.ts` exists and `getMailboxSecret` handles refresh + re-encrypt + writeback.
- [ ] `lib/providers/error-mapping.ts` exists and covers 401 / 404 / 429 / 5xx / network.
- [ ] `lib/inngest/functions/gmail-sync.ts` exists and is registered on `/api/inngest`.
- [ ] Prisma schema includes `Thread`, `Message`, `Attachment` with the indexes and unique constraints from `sub-specs/database-schema.md`; migration committed.
- [ ] All unit tests in `sub-specs/tests.md` pass under `npm test:run`.
- [ ] No provider SDK import outside `lib/providers/*`. (Enforced by the existing import-boundary hook.)
- [ ] `security-reviewer` has signed off on the token-refresh writeback path and error mapping.
- [ ] `.claude/CURRENT_SPEC` advanced to the next spec (`unified-inbox-ui`).
