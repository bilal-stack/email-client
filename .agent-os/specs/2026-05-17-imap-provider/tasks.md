# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation.

## 1. `MailboxSecret` discriminated union (`lib/providers/auth.ts`) — `provider-adapter`
- Change the `MailboxSecret` export from a single shape to:
  ```ts
  export type MailboxSecret = OAuthMailboxSecret | ImapMailboxSecret;
  export interface OAuthMailboxSecret { kind: "oauth"; accessToken: string; refreshToken: string; expiresAt: number; scope: string; }
  export interface ImapMailboxSecret { kind: "imap"; password: string; imapHost: string; imapPort?: number; smtpHost: string; smtpPort?: number; }
  ```
- In `getMailboxSecret`, after `JSON.parse`, normalize backward-compat: if the parsed object has no `kind`, treat it as `{ kind: "oauth", ...rest }`. Write the migrated shape back on the **next** refresh (don't force-rewrite untouched rows).
- Add a `case "imap":` branch in the switch that returns the parsed IMAP secret unchanged (no token refresh — passwords don't expire).
- The OAuth branches keep their existing behavior, just operating on the narrowed `OAuthMailboxSecret` shape.
- Update the gmail / graph adapters' callers to narrow: each method's first line after `getMailboxSecret` becomes `if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail/Graph account");` (single-line guard; the kind discriminator should never actually mismatch since the provider registry routes by `MailAccount.provider`).

## 2. IMAP host SSRF guard (`lib/auth/imap-host-guard.ts`) — `provider-adapter`
- New file. Export `assertHostAllowed(host: string, port: number): Promise<void>`.
- Rules:
  - Host must be a non-empty string ≤ 253 chars.
  - Port must be in [1, 65535].
  - In `NODE_ENV === "production"`: reject if the host parses as a literal IP in `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (link-local), `::1`, or `fc00::/7`. Reject if the host is a hostname that resolves (single DNS lookup via `node:dns/promises`) to any of those ranges.
  - In dev / test: allow `localhost`, `127.0.0.1`, `::1` for local-server testing; everything else uses the same RFC1918 rules so we don't drift between environments.
- Throws `Error("IMAP host not allowed")` with a public message. The detailed reason rides on `.cause`.
- Used by the Credentials `authorize` AND by `ImapProvider`'s connect path (defense-in-depth — the stored host could theoretically be tampered with after sign-in).

## 3. Credentials `authorize` (`lib/auth/index.ts`) — `provider-adapter`
- Replace `authorize: async () => null` with a real implementation:
  1. Zod-validate `{ emailAddress, password, imapHost, smtpHost, imapPort?, smtpPort? }`. `imapPort` defaults to 993, `smtpPort` to 465.
  2. Call `assertHostAllowed(imapHost, imapPort)` AND `assertHostAllowed(smtpHost, smtpPort)`.
  3. Connect via `imapflow`: `new ImapFlow({ host, port, secure: true, auth: { user: emailAddress, pass: password } })` → `await client.connect()` → `await client.noop()` → `await client.logout()`. TLS required; refuse if the server can't speak TLS.
  4. Resolve the `User` row by email (lookup; self-create if absent — mirror the OAuth signin-callback's pattern).
  5. Build the secret blob `{ kind: "imap", password, imapHost, imapPort, smtpHost, smtpPort }`, encrypt via `lib/auth/crypto.ts`, upsert `MailAccount` with `provider: "imap"`, `emailAddress`, ciphertext.
  6. Return `{ id: userId, email: emailAddress }` to Auth.js.
- On any step failure: log a sanitized message (no password, no host details for auth failures), return `null` so Auth.js rejects.

## 4. IMAP error mapping — `provider-adapter`
- Extend `lib/providers/error-mapping.ts` with an `imapflow`-flavored branch:
  - `imapflow` errors have `e.authenticationFailed`, `e.serverResponseCode`, `e.responseStatus` (`"NO"`/`"BAD"`), `e.response`.
  - `authenticationFailed === true` OR responseStatus === "NO" with `/auth(entication)?|credentials|invalid/i` in the response → `AuthError("Invalid IMAP credentials — please re-check your app-password", { cause })`. **Do not interpolate the host or username.**
  - `responseStatus === "BAD"` → `UnknownProviderError("IMAP protocol error", { cause })`.
  - Network errors (no responseStatus, error like ECONNREFUSED / EHOSTUNREACH / ETIMEDOUT) → `TransientError("IMAP connection failed", { cause })`.
  - `UIDVALIDITY` mismatch is detected and thrown by the adapter as `AuthError` directly (see task 5); the error-mapping doesn't need to handle it specially.

## 5. IMAP adapter (`lib/providers/imap.ts`) — `provider-adapter`
- Implement `ImapProvider implements IEmailProvider`. Constructor: `(accountId: string)`.
- Connection lifecycle: each public method opens a fresh client, does its work in a `try { ... } finally { await client.logout(); }` block, and maps any thrown error via `mapError`.
- `imapflow` client construction: pulls the `ImapMailboxSecret` from `getMailboxSecret`, narrows on `kind === "imap"`, calls `assertHostAllowed` defensively, opens `new ImapFlow({ host, port, secure: true, auth: { user, pass } })`.
- Folder discovery (cached on the instance for the call's lifetime):
  - `await client.listTree()` once on first need; walk for `SPECIAL-USE` attributes (`\Sent`, `\Trash`, `\Drafts`, `\Archive`) and fall back to fixed names (`"Sent"` / `"Trash"` / `"Drafts"` / `"Archive"`) if a server doesn't advertise them. Yahoo and AOL both advertise SPECIAL-USE.
  - Map folder → synthetic label: same table as graph-provider (INBOX/SENT/DRAFT/TRASH). `UNREAD` from `\Seen` flag absence; `STARRED` from `\Flagged` presence.
- Method implementations (concrete mapping in `sub-specs/technical-spec.md`):
  - `listThreads(opts)` → `INBOX.UID FETCH 1:* …` with a UID range derived from `opts.cursor` (which encodes a UID upper bound for pagination). Group fetched envelopes by reconstructed `threadId`.
  - `getThread(id)` → `UID FETCH` the message whose `Message-ID` hashes to `id`, then walk `In-Reply-To` / `References` to fetch the full chain. Cap at 50 messages per thread (defensive — prevents pathological loops).
  - `sendMessage(draft)` → build with `nodemailer` (`MailComposer` for the MIME assembly), send via SMTP using the stored creds (`host: smtpHost, port: smtpPort, secure: smtpPort === 465`). After send, APPEND the raw message to the `Sent` folder so it appears in the user's sent items. Return `{ id: <Message-ID hash>, threadId: <resolved-or-minted-thread-id> }`.
  - `reply(threadId, draft)` → same as `sendMessage`, but pre-populate `In-Reply-To` and `References` headers from `draft`. Return `{ id }`.
  - `archive(ids)` → `MOVE` from Inbox to the Archive folder (or `Archive`-by-name fallback). Bounded `Promise.all` concurrency irrelevant here — `imapflow.messageMove` is a single command with multiple UIDs.
  - `trash(ids)` → `MOVE` to the Trash folder.
  - `markRead(ids, read)` → `messageFlagsAdd(ids, ["\\Seen"])` or `messageFlagsRemove(ids, ["\\Seen"])`.
  - `setLabels(ids, add, remove)` — system-label translation only (mirrors graph-provider's setLabels translation):
    - `add "UNREAD"` → flag remove `\Seen`. `remove "UNREAD"` → flag add `\Seen`.
    - `add "STARRED"` → flag add `\Flagged`. `remove "STARRED"` → flag remove `\Flagged`.
    - `add "TRASH"` / `remove "INBOX"` → move to Trash / Archive folder respectively.
    - Any other label (user label) → silently dropped per non-goal. Method still returns `void` successfully.
  - `search(query, opts)` → `INBOX.search({ from: ... } | { subject: ... } | { body: ... })` — basic query parsing: if the query string contains `from:foo`, translate; otherwise treat as full-text body search. (Acceptable that operator syntax differs from Gmail/Graph — same posture as in graph-provider.)
  - `syncDelta(cursor)` → see task 6.
- Threading helper: `_resolveThreadId(messageId, inReplyTo, references, tx): Promise<string>` — given the new message's id and parent refs, look up any matching `Message.providerMessageId` already in the DB (within the transaction); return its `providerThreadId` if found, else mint `messageId` itself as the new `providerThreadId`. Used by the sync writer; the writer passes the `tx` from `writeDelta` so the lookup is consistent.

## 6. Sync via UID range — `provider-adapter`
- `syncDelta(cursor: string | null): Promise<DeltaResult>`:
  - Parse cursor as `"<UIDVALIDITY>:<UID>"`. If null, treat as `null:null`.
  - Open INBOX with `await client.mailboxOpen("INBOX")`. Read the server's current `mailbox.uidValidity`.
  - If `cursor !== null` AND `cursor.uidValidity !== mailbox.uidValidity` → throw `AuthError("Mailbox state reset — reconnect required")`. The UI handles reconnect.
  - If `cursor === null` (cold start): record `nextCursor = "<currentUidValidity>:<mailbox.uidNext - 1>"`. Return empty result + that cursor.
  - Otherwise: fetch UIDs in `cursor.uid + 1 : *` via `client.fetch(range, { envelope: true, source: true, internalDate: true, flags: true, bodyStructure: true })`. For each:
    - Parse envelope → `CanonicalMessage` (from / to / cc / bcc / subject / inReplyTo / references / message-id).
    - Parse `source` (raw MIME) with `mailparser` (or `imapflow`'s built-in `download`/`bodyStructure` walker) to extract `bodyHtml` / `bodyText` / attachments meta.
    - Synthesize labels: `["INBOX"]` from current folder; `"UNREAD"` if `\Seen` not in flags; `"STARRED"` if `\Flagged` in flags.
  - `nextCursor = "<uidValidity>:<max UID fetched>"`.
  - Return `{ newMessages, changedMessages: [], deletedIds: [], nextCursor }`. **`changedMessages` and `deletedIds` are empty in v1** — UID-range polling doesn't see flag changes or deletions on already-known UIDs. (Same MVP gap as graph-provider's empty `changedMessages`. Documented in spec risks. A future spec uses `CONDSTORE` or periodic full-list comparisons.)
- Inngest sync function:
  - `lib/inngest/functions/imap-sync.ts`: cron `*/1 * * * *`, `concurrency: { limit: 1 }`, iterates `MailAccount` rows where `provider: "imap"`, calls `new ImapProvider(account.id).syncDelta(account.syncCursor)`, runs the shared `writeDelta` in a transaction, emits `inboxSyncEvent` on success (sanitized error logging — same pattern as gmail-sync / graph-sync).
- Append `imapSyncPoll` to `lib/inngest/functions/index.ts`.

## 7. Provider registry — `provider-adapter`
- In `lib/providers/index.ts`, change the `"imap"` branch of `buildProvider` to `new ImapProvider(accountId)`.

## 8. Tests — `test-author` (minimal — same posture as graph-provider)
- Per `sub-specs/tests.md`. Authored after the build. The user has explicitly opted for a minimal first-pass test suite: cover the **discriminated-union narrowing** (regression on existing OAuth callers), the **SSRF host guard** (RFC1918 rejection in prod, allow in dev), the **UIDVALIDITY mismatch → AuthError**, and the **threading lookup-then-mint** algorithm. Other coverage deferred to `TODOS.md` for a post-eval pass.

## 9. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas:
  - (a) The IMAP host SSRF guard — does it reject every RFC1918 / loopback / link-local case in prod? Does the DNS-resolution check actually run before any IMAP socket open?
  - (b) The encrypted-password writeback path in `authorize` — no plaintext password in logs, in error messages, or in returned User objects.
  - (c) IMAP error-message sanitization — `mapError` strips the host string from auth failures.
  - (d) TLS-required enforcement — refuse plaintext IMAP / SMTP regardless of port.
- On pass: bump `.claude/CURRENT_SPEC` to the next spec (Phase 4 begins — likely `.agent-os/specs/2026-05-17-ai-summaries/spec.md`, planner authors it next).
