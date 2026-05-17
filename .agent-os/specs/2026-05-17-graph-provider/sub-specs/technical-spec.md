# Technical Spec — Graph Provider

## SDK choice
`@microsoft/microsoft-graph-client` (locked by `tech-stack.md`). Used as a fluent HTTP wrapper — we **do not** rely on its `AuthenticationProvider` for token refresh; that stays centralized in `lib/providers/auth.ts` (architectural rule #7). The client is constructed per-call from the fresh secret returned by `getMailboxSecret`:

```ts
import { Client } from "@microsoft/microsoft-graph-client";

function graphClient(secret: MailboxSecret): Client {
  return Client.init({
    // The auth provider here is a static-token shim — we already refreshed via
    // getMailboxSecret. The MS SDK won't refresh on its own with this shape.
    authProvider: (done) => done(null, secret.accessToken),
  });
}
```

## Token-refresh dispatch (`lib/providers/auth.ts`)

```ts
const MS_TOKEN_URL = `https://login.microsoftonline.com/${env.AZURE_AD_TENANT_ID}/oauth2/v2.0/token`;

interface MicrosoftRefreshResponse {
  token_type: string;
  scope: string;
  expires_in: number;
  access_token: string;
  refresh_token: string; // MS ALWAYS returns a fresh one
}

async function refreshMicrosoftToken(
  refreshToken: string,
  scope: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number; scope: string }> {
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.AZURE_AD_CLIENT_ID!,
      client_secret: env.AZURE_AD_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_grant")) throw new AuthError("Refresh token revoked");
    // Same pattern as the Google helper: keep the body off the public message,
    // attach as `cause` for runtime inspection.
    throw new Error(`Microsoft token refresh failed: HTTP ${res.status}`, { cause: body });
  }
  const data = (await res.json()) as MicrosoftRefreshResponse;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token, // ← MS rotates; persist the new one
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
    scope: data.scope ?? scope,
  };
}
```

Update `getMailboxSecret` to dispatch:

```ts
export async function getMailboxSecret(accountId: string): Promise<MailboxSecret> {
  const row = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } });
  const plaintext = decrypt(row.encryptedSecret, row.secretIv, row.secretTag);
  const secret = JSON.parse(plaintext) as MailboxSecret;

  const now = Math.floor(Date.now() / 1000);
  if (secret.expiresAt - REFRESH_SKEW_SECONDS > now) return secret;

  let next: MailboxSecret;
  switch (row.provider) {
    case "gmail": {
      const r = await refreshGoogleToken(secret.refreshToken);
      next = {
        accessToken: r.access_token,
        refreshToken: secret.refreshToken, // Google rarely rotates; keep the stored one
        expiresAt: now + r.expires_in,
        scope: r.scope ?? secret.scope,
      };
      break;
    }
    case "graph": {
      const r = await refreshMicrosoftToken(secret.refreshToken, secret.scope);
      next = r; // r already has the new refreshToken
      break;
    }
    default:
      throw new Error(`Unsupported provider for refresh: ${row.provider}`);
  }

  const sealed = encrypt(JSON.stringify(next));
  await prisma.mailAccount.update({
    where: { id: accountId },
    data: { encryptedSecret: sealed.ciphertext, secretIv: sealed.iv, secretTag: sealed.tag },
  });
  return next;
}
```

## Error mapping (`lib/providers/error-mapping.ts`)

Add this branch above the existing `status === 429` check:

```ts
if (status === 410) {
  if (/delta.?link|deltaToken|resync required/i.test(message)) {
    return new AuthError(`Sync delta expired — reconnect required: ${message}`, { cause });
  }
  return new NotFoundError(message, { cause });
}
```

The existing `pickMessage` path already handles Graph's envelope (`err.response?.data?.error?.message`) because Graph and Gmail use the same nested shape — verify with a Graph-shaped fixture in the test (see `tests.md`).

## `IEmailProvider` method → Graph API mapping

| Method | Graph call | Notes |
|---|---|---|
| `listThreads(opts)` | `GET /me/mailFolders/inbox/messages?$top=…&$orderby=receivedDateTime desc&$skiptoken=opts.cursor&$select=…` | Group results by `conversationId` in the adapter. `$select` keeps the field set bounded: `id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,categories,parentFolderId,hasAttachments,bodyPreview`. `nextCursor` = the `@odata.nextLink`'s `$skiptoken` value (extract via URL parse). |
| `getThread(id)` | `GET /me/messages?$filter=conversationId eq '{id}'&$orderby=receivedDateTime asc&$top=100&$select=…,body,internetMessageHeaders` | One round trip per thread — the `id` is the `conversationId`. Asks for `body` and `internetMessageHeaders` since this is the only path where the full body + threading headers matter. |
| `sendMessage(draft)` | `POST /me/sendMail` | Body shape below. Attachments inlined as `fileAttachment` items (`@odata.type: "#microsoft.graph.fileAttachment"`, `contentBytes` = base64). |
| `reply(threadId, draft)` | `POST /me/messages/{draft.inReplyTo}/createReply` → `PATCH /me/messages/{draftId}` → `POST /me/messages/{draftId}/send` | Three-call sequence. On step 2 or step 3 failure, attempt `DELETE /me/messages/{draftId}` best-effort. Step 1 sets conversation, headers, and base recipients; step 2 overrides body + (optionally) recipients. |
| `archive(ids)` | `POST /me/messages/{id}/move` with body `{ destinationId: "archive" }`. Per id, concurrency 10. | "archive" is a well-known folder name. No batch helper here — `/move` returns a relocated message envelope we discard. |
| `trash(ids)` | `POST /me/messages/{id}/move` with `{ destinationId: "deleteditems" }`. Per id, concurrency 10. | Same shape as archive. |
| `markRead(ids, read)` | `POST /$batch` with up to 20 `PATCH /me/messages/{id}` body `{ isRead: read }`. Loops `Math.ceil(ids.length / 20)` times. | Graph's `$batch` ceiling is 20 requests. |
| `setLabels(ids, add, remove)` | Per id: `GET /me/messages/{id}?$select=categories,parentFolderId,isRead` → compute next state → `PATCH /me/messages/{id}` with `{ categories: nextList, isRead?: ... }` plus an optional `POST /me/messages/{id}/move` if a synthetic-label change requires it. Concurrency 10. | The mapping table below pins what each label name does on write. |
| `search(query, opts)` | `GET /me/messages?$search="…"&$top=…&$select=…` | Single page. `$search` does not surface a stable `nextLink`; we return `nextCursor: null` and rely on the inbox's already-shipped behavior of folding partial results across providers. |
| `syncDelta(cursor)` | `GET /me/mailFolders/inbox/messages/delta` (initial) or the saved `@odata.deltaLink` URL verbatim (subsequent). | See "Delta sync" section. |

## Folder ↔ synthetic-label mapping

Graph organizes mail by folder; our domain model speaks in label strings. The Graph adapter reconciles these on a fixed table.

**On read** (normalization, in `normalizeMessage`):

```
parentFolderId (well-known name) → synthetic label
  inbox          → "INBOX"
  sentitems      → "SENT"
  drafts         → "DRAFT"
  deleteditems   → "TRASH"
  archive        → (no synthetic label — absence of "INBOX" is the archive signal)
  (anything else)→ (no synthetic label — custom folder; user labels live in `categories`)

isRead === false → also append "UNREAD"

Final labels = [synthetic labels...] ∪ categories (deduped)
```

Note: Graph returns `parentFolderId` as an opaque id, not a well-known name. The adapter maintains an in-process cache of `{ wellKnownName → folderId }` populated lazily via `GET /me/mailFolders/{name}` lookups on first need. Cache lives on the `GraphProvider` instance (so it's per-account, per-call-site — the instance is short-lived per HTTP request, which is fine).

**On write** (in `setLabels`, `archive`, `trash`, `markRead`):

```
label change → Graph operation
  add "INBOX"        → move to inbox (rare — usually only seen on un-archive, which the UI doesn't expose; safe to support symmetrically)
  remove "INBOX"     → move to archive folder
  add "TRASH"        → move to deleteditems
  remove "TRASH"     → move to inbox (un-trash; same un-archive note applies)
  add "UNREAD"       → PATCH { isRead: false }
  remove "UNREAD"    → PATCH { isRead: true }
  add "SENT"         → no-op (writes don't relocate to Sent; mail enters Sent via /sendMail)
  add "DRAFT"        → no-op (we don't manufacture drafts via this path)
  (any other string) → categories +=
  remove (any other) → categories -=
```

`archive(ids)` and `trash(ids)` are convenience entry points that take the move-to-folder shortcut directly; they do not flow through the `setLabels` translation. `markRead(ids, read)` likewise skips translation and PATCHes `isRead` directly. `setLabels` is the only entry point that performs the full translation (because callers may pass a mix of synthetic and category labels).

## Outgoing message bodies

```ts
function buildGraphMessage(draft: SendDraft) {
  return {
    subject: draft.subject,
    body: { contentType: "HTML", content: draft.bodyHtml },
    toRecipients: draft.to.map(toRecipient),
    ccRecipients: (draft.cc ?? []).map(toRecipient),
    bccRecipients: (draft.bcc ?? []).map(toRecipient),
    attachments: (draft.attachments ?? []).map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.mimeType,
      contentBytes: a.content.toString("base64"),
    })),
  };
}

function toRecipient(addr: CanonicalAddress) {
  return { emailAddress: { name: addr.name, address: addr.email } };
}
```

`sendMessage` posts `{ message: buildGraphMessage(draft), saveToSentItems: true }` to `/me/sendMail`. Returns `{ id: <new-message-id>, threadId: <new-conversation-id> }`. Graph's `/sendMail` is fire-and-forget and does NOT return the message id; to satisfy the `IEmailProvider` contract we follow up with `GET /me/mailFolders/sentitems/messages?$top=1&$orderby=sentDateTime desc&$select=id,conversationId` and return the top hit. (Slight TOCTOU window: if two sends race within the same second, we could return the wrong id. Acceptable for an MVP — flagged here, not mitigated.)

`reply` similarly returns the draft id from step 1 after step 3 succeeds. No follow-up read needed.

## Delta sync

```ts
async syncDelta(cursor: string | null): Promise<DeltaResult> {
  try {
    const secret = await getMailboxSecret(this.accountId);
    const client = graphClient(secret);

    // Cold start: drain to a deltaLink without normalizing anything.
    if (!cursor) {
      let nextUrl: string = "/me/mailFolders/inbox/messages/delta?$top=1";
      while (true) {
        const page = await client.api(nextUrl).get();
        if (page["@odata.deltaLink"]) {
          return { newMessages: [], changedMessages: [], deletedIds: [], nextCursor: page["@odata.deltaLink"] };
        }
        nextUrl = page["@odata.nextLink"];
        if (!nextUrl) throw new Error("Graph delta returned neither nextLink nor deltaLink");
      }
    }

    // Incremental: follow the saved deltaLink. Caller passes the full URL.
    const newMessages: CanonicalMessage[] = [];
    const deletedIds: MessageId[] = [];
    let nextUrl: string = cursor;
    let finalDeltaLink: string | null = null;

    while (true) {
      const page = await client.api(nextUrl).get();
      for (const entry of (page.value ?? []) as GraphDeltaEntry[]) {
        if (entry["@removed"]) {
          deletedIds.push(entry.id);
        } else {
          // Defer attachment fanout until after the page is collected
          newMessages.push(normalizeGraphMessage(entry, this.accountId));
        }
      }
      if (page["@odata.deltaLink"]) { finalDeltaLink = page["@odata.deltaLink"]; break; }
      nextUrl = page["@odata.nextLink"];
      if (!nextUrl) throw new Error("Graph delta returned neither nextLink nor deltaLink");
    }

    // Attachment metadata for messages with `hasAttachments`.
    const withAttachments = newMessages.filter((m) => m._raw.hasAttachments);
    await mapConcurrent(withAttachments, 10, async (m) => {
      m.attachments = await fetchAttachmentMeta(client, m.id);
    });

    return { newMessages, changedMessages: [], deletedIds, nextCursor: finalDeltaLink };
  } catch (e) {
    throw mapError(e);
  }
}
```

(`_raw` is a temporary internal field used only inside `syncDelta` to carry `hasAttachments` from the delta envelope through to the attachment fanout; it is stripped before returning. Alternatively, normalize after the fanout — pick whichever reads cleaner during the build.)

Notes:
- `changedMessages` is intentionally empty per spec risk #6/task 4 — Graph delta emits full envelopes for updates, and our writer's "skip duplicates by `providerMessageId`" path means `isRead`/`categories` updates after first sight are dropped. **This is a known MVP gap**, called out in the spec. The synthetic-label freshness on the inbox list relies on the most recent sync's envelope being the one the user sees; flipping `isRead` outside our UI (in Outlook web, for example) will not propagate until the next time the message appears in a delta page, which typically only happens on subsequent updates. Acceptable here; a future "rich delta" follow-up addresses it once the eval is done.
- The cold-start path uses `$top=1` so a freshly-connected mailbox doesn't trigger thousands of unused-page fetches just to obtain the deltaLink.

## Search

```ts
async search(query: string, opts: { limit?: number } = {}) {
  try {
    const secret = await getMailboxSecret(this.accountId);
    const client = graphClient(secret);
    const top = opts.limit ?? 50;
    const res = await client
      .api("/me/messages")
      .header("ConsistencyLevel", "eventual")  // required by Graph for $search
      .search(`"${escapeSearchTerm(query)}"`)
      .top(top)
      .select(LIST_FIELDS)
      .get();
    const threads = groupByConversation(res.value ?? [], this.accountId);
    return { items: threads, nextCursor: null };
  } catch (e) {
    throw mapError(e);
  }
}
```

`escapeSearchTerm` escapes double-quotes and backslashes in the user-supplied query before the SDK wraps it. The `ConsistencyLevel: eventual` header is mandatory for `$search` against Graph's mail endpoints.

## Inngest function (`lib/inngest/functions/graph-sync.ts`)

```ts
import { inngest } from "@/lib/inngest/client";
import { prisma } from "@/lib/db";
import { GraphProvider } from "@/lib/providers/graph";
import { writeDelta } from "@/lib/inngest/functions/_write-delta";
import { emitInboxSyncEvent } from "@/lib/realtime/inbox-events";

export const graphSyncDelta = inngest.createFunction(
  { id: "graph-sync-delta", concurrency: { limit: 1 } },
  { cron: "*/1 * * * *" },
  async ({ step }) => {
    const accounts = (await step.run("list-accounts", () =>
      prisma.mailAccount.findMany({
        where: { provider: "graph" },
        select: { id: true, syncCursor: true, userId: true },
      }),
    )) as Array<{ id: string; syncCursor: string | null; userId: string }>;

    for (const account of accounts) {
      await step.run(`sync-${account.id}`, async () => {
        const provider = new GraphProvider(account.id);
        const delta = await provider.syncDelta(account.syncCursor);
        const touched = await prisma.$transaction((tx) => writeDelta({ account, delta, tx }));
        if (touched.threadIds.length > 0 || delta.deletedIds.length > 0) {
          emitInboxSyncEvent(account.userId, {
            accountId: account.id,
            threadIds: touched.threadIds,
            at: Date.now(),
          });
        }
      });
    }
  },
);
```

`writeDelta` is the same logic that currently lives inline inside `gmail-sync.ts` (steps 1–6 of the transaction). The build pulls that block out into `lib/inngest/functions/_write-delta.ts` and replaces gmail-sync's inline copy with a call to the helper. Both sync functions then differ only in the provider class they instantiate. The helper returns `{ threadIds: string[] }` — the DB ids of the upserted threads — so the caller can decide whether to emit an SSE.

## Normalization rules

- **Addresses**: parse `from.emailAddress`, `toRecipients[*].emailAddress`, etc. Each becomes `{ name, email }`. Empty `name` is dropped per `CanonicalAddress` shape (name is optional).
- **Subject**: `message.subject`; empty string if absent.
- **Snippet**: `message.bodyPreview`.
- **`bodyHtml` / `bodyText`**: `message.body.content` when `contentType === "html"` → `bodyHtml`; `contentType === "text"` → `bodyText`. We don't request both — Graph returns one based on the mailbox's stored format. If `bodyHtml` is null but `bodyText` is present, the existing `sanitize-email-html` skill handles the text-only path on render.
- **`receivedAt`**: `new Date(message.receivedDateTime)`.
- **`isUnread`**: `!message.isRead`.
- **`labels`**: synthetic-folder labels + `UNREAD` (if unread) + `message.categories`. Deduped.
- **`inReplyTo` / `references`**: parsed from `message.internetMessageHeaders` (only present on `getThread`'s `$select`-extended fetch; the list-only path leaves both fields null).
- **Attachments**: from the separate `/me/messages/{id}/attachments` fetch (sync only — the inbox-list path leaves `attachments: []` since the column is not surfaced there anyway).

## Env vars
No new env vars. `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `AZURE_AD_TENANT_ID` already set in foundation.

## Out of scope (recap)
Initial full-mailbox seed, multi-folder delta (Sent/Drafts/Archive), Graph webhooks, `changedMessages` propagation, category-color round-trip, IMAP, UI.
