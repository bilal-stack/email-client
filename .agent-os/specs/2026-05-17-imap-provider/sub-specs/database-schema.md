# Database Schema — IMAP Provider

**No schema changes in this spec.**

The `Thread` / `Message` / `Attachment` tables shipped in `gmail-provider` were authored provider-neutral and continue to host IMAP data unmodified:

- `Thread.providerThreadId` holds Gmail's `threadId`, Graph's `conversationId`, or — for IMAP — the RFC 5322 `Message-ID` of the thread root (with angle brackets stripped). The column is unaware of which.
- `Message.providerMessageId` holds the analogous per-message id. For IMAP this is also the RFC 5322 `Message-ID` (the natural primary key in the IMAP world). That choice makes the threading reconstruction's `In-Reply-To` / `References` lookup a direct equality match against this column — no synthetic id mapping needed.
- `Message.labels: Json` is the same free-form string array. The IMAP adapter writes a fixed system-label set (`INBOX`, `SENT`, `DRAFT`, `TRASH`, `UNREAD`, `STARRED`) derived from folder membership + IMAP flags. User labels written by the UI persist in this column but do not round-trip to the server (documented non-goal).
- `Attachment.providerAttachmentId` holds the per-message attachment part identifier (imapflow's BODYSTRUCTURE part path, e.g. `"2.1"`); a string. Same column shape as Gmail / Graph.
- `MailAccount.syncCursor: String?` holds `<UIDVALIDITY>:<HIGHEST_UID>` for IMAP, opaque to the DB. Compare gmail's `historyId` and graph's `@odata.deltaLink` URL — three different shapes, one column.
- `MailAccount.provider` already accepts `"imap"` (the foundation schema explicitly enumerated it in the column comment); the Credentials `authorize` writes that value when a credential sign-in succeeds.

The Phase 2 unique constraints carry through:

- `(accountId, providerMessageId)` — guarantees `createMany`-with-existing-filter idempotency. Two sync runs over the same UID range write the same `Message-ID`s, the filter drops them, no duplicates.
- `(accountId, providerThreadId)` — guarantees thread upsert idempotency. Two sync runs over the same root message inherit the same thread id.

## Why no migration

The existing schema's comment on `MailAccount.syncCursor` is explicit:

```prisma
syncCursor      String? // historyId | delta token | UIDVALIDITY+UID
```

The shape was authored with IMAP's `UIDVALIDITY+UID` cursor in mind. Inventing parallel `imapUidValidity` / `imapHighestUid` columns would leak provider distinctions into every downstream query — exactly what the `IEmailProvider` interface exists to prevent. The opaque string column keeps the inbox / thread / search / compose query paths identical regardless of which adapter populated the data.

## What about `Account` (Auth.js's row)?

`Account` is the Auth.js v5 / PrismaAdapter table for OAuth provider linkage. The Credentials provider does **not** write to `Account` — Credentials sign-ins skip the PrismaAdapter's account-linking path because Credentials authentication isn't an OAuth grant. The user identity persists via the JWT session strategy (the `jwt` callback in `lib/auth/index.ts` lifts `user.id` into the token after a successful `authorize`). No `Account` row is created for an IMAP sign-in, only a `User` and a `MailAccount`. This is intentional and matches Auth.js v5's documented behavior for credentials-based providers in JWT mode.

## Out of scope (recap)

- `AISummary`, `AIDraft`, `PriorityScore` — Phase 4 specs.
- Postgres full-text indexes on `bodyText` — `deploy-vercel`.
- Attachment body bytes — lazy fetch lands in a future spec.
- IMAP UID storage — a column to store per-message UIDs would enable CONDSTORE/QRESYNC delta-by-modseq sync; defer.
