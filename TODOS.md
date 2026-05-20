# Deferred TODOs

Items surfaced during testing or audit that we deliberately deferred. Address after current-spec hand-testing is complete and before the eval submission is finalized. Each entry has the source file/line so it's findable later.

---

## Graph-provider hardening (security-reviewer nits from graph-provider)

- ~~**SSRF defense-in-depth on `syncCursor`.**~~ ✅ Resolved. `assertGraphCursorUrl` runs at the top of `syncDelta`'s incremental branch; rejects non-HTTPS / non-`graph.microsoft.com` URLs before the SDK call.
- ~~**`sanitizeCause` includes the full Graph error envelope.**~~ ✅ Resolved. `sanitizeCause` now projects `response.data.error` down to `{ code, message }` only; tenant ids, request ids, and other envelope fields are dropped from the attached cause.
- ~~**`AuthError.message` widens via Graph.**~~ ✅ Resolved. New `lib/providers/canonical-errors.ts` maps every `ProviderError` subtype to a fixed user-facing string (`AuthError` → "Please reconnect this account to continue.", `RateLimitError` → "Too many requests. Please wait a moment and try again.", etc.). Both `sendDraft` (`app/inbox/compose/actions.ts`) and `markThreadRead` (`app/inbox/actions.ts`) funnel through it. Tests assert no raw provider phrasing (tenant ids, hostnames, retry-after seconds) leaks to the public `error` field.

## Graph-provider tests — closed

All cases from `.agent-os/specs/2026-05-17-graph-provider/sub-specs/tests.md` are landed:

- `lib/providers/error-mapping.test.ts` — 410 / deltaLink branch.
- `lib/providers/auth.test.ts` — Microsoft refresh-token rotation persistence.
- `lib/providers/graph.test.ts` — `listThreads`, `getThread`, `setLabels`, `reply`, `search` (9 tests).
- `lib/providers/graph.syncDelta.test.ts` — cold start, incremental, attachment fanout, expired-delta (4 tests).
- `lib/providers/index.test.ts` — `"graph"` branch returns `GraphProvider`.
- `lib/inngest/functions/_write-delta.test.ts` — shared writer happy path, idempotency, empty delta (3 tests).
- `lib/inngest/functions/graph-sync.test.ts` — orchestration: provider-filter + `AuthError` propagation (2 tests).

**Still owed:** `lib/inngest/functions/gmail-sync.test.ts` — once gmail-sync gains its own orchestration assertions (provider-filter, SSE-emit gating), the three writer-mechanics tests there can be removed since `_write-delta.test.ts` now covers them. Not load-bearing today; deferred.

## Attachment download — explicitly deferred (out of MVP scope)

Inbound attachments currently render as **read-only chips** in the thread view (`app/inbox/[threadId]/_components/message-card.tsx`): filename, size, and MIME type are visible but there's no download button. The bytes were never persisted locally either — only `providerAttachmentId` lives on the `Attachment` row.

**Why deferred:** none of the mission success criteria (mission.md) or the roadmap phases (roadmap.md) call out attachment download as a required feature. The compose path supports *outbound* attachments (upload + send). Inbound download is the symmetric capability and a natural future feature, but it's net-new scope.

**What it would take when revived** (~5 files):

1. **`lib/providers/types.ts`** — add `downloadAttachment(messageId, attachmentId) → { bytes: Buffer; mimeType: string; filename: string }` to `IEmailProvider`.
2. **`lib/providers/gmail.ts`** — implement via `gmail.users.messages.attachments.get({ userId: "me", messageId, id })`; the response carries base64url-encoded bytes.
3. **`lib/providers/graph.ts`** — implement via `GET /me/messages/{messageId}/attachments/{id}/$value`; bytes come back raw.
4. **`lib/providers/imap.ts`** — implement via `imapflow.download(uid, partPath)`. **Blocked on a pre-existing IMAP TODO**: the current `providerAttachmentId` heuristic (`cid ?? index+1`) doesn't carry the BODYSTRUCTURE part path. See the IMAP follow-ups section below.
5. **`app/api/attachments/[messageId]/[attachmentId]/route.ts`** — new GET route handler. Session check → ownership check (`Message → Thread → MailAccount → userId`) → call `provider.downloadAttachment` → stream with `Content-Type` + `Content-Disposition: attachment; filename="..."`. Sanitize the filename for the header per the same rules as `sanitizeMimeFilename` in `lib/providers/gmail.ts`.
6. **`app/inbox/[threadId]/_components/message-card.tsx`** — swap the static `<span>` chips for `<a href="/api/attachments/${m.id}/${a.id}" download>` with a Download icon.

**Security notes when picked up:**
- Ownership check is mandatory: an unauthenticated or cross-user GET to the attachment route must 404 before any provider call.
- Strip `Content-Disposition` filename to ASCII-safe (RFC 5987 / `filename*=` for non-ASCII) so the response can't break out of the header.
- Sniff MIME on download against the stored `mimeType`; never trust attacker-controlled values blindly. Rendering inline (`Content-Disposition: inline`) is risky — force `attachment` so the browser always downloads.

## Compose hardening (security-reviewer nits from compose-reply-forward)

- **Client-side attachment guard doesn't mirror `MIME_DENY`.**
  `app/inbox/_components/composer/attachment-list.tsx` only checks the extension list, not the MIME deny set in `lib/compose/upload-guard.ts`. Server is authoritative, so this is UX-only — a user attaching `harmless.txt` with `application/x-msdownload` MIME would only see the error after pressing Send. Fix: export both deny sets from `upload-guard.ts` and import in the client component so the two lists can't drift.

- **`ProviderError.message` returned verbatim to the browser from `sendDraft`.**
  `app/inbox/compose/actions.ts:~241` returns `e.message` as-is when the provider throws. Fine today (Gmail adapter emits canonicalized strings like "Reconnect Google account"). When `graph-provider` / `imap-provider` land, audit their error messages — if any leak raw provider details, swap to a fixed allow-list of canonical user-facing messages.

- **MIME deny list could expand.**
  Current list covers `.ps1`, `.sh`, etc. via `EXT_DENY` but doesn't include MIMEs like `application/x-powershell`, `application/x-php`, `application/wasm`. The extension-based deny backstops the common cases; consider expanding both lists if the threat model widens (e.g. webshells via email).

## IMAP-provider hardening (security-reviewer nits from imap-provider)

- ~~**Pin minimum TLS version on IMAP/SMTP clients.**~~ ✅ Resolved. `tls: { minVersion: "TLSv1.2" }` passed to imapflow in both call sites (`lib/auth/index.ts` and `lib/providers/imap.ts`) and to nodemailer's `createTransport`.
- ~~**`NODE_ENV` read at module-load time in `imap-host-guard.ts`.**~~ ✅ Documented + handled. `lib/auth/imap-host-guard.test.ts` uses `vi.stubEnv("NODE_ENV", "production")` + `vi.resetModules()` before dynamic import per dev/prod case.

## Tests owed for the recent auth + inbox changes

The auth refactor and inbox-delete-invalidation work landed without
matching test updates per the user's "don't test/build, just edit"
instruction during testing. Once stabilized, write / update:

- `lib/auth/signin-callback.test.ts` — add cases for:
  - Cross-user `MailAccount` conflict (OAuth email belongs to a different
    `User` → returns `"/signin?error=AccountConflict"`).
  - The `waitForUserVisibility` 600 ms poll budget (mocks a delayed User
    write; asserts the poll succeeds within budget).
  - `allowDangerousEmailAccountLinking: true` integration test —
    confirm signing in with a second provider for the same email links
    to the existing User rather than throwing OAuthAccountNotLinked.

- `app/inbox/_components/thread-list-row.test.tsx` (NEW, if writing) —
  after `onArchive` / `onTrash` success the row disappears from the
  rendered list (verifies `queryClient.invalidateQueries` fires the
  refetch). Skip unless test-author capacity allows; manual smoke
  already covers it.

- `app/login/page.test.tsx`, `app/signup/page.test.tsx` — assert the
  two new pages render the three provider buttons and link to each
  other in the footer. Light-touch render tests.

- `app/signin/page.test.tsx` — regression: visiting without `?add=1`
  redirects (302) to `/login` if no session, `/inbox` if session.

Captured here, deferred until the auth flow is stable in manual
testing.

## Deploy-vercel — manual steps owed at deploy time

Not bugs, just user actions documented in `docs/deploy.md`:

- **The Postgres schema swap + migration regeneration is a one-time
  step on a `deploy` branch.** `main` stays SQLite-friendly so local
  dev / tests keep working without setup. See `docs/deploy.md` step 2
  for the exact edit-`schema.prisma` + `prisma migrate dev` flow.
- **First deploy requires Neon + Vercel + Inngest credentials**
  (steps 1, 3, 4 of `docs/deploy.md`). The 10-point smoke test in
  step 8 is the green-light gate.

## PWA offline follow-ups

- **Sign-out should call `clearQueued()` on the offline draft queue.**
  `lib/offline/draft-queue.ts` exposes `clearQueued()`. The Auth.js v5 sign-out flow currently runs through `signOut()` directly; no client-side hook fires `clearQueued()` first. Add a thin client wrapper around the sign-out button that runs `await clearQueued()` before invoking `signOut()` so a subsequent user on the same device doesn't inherit drafts. Out of pwa-offline lane (sign-out lives in `app/(auth)/`).

## IMAP-provider follow-ups

- **`changedMessages` / `deletedIds` always empty in `ImapProvider.syncDelta`.**
  `lib/providers/imap.ts` — UID-range polling can't see flag changes or
  deletions on already-known UIDs. Documented MVP gap in spec non-goals.
  Future fix: CONDSTORE/QRESYNC delta-by-modseq, or a periodic full-list
  comparison pass to detect deletions.

- **Out-of-order message arrival can split a thread.**
  `lib/providers/imap.ts` `resolveThreadId` — a child message that arrives
  before its parent (multi-fold delivery) gets its own thread; a later sync
  pass could re-link but does not. Documented in spec risk #5.

- ~~**`MailboxSecret` discriminated-union refactor surfaced typecheck breaks in
  existing test literals.**~~ ✅ Resolved. `auth.test.ts` now covers the IMAP-secret round-trip case + the legacy-no-`kind` backward-compat decode.

- **Attachment id heuristic in IMAP normalization.**
  `lib/providers/imap.ts` `normalizeFetchedMessage` uses `cid ?? index+1` as
  the attachment id. Technical-spec called out using imapflow's
  BODYSTRUCTURE part path (e.g. `"2.1"`); mailparser doesn't surface that
  directly. Acceptable for the MVP since the column is opaque, but revisit
  if a later spec (attachments-fetch) needs the actual part path to download
  bytes back via `client.download(partPath)`.

- **`getThread` issues one HEADER search per Message-ID hop.**
  `lib/providers/imap.ts` walks `In-Reply-To` / `References` with a search
  per id. The 50-message cap bounds the chatter but a single multi-id search
  via SearchObject would be cheaper. Defer until a real Yahoo/AOL mailbox
  shows the latency is user-visible.

---

## Explicitly **not** addressing (future watch-outs, out of scope for current submission)

- Tailwind v4 utility renames (`shadow-sm` → `shadow-xs`, `rounded-sm` → `rounded-xs`, etc.) — visual drift but no breakage.
- Tailwind v4 `outline-none` vs `outline-hidden` — both work; the existing `focus-visible:outline-none + focus-visible:ring-2` pattern preserves a11y.
- Next.js 16 deprecating `dynamic = "force-dynamic"` — we're on 15.x; the route segment config still applies.
- Microsoft Entra ID OAuth path is wired but never exercised end-to-end; first real test happens when `graph-provider` spec lands.
