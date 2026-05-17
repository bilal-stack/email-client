# Tests — IMAP Provider

`test-author` agent writes these alongside the build. The user has explicitly opted for a **minimal first-pass test suite** — same posture as graph-provider — focused on the load-bearing invariants that would silently break without a regression net. The full test menu would mirror gmail-provider's depth; that wider coverage lands in a post-eval pass (tracked in `TODOS.md` after this spec ships, parallel to the graph-provider deferral).

**No E2E in this spec.** The Playwright suites from `unified-inbox-ui` and `search-labels-archive-delete` already exercise the inbox / thread / composer / search / labels surfaces against `IEmailProvider`; running them with an IMAP-backed account is a manual smoke step at hand-off (`tasks.md#9`), not an automated deliverable here.

## What lands as code in this spec

### `lib/providers/auth.test.ts` (additions — narrowing regression)
- **OAuth callers narrow correctly after the discriminated-union refactor.** With a Gmail `MailAccount` row whose stored secret was written BEFORE the union (no `kind` field), `getMailboxSecret` returns a value with `kind === "oauth"` and the existing `accessToken` / `refreshToken` / `expiresAt` / `scope` fields intact. This is the backward-compat invariant — if it regresses, every existing Gmail / Graph row breaks silently.
- **IMAP secret round-trip.** Given a stored `{ kind: "imap", password, imapHost, ..., smtpHost, smtpPort }` blob, `getMailboxSecret` returns it unchanged with `kind === "imap"`. **No refresh attempt** is observed (MSW asserts no call to either OAuth token endpoint).
- **Skip** the legacy-without-kind-rewrite-on-next-refresh test (it's a "on the next refresh" thing — quiet, hard to trigger without simulating expiry; covered by the regular MS rotation test re-running its decrypt-after-refresh assertion, which incidentally would surface a kind-stripping bug).

### `lib/auth/imap-host-guard.test.ts` (new file)
- **Production rejection of RFC1918 / loopback / link-local literals.** Set `NODE_ENV=production`. Each of these throws: `10.0.0.5`, `172.16.0.1`, `192.168.1.1`, `127.0.0.1`, `169.254.169.254`, `::1`, `fc00::1`, `fe80::1`. Each error message is exactly `"IMAP host not allowed"` with the reason on `.cause`. (One `test.each` block; one assertion per case is enough.)
- **Production rejection of a hostname that resolves to a private IP.** Mock `dns.lookup` to return `[{ address: "169.254.169.254", family: 4 }]` for some hostname; expect rejection. (This is the AWS-metadata SSRF case — load-bearing.)
- **Production accepts a public-resolving hostname.** Mock `dns.lookup` to return `[{ address: "1.2.3.4", family: 4 }]`; expect resolve.
- **Dev allows `localhost` / `127.0.0.1` / `::1`.** Set `NODE_ENV=development`; each resolves. Other private literals still reject in dev (no environment drift on the rules themselves).
- **Port validation.** Port 0, port -1, port 65536 each reject regardless of host. Port too-large-for-int rejects.
- **Skip** explicit "host too long" / empty-host tests — the Zod schema in `authorize` rejects them before `assertHostAllowed` runs; one assertion in the host-guard tests confirms the empty-string reject and length-cap reject as a defense-in-depth.

### `lib/providers/imap.test.ts` (new file — minimal)
- **Threading lookup-then-mint.** Seed the test DB with one `Message` row whose `providerMessageId = "abc@example.com"` on a known account. Call the adapter's threading-resolution helper (export it or test through `syncDelta`) with a fresh message whose `inReplyTo = "abc@example.com"`: returns the seeded message's `providerThreadId`. Then call with `inReplyTo = "unknown@example.com"`: mints a new thread id equal to the new message's own Message-ID. **Single test, both cases.** This is the algorithmic core of IMAP threading — every other behavior derives from it.
- **`syncDelta` cold start.** With `cursor === null`, opens INBOX, records `<UIDVALIDITY>:<uidNext - 1>` as `nextCursor`, returns empty `newMessages` / `changedMessages` / `deletedIds`. The cold-start contract is identical across all three providers; one test pins it for IMAP.
- **`syncDelta` UIDVALIDITY mismatch → AuthError.** With `cursor = "9999:42"` and the mocked server's `mailbox.uidValidity = 1111`, the adapter throws `AuthError` whose message is `"Mailbox state reset — reconnect required"`. **The host is NOT in the message** (security invariant).
- **`setLabels` system-label translation: drops user labels, applies system flags.** Call `setLabels(["uid:42"], ["Work", "UNREAD"], ["STARRED"])`. The mocked `imapflow` client observes a `messageFlagsRemove` call with `\Seen` (from `add "UNREAD"`) AND a `messageFlagsRemove` call with `\Flagged` (from `remove "STARRED"`). The `"Work"` user label produces **no** observable IMAP call. **The method returns void successfully** (no thrown error on the user-label silent-drop).
- **Skip** per-method happy paths (`listThreads`, `getThread`, `sendMessage`, `reply`, `archive`, `trash`, `markRead`, `search`) — each is a thin wrapper over an `imapflow` call; if any of them misbehaves the manual smoke at hand-off catches it. The four tests above cover the algorithmic / security-relevant branches.

### `lib/providers/error-mapping.test.ts` (additions)
- **IMAP auth failure → `AuthError` with canonical message; host NOT echoed.** Construct an error object with `{ authenticationFailed: true, response: "Invalid credentials for foo@bar on imap.example.com:993" }`. Expect `AuthError` whose `.message` is exactly `"Invalid IMAP credentials — please re-check your app-password"`. Assert the host string does NOT appear in `.message`. The original error still rides on `.cause`.
- **IMAP `responseStatus: "BAD"` → `UnknownProviderError`.** One case.
- **IMAP network code → `TransientError`.** `{ code: "ECONNREFUSED" }` is enough.
- **Skip** every other IMAP-flavored error path — three is the meaningful surface; widening to e.g. `EHOSTUNREACH` vs `ETIMEDOUT` tests the regex, not the canonical mapping.

### `lib/providers/index.test.ts` (existing — one-line addition)
- Add an assertion that `buildProvider("imap", id)` returns an `ImapProvider`. Mirrors the graph-provider change to the same file.

### What's NOT written in this spec
- `lib/inngest/functions/imap-sync.test.ts` — orchestration tests. The `_write-delta.test.ts` (deferred from graph-provider in `TODOS.md`) covers the writer mechanics; the imap-sync orchestration is structurally identical to graph-sync and gmail-sync. **Tracked in TODOS.md.**
- Per-method happy paths for the IMAP adapter (see skip-list above). **Tracked in TODOS.md** for the post-eval pass.
- Auth.js `authorize` integration test — running it end-to-end requires a live IMAP server fixture and the Auth.js test harness. **Manual smoke covers it** at hand-off.

## Mocking strategy

- **imapflow**: mock at the module boundary. `vi.mock("imapflow", () => ({ ImapFlow: MockImapFlow }))` where `MockImapFlow` is a hand-rolled class implementing only the surface the adapter touches (`connect`, `noop`, `logout`, `mailboxOpen`, `fetch`, `messageMove`, `messageFlagsAdd`, `messageFlagsRemove`, `search`, `listTree`, `append`). The build agent decides the exact shape; the tests assert observable behavior (which methods were called with what args), not internals.
- **nodemailer**: mock the transport's `sendMail` and `verify`. Same module-boundary pattern.
- **`node:dns/promises`**: `vi.mock("node:dns/promises")` in the host-guard tests so we control resolution without real DNS.
- **No real network** in any test. The architectural rule in `CLAUDE.md` applies.
- **No tokens / passwords in test output.** Snapshots redact `password` strings. Test fixtures use obvious dummy passwords (`"test-app-pw"` not `"hunter2"`).

## E2E (Playwright)

**N/A in this spec.** Manual smoke at hand-off: a developer signs in with a real Yahoo or AOL app-password, sends themselves a test message from another account, watches it appear in the unified inbox within 60 seconds, archives it, confirms the archive reflects in their native Yahoo/AOL client. That's the validation gate.
