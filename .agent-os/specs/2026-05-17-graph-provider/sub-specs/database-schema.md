# Database Schema — Graph Provider

**No schema changes in this spec.**

The Gmail-provider spec already shaped `Thread`, `Message`, and `Attachment` provider-neutrally:

- `Thread.providerThreadId` holds Gmail's `threadId` *or* Graph's `conversationId` — the column is unaware of which.
- `Message.providerMessageId` holds Gmail's message id *or* Graph's message id.
- `Message.labels: Json` is a free-form string array. The Graph adapter writes a mix of synthetic folder labels (`INBOX`/`SENT`/`DRAFT`/`TRASH`/`UNREAD`) and Graph categories into this column with the same shape Gmail uses.
- `Thread.labels: Json` is the unioned label set across the thread's messages, populated by the Inngest writer.
- `Attachment.providerAttachmentId` holds Gmail's `attachmentId` *or* Graph's attachment id (Graph's id is stable per message; Gmail's is a fetch token — both fit in a `String` column with no semantic difference for our use).
- `MailAccount.syncCursor: String?` holds Gmail's `historyId` *or* Graph's `@odata.deltaLink` URL. The column is opaque to the DB.
- `MailAccount.provider` already accepts `"graph"` — `lib/auth/signin-callback.ts` writes that value for Microsoft Entra ID sign-ins.

The Gmail-provider spec's `(accountId, providerMessageId)` and `(accountId, providerThreadId)` unique constraints carry through unchanged — the Graph sync uses the same `findMany`-then-`createMany` idempotency dance that gmail-sync uses (see `lib/inngest/functions/gmail-sync.ts` and the extracted `_write-delta.ts` helper introduced in this spec).

## Why no migration

The pre-existing schema was authored with the multi-provider future in scope (see comments on `providerThreadId` and `syncCursor` in `prisma/schema.prisma`). Re-using the columns instead of inventing parallel `graphConversationId` / `graphMessageId` fields keeps query paths identical for downstream code: the inbox list, thread view, label CRUD, and search all read from the same columns regardless of which adapter populated them. That isolation is the entire point of the `IEmailProvider` interface — extending the schema here would leak provider distinctions into every query.

## Out of scope (recap)

- `AISummary`, `AIDraft`, `PriorityScore` — Phase 4 specs.
- Postgres full-text-search indexes on `bodyText` — added in `deploy-vercel`.
- Attachment body bytes — lazy fetch lands in its own future spec.
- Multi-cursor / per-folder delta state — defer if/when we extend Graph sync beyond the Inbox folder.
