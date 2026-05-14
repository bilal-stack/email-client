---
name: provider-adapter-template
description: Boilerplate and conventions every IEmailProvider adapter follows. Read this before writing a new provider adapter.
---

# Provider adapter template

Every adapter implements `IEmailProvider` from `lib/providers/types.ts`. The skeleton, normalization rules, and error mapping are identical across Gmail / Graph / IMAP.

## Skeleton

```ts
// lib/providers/<provider>.ts
import type {
  IEmailProvider,
  CanonicalThread,
  CanonicalMessage,
  ListResult,
  ListThreadsOptions,
  DeltaResult,
  SendDraft,
  MessageId,
  ThreadId,
} from "./types";
import { getMailboxSecret } from "@/lib/providers/auth";
import { mapError } from "@/lib/providers/error-mapping";

export class GmailProvider implements IEmailProvider {
  constructor(private readonly accountId: string) {}

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId); // refreshes if needed
      // ... provider-specific list call, batched
      // ... normalize to CanonicalThread shape
    } catch (e) {
      throw mapError(e);
    }
  }

  // ... other methods
}
```

## Conventions

### 1. Token refresh — NEVER inline
Always call `getMailboxSecret(accountId)`. That helper checks `expiresAt`, refreshes via the provider's refresh endpoint if needed, re-encrypts, and writes the new tokens back to `MailAccount`. Adapters consume tokens; they do not manage their lifecycle.

### 2. Pagination — cursor-based, always
Return a `nextCursor` string in `ListResult` or `null` when exhausted. Map provider-specific paging tokens onto this single shape.

### 3. Normalization — to canonical types
Adapters translate provider-specific representations to the `CanonicalThread` / `CanonicalMessage` shapes in `lib/providers/types.ts`. The UI must never see provider-specific fields.

### 4. Error mapping — to the canonical taxonomy
Use `mapError(e)` to convert provider errors into one of:
- `AuthError` — 401, expired/revoked token, requires re-auth.
- `RateLimitError` — 429, with `retryAfterSeconds` if present.
- `NotFoundError` — 404 on a specific message/thread.
- `TransientError` — 5xx, network errors. Caller may retry.
- `UnknownProviderError` — fallback.

### 5. Batching — required
- Gmail: use `batch` requests or batched `messages.get` calls; never N+1 over message IDs.
- Graph: use `$batch` endpoint.
- IMAP: use `UID FETCH 1:* (BODY[HEADER.FIELDS (FROM TO ...)])` style multi-fetch.

### 6. Threading
- Gmail: native `threadId`. Use it.
- Graph: native `conversationId`. Map to `threadId`.
- IMAP: reconstruct from RFC 5322 headers. Maintain a `(messageId → threadId)` table during sync. When you see a new message whose `In-Reply-To` or `References` mentions an existing message, inherit that thread; else mint a new `threadId`.

### 7. Delta sync
- Gmail: `users.history.list` with `startHistoryId` = previous cursor. New `historyId` becomes the next cursor.
- Graph: `delta` query. The `@odata.deltaLink` URL is the next cursor.
- IMAP: store `UIDVALIDITY` + highest seen `UID`. On reconnect, if `UIDVALIDITY` changed, full re-sync.

## Adapter tests
- Tests live next to the adapter (`<provider>.test.ts`).
- Use MSW to mock the provider API.
- Record real responses once to `tests/fixtures/<provider>/*.json`, then replay them.
- Test: pagination boundaries, error mapping, token refresh, delta cursor advancement, threading reconstruction (IMAP).
