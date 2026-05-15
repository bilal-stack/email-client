# Database Schema — Unified Inbox UI

**No schema changes in this spec.**

The `Thread`, `Message`, `Attachment`, and `MailAccount` tables introduced by the gmail-provider spec are sufficient for every read path in this spec.

## Confirmation of fields used

- `Thread.id`, `Thread.accountId`, `Thread.subject`, `Thread.lastMessageAt`, `Thread.participants` — drive the inbox list row layout.
- `Thread.unreadCount` is **ignored at read time**; the inbox query recomputes it as `COUNT(messages WHERE isUnread = true)` per the rationale in the gmail-sync comment and risk #4 in `spec.md`. Keeping the column avoids a destructive migration for a value the sync function writes accurately for the delta window but not for full-thread aggregates.
- `Message.id`, `Message.threadId`, `Message.from / to / cc / bcc`, `Message.subject`, `Message.bodyHtml`, `Message.bodyText`, `Message.receivedAt`, `Message.isUnread`, `Message.providerMessageId`, `Message.accountId` — drive the thread view, the `markRead` Server Action, and the unread aggregate.
- `Attachment.filename`, `Attachment.mimeType`, `Attachment.size` — render attachment chips. `Attachment.fetchedAt` is not consulted (no download wiring this spec).
- `MailAccount.id`, `MailAccount.userId`, `MailAccount.emailAddress`, `MailAccount.displayName` — power the account switcher and scope every query to the signed-in user.

## Indexes leveraged

- `(accountId, lastMessageAt DESC)` on `Thread` — directly serves the inbox list `ORDER BY lastMessageAt DESC LIMIT 50` query.
- `(threadId, receivedAt ASC)` on `Message` — directly serves the thread view query.
- `(accountId, providerMessageId)` unique on `Message` — not used at read time but anchors the idempotent sync that feeds this UI.

## Gaps considered and rejected

- **No `Thread.fromName` denormalization.** The list row's sender label is derived from the latest `Message.from` JSON at query time; a one-row join is cheap and keeps the schema thin.
- **No `Thread.snippet` denormalization.** Same reason.
- **No `lastReadAt` per `Thread`.** Per-message `isUnread` is sufficient. A read-receipt timestamp would be a new requirement not in the roadmap entry.
- **No `Message.htmlSanitized` cache column.** We sanitize on read (`sanitizeEmailHtml` in `getThread`). Bodies are MB-range at worst and DOMPurify is fast; a cache column would create an invalidation problem (DOMPurify upgrades, allow-list changes) without measurable win. Revisit only if profiling shows it.

If a build agent discovers a missing field during implementation, the agent **stops and asks the planner** rather than mutating the schema — per the planner's hard constraint and `CLAUDE.md`'s "update the spec first" rule.
