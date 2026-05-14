# Gmail Provider (lite)

First concrete `IEmailProvider` adapter using `googleapis`. Implements list / get / send / reply / archive / trash / markRead / setLabels / search / syncDelta against Gmail, with token refresh centralized in a new `lib/providers/auth.ts` (`getMailboxSecret`) and Gmail HTTP errors mapped to the canonical taxonomy. Adds `Thread` / `Message` / `Attachment` Prisma models. An Inngest cron runs `users.history.list` every 60s, persists deltas idempotently via `(accountId, providerMessageId)`. Server-side only — no UI in this spec.
