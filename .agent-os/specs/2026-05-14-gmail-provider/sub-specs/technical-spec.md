# Technical Spec — Gmail Provider

## SDK choice
`googleapis` (locked by `tech-stack.md`). Use `google.gmail({ version: "v1", auth: oauth2Client })`. OAuth client is constructed per-call from the fresh secret returned by `getMailboxSecret`:

```ts
import { google } from "googleapis";

function gmailClient(secret: MailboxSecret) {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ access_token: secret.accessToken });
  return google.gmail({ version: "v1", auth: oauth2 });
}
```

We do not let `googleapis` refresh on its own — token refresh is centralized (architectural rule #7 in `CLAUDE.md`).

## Token-refresh helper (`lib/providers/auth.ts`)

```ts
import { decrypt, encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { AuthError } from "@/lib/providers/errors";

export interface MailboxSecret {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  scope: string;
}

const REFRESH_SKEW_SECONDS = 60;

export async function getMailboxSecret(accountId: string): Promise<MailboxSecret> {
  const row = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const plain = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
  const secret = JSON.parse(plain) as MailboxSecret;

  const now = Math.floor(Date.now() / 1000);
  if (secret.expiresAt - REFRESH_SKEW_SECONDS > now) return secret;

  if (row.provider !== "gmail") {
    throw new Error(`Unsupported provider for refresh: ${row.provider}`);
  }

  const refreshed = await refreshGoogleToken(secret.refreshToken);
  const next: MailboxSecret = {
    accessToken: refreshed.access_token,
    refreshToken: secret.refreshToken, // Google does not always rotate
    expiresAt: now + refreshed.expires_in,
    scope: refreshed.scope ?? secret.scope,
  };
  const sealed = encrypt(JSON.stringify(next));
  await prisma.mailAccount.update({
    where: { id: accountId },
    data: { encryptedSecret: sealed.ciphertext, secretIv: sealed.iv, secretTag: sealed.tag },
  });
  return next;
}

// Note: concurrent calls within a single Node process may both attempt a refresh.
// This is benign — Google's refresh endpoint is idempotent and the loser just
// overwrites with an equivalent secret. We do NOT coalesce in-process because
// the complexity isn't worth it for an MVP single-user workflow.

async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_grant")) throw new AuthError("Refresh token revoked");
    throw new Error(`Google refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as { access_token: string; expires_in: number; scope?: string };
}
```

The `MailboxSecret` plaintext shape is JSON. `MailAccount.encryptedSecret` is the AES-GCM ciphertext of `JSON.stringify(secret)`.

## Error mapping (`lib/providers/error-mapping.ts`)

```ts
import {
  AuthError, NotFoundError, RateLimitError, TransientError,
  UnknownProviderError, ProviderError,
} from "./errors";

export function mapError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { code?: number; status?: number; message?: string; response?: { status?: number; headers?: Record<string, string>; data?: { error?: { message?: string } } } };
  const status = err.response?.status ?? err.code ?? err.status;
  const message = err.response?.data?.error?.message ?? err.message ?? "Provider call failed";

  if (status === 401) return new AuthError(message, { cause: e });
  if (status === 403 && /insufficientPermissions|invalid_grant/i.test(message)) return new AuthError(message, { cause: e });
  if (status === 404) {
    // Stale historyId (>~7 days) is mapped to AuthError so the UI prompts a
    // reconnect-and-resync (handled in the unified-inbox-ui spec). We do NOT
    // implement an automatic full-resync flow in this spec.
    if (/historyId.*not found|startHistoryId/i.test(message)) {
      return new AuthError(`Sync history expired — reconnect required: ${message}`, { cause: e });
    }
    return new NotFoundError(message, { cause: e });
  }
  if (status === 429) {
    const retryAfter = Number(err.response?.headers?.["retry-after"]);
    return new RateLimitError(message, Number.isFinite(retryAfter) ? retryAfter : undefined, { cause: e });
  }
  if (status && status >= 500 && status < 600) return new TransientError(message, { cause: e });
  if (!status) return new TransientError(message, { cause: e }); // network / DNS / abort

  return new UnknownProviderError(message, { cause: e });
}
```

## `IEmailProvider` method → Gmail API mapping

| Method | Gmail API call | Notes |
|---|---|---|
| `listThreads(opts)` | `users.threads.list` | `pageToken = opts.cursor`, `maxResults = opts.limit ?? 50`, `labelIds = [opts.label]` if set. Response `nextPageToken` → `nextCursor`. |
| `getThread(id)` | `users.threads.get` with `format: "full"` | Single call returns all messages with payloads. |
| `sendMessage(draft)` | `users.messages.send` | RFC 2822 string base64url-encoded into `raw`. |
| `reply(threadId, draft)` | `users.messages.send` with `threadId` set | Include `In-Reply-To` and `References` headers from `draft`. |
| `archive(ids)` | `users.messages.batchModify` | `removeLabelIds: ["INBOX"]`. Single call. |
| `trash(ids)` | `users.messages.trash` per id | No batch endpoint; bounded `Promise.all` (concurrency 10). |
| `markRead(ids, read)` | `users.messages.batchModify` | Toggle `UNREAD` in `removeLabelIds` (read=true) or `addLabelIds` (read=false). |
| `setLabels(ids, add, remove)` | `users.messages.batchModify` | Direct pass-through. |
| `search(query, opts)` | `users.threads.list` with `q = query` | Gmail's search operators (`from:`, `has:attachment`, etc.) flow through as-is. |
| `syncDelta(cursor)` | `users.history.list` | See below. |

## Batching strategy

- **Use `batchModify` where Gmail offers it** (archive, markRead, setLabels). One HTTP call for up to 1000 IDs.
- **Do not use Gmail's `/batch` multipart endpoint.** `googleapis` exposes it only through low-level types and the multipart parsing is awkward.
- **For per-ID fetches** (`messages.get` during sync, `messages.trash`) use bounded `Promise.all` with concurrency 10. Helper:

```ts
async function mapConcurrent<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
```

## Delta sync (`syncDelta`)

```ts
async syncDelta(cursor: string | null): Promise<DeltaResult> {
  try {
    const secret = await getMailboxSecret(this.accountId);
    const gmail = gmailClient(secret);

    if (!cursor) {
      const profile = await gmail.users.getProfile({ userId: "me" });
      return { newMessages: [], changedMessages: [], deletedIds: [], nextCursor: String(profile.data.historyId) };
    }

    const newMessageIds = new Set<string>();
    const deletedIds = new Set<string>();
    const changed = new Map<string, MessageChange>();
    let pageToken: string | undefined;
    let maxHistoryId = cursor;

    do {
      const res = await gmail.users.history.list({
        userId: "me",
        startHistoryId: cursor,
        historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
        pageToken,
      });
      for (const h of res.data.history ?? []) {
        if (h.id && BigInt(h.id) > BigInt(maxHistoryId)) maxHistoryId = h.id;
        for (const a of h.messagesAdded ?? []) if (a.message?.id) newMessageIds.add(a.message.id);
        for (const d of h.messagesDeleted ?? []) if (d.message?.id) deletedIds.add(d.message.id);
        for (const l of h.labelsAdded ?? []) {
          if (!l.message?.id) continue;
          const c = changed.get(l.message.id) ?? { id: l.message.id, labels: [] };
          c.labels = [...(c.labels ?? []), ...(l.labelIds ?? [])];
          if ((l.labelIds ?? []).includes("UNREAD")) c.isUnread = true;
          changed.set(l.message.id, c);
        }
        for (const l of h.labelsRemoved ?? []) {
          if (!l.message?.id) continue;
          const c = changed.get(l.message.id) ?? { id: l.message.id, labels: [] };
          // Remove operation tracked by upstream consumer; we pass labels to remove as negative entries OR re-fetch the message.
          if ((l.labelIds ?? []).includes("UNREAD")) c.isUnread = false;
          changed.set(l.message.id, c);
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.historyId && BigInt(res.data.historyId) > BigInt(maxHistoryId)) maxHistoryId = res.data.historyId;
    } while (pageToken);

    // Discard IDs that are both added and deleted in the same window — net deleted.
    for (const id of deletedIds) newMessageIds.delete(id);

    const newMessages = await mapConcurrent(
      [...newMessageIds],
      10,
      async (id) => normalizeMessage((await gmail.users.messages.get({ userId: "me", id, format: "full" })).data),
    );

    return {
      newMessages,
      changedMessages: [...changed.values()],
      deletedIds: [...deletedIds],
      nextCursor: maxHistoryId,
    };
  } catch (e) {
    throw mapError(e);
  }
}
```

`changedMessages` in `DeltaResult` carries the new label set / `isUnread` state. Sync writer in Inngest (task 7) translates this to `updateMany` calls. Note: the canonical `MessageChange` type carries a *replacement* label list, not deltas — for `labelsRemoved` events the Inngest writer re-reads the message's stored labels and applies the subtraction. (Open: a cleaner alternative is to extend the canonical shape with `addedLabels` / `removedLabels`; flagged but deferred — overhauling the canonical type is out of scope for this spec.)

## Inngest function (`lib/inngest/functions/gmail-sync.ts`)

```ts
import { inngest } from "@/lib/inngest/client";
import { prisma } from "@/lib/db";
import { GmailProvider } from "@/lib/providers/gmail";

export const gmailSyncDelta = inngest.createFunction(
  { id: "gmail-sync-delta", concurrency: { limit: 1, key: "event.data.accountId" } },
  { cron: "* * * * *" }, // every minute
  async ({ step }) => {
    const accounts = await step.run("list-accounts", () =>
      prisma.mailAccount.findMany({ where: { provider: "gmail" }, select: { id: true, syncCursor: true } }),
    );
    for (const account of accounts) {
      await step.run(`sync-${account.id}`, async () => {
        const provider = new GmailProvider(account.id);
        const delta = await provider.syncDelta(account.syncCursor);
        await prisma.$transaction(async (tx) => {
          // 1. Upsert threads referenced by newMessages.
          // 2. createMany messages with skipDuplicates.
          // 3. createMany attachments.
          // 4. updateMany for changedMessages.
          // 5. deleteMany for deletedIds.
          // 6. Update MailAccount.syncCursor = delta.nextCursor; lastSyncedAt = now.
        });
      });
    }
  },
);
```

Register in `app/api/inngest/route.ts`:

```ts
import { gmailSyncDelta } from "@/lib/inngest/functions/gmail-sync";
export const { GET, POST, PUT } = serve({ client: inngest, functions: [gmailSyncDelta] });
```

## Normalization rules

- **Addresses**: parse `From` / `To` / `Cc` / `Bcc` headers with a minimal RFC 5322 address parser (e.g. `addressparser` from `nodemailer`, already transitively present).
- **Subject**: from headers; empty string if absent.
- **Snippet**: take Gmail's `snippet` field verbatim.
- **`bodyHtml` / `bodyText`**: walk `payload.parts`, decoding base64url for the first `text/html` and first `text/plain` part. Store the full content — SQLite `TEXT` handles MB-sized strings fine and we don't optimize storage for an MVP.
- **`receivedAt`**: `parseInt(internalDate)` as ms since epoch.
- **`isUnread`**: `labelIds.includes("UNREAD")`.
- **`labels`**: pass `labelIds` through verbatim. System labels (`INBOX`, `STARRED`, `IMPORTANT`, etc.) ride along.
- **`inReplyTo`** / **`references`**: parsed from RFC 5322 `In-Reply-To` and `References` headers, split on whitespace, angle brackets stripped.
- **Attachments**: every part with a `body.attachmentId` and a `filename` becomes a `CanonicalAttachmentMeta` (`id = attachmentId`, no bytes fetched).

## Env vars
No new env vars. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` already set in foundation.

## Out of scope (recap)
Full-mailbox seed, attachment-body fetch, `users.watch` push, Graph/IMAP adapters, UI.
