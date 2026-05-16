# Tests — Compose, Reply, Forward

`test-author` writes these alongside the build. `npm run test:run` (unit) must be green before this spec is marked done. Playwright e2e is scaffolded with `test.fixme` per the unified-inbox-ui precedent — no test-only auth bypass in production code.

## Unit (Vitest)

### `lib/compose/headers.test.ts`
- **`buildReplyHeaders`**:
  - When parent has both `inReplyTo` and `references`: returns `inReplyTo = parent.providerMessageId`, `references = [...parent.references, parent.providerMessageId]`.
  - When parent has only `inReplyTo` (no references): returns `references = [parent.inReplyTo, parent.providerMessageId]`.
  - When parent has neither: returns `references = [parent.providerMessageId]`.
  - `inReplyTo` is always exactly `parent.providerMessageId`.
- **`prefixReplySubject`**:
  - `"Hello"` → `"Re: Hello"`
  - `"Re: Hello"` → `"Re: Hello"` (no double prefix)
  - `"re: hello"` (lowercase) → `"Re: hello"`
  - `"RE:Hello"` (no space) → `"Re: Hello"`
  - `""` → `"Re:"` (graceful empty)
- **`prefixForwardSubject`**:
  - `"Update"` → `"Fwd: Update"`
  - `"Fwd: Update"` → `"Fwd: Update"`
  - `"FW: Update"` → `"Fwd: Update"`
  - `"forward: stuff"` → `"Fwd: stuff"`
- **`buildForwardQuote`**:
  - Emits a `<div>` with the boundary header text "Forwarded message"
  - Includes `<strong>From:</strong>`, `<strong>Date:</strong>`, `<strong>Subject:</strong>`, `<strong>To:</strong>`
  - Escapes `<`, `>`, `&`, `"`, `'` in subject + names (asserts via fixture: a sender named `Hacker <script>alert(1)</script>`)
  - Falls back to `<pre>{bodyText}</pre>` when `bodyHtml` is null
  - Returns a string starting with `<br><br>` so it concatenates safely with TipTap's prior content

### `lib/compose/upload-guard.test.ts`
- **Empty file list** → `{ ok: true, attachments: [] }`.
- **Single 1 MB plain text file** → `{ ok: true, attachments: [{ filename, mimeType, content: Buffer }] }`; `content.length === 1_048_576`.
- **Total > 25 MB across multiple files** → `{ ok: false, error: /25 MB/ }`.
- **More than 20 files** → `{ ok: false, error: /Too many/ }`.
- **MIME on the deny list** (`application/x-msdownload`) → `{ ok: false, error: /blocked file type/ }`.
- **Extension on the deny list** with innocent MIME (`.exe` with `application/octet-stream`) → `{ ok: false, error: /blocked extension/ }`.
- **Mixed:** 3 legitimate files + 1 denied → rejected at the denied file; no partial commit (returning early is the contract).
- **MIME missing** (`f.type === ""`) → accepted, stored as `application/octet-stream`.

### `lib/compose/parse-addresses.test.ts`
- `"alice@example.com"` → `[{ email: "alice@example.com" }]`
- `"Alice <alice@example.com>"` → `[{ name: "Alice", email: "alice@example.com" }]`
- `"alice@example.com, bob@example.com"` → 2 entries
- `"Alice <alice@example.com>, bob@example.com"` → 2 entries, names preserved correctly
- `""` (empty string) → `[]`
- `"not-an-email"` → `[]` (or surfaces error — pick one and lock it in the test)
- Trailing comma + whitespace tolerated
- Quoted names with embedded commas (`"Smith, Alice" <a@x.com>`) — single entry

### `lib/compose/draft-queries.test.ts`
- **`upsertDraftForUser`**:
  - First call creates a row with the given fields.
  - Second call with the same `(userId, threadId, mode)` updates the existing row's body + subject, leaves `createdAt` unchanged, advances `updatedAt`.
  - `threadId: null` + `mode: "new"`: two consecutive upserts produce ONE row (singleton handled in app code as noted in `database-schema.md`).
  - Different users with the same `threadId` + `mode` produce separate rows (ownership scoping).
- **`getDraftForUser`**:
  - Returns the row when the slot exists.
  - Returns `null` when no row exists.
  - Returns `null` for another user's draft even with matching threadId+mode.
- **`getDraftByIdForUser`**:
  - Returns the row when the id belongs to the user.
  - Returns `null` when the id belongs to a different user (ownership check).
- **`deleteDraftForUser`**:
  - Deletes the matching row.
  - Refuses to delete another user's row (count = 0 in `deleteMany`).

### `app/inbox/compose/actions.test.ts`
Server Action layer. All use a mocked Prisma + mocked `getProviderForAccount` returning a fake `IEmailProvider` (same `makeProvider` helper pattern as `app/inbox/actions.test.ts`).

- **`upsertDraft` — unauthorized**: `auth()` returns null → `{ ok: false, error: "Unauthorized" }`.
- **`upsertDraft` — happy path (new draft)**: creates a `Draft` row, returns `{ ok: true, data: { draftId, updatedAt } }`.
- **`upsertDraft` — happy path (existing draft)**: updates the existing row by `(userId, threadId, mode)`; `draftId` matches the existing row's id; `updatedAt` advances.
- **`upsertDraft` — invalid input**: bad email in `to` → `{ ok: false, error: "Invalid input" }`.
- **`upsertDraft` — accountId not owned by user**: rejects with `"Forbidden"` or `"Account not found"`.
- **`discardDraft` — happy path**: deletes the row, returns `{ ok: true }`.
- **`discardDraft` — ownership check**: passing another user's draftId → no row deleted, but action returns `{ ok: true }` (idempotent — matches `deleteMany`'s behavior).
- **`getDraft` — happy path**: returns the slot's row mapped to `DraftDTO`.
- **`getDraft` — not found**: returns `{ ok: true, data: null }`.
- **`sendDraft` — happy path (new compose)**: calls `provider.sendMessage` with the constructed `SendDraft`, returns `{ ok: true, data: { providerMessageId, providerThreadId } }`, deletes the draft row if `draftId` was passed.
- **`sendDraft` — happy path (reply)**: calls `provider.reply(providerThreadId, ...)`, NOT `sendMessage`.
- **`sendDraft` — outbound sanitization**: bodyHtml `<script>alert(1)</script><p>hi</p>` is passed to the adapter without the `<script>` tag (defense-in-depth check).
- **`sendDraft` — attachment too large**: returns `{ ok: false, error: /25 MB/ }`, provider NOT called.
- **`sendDraft` — denied MIME**: returns `{ ok: false, error: /blocked/ }`, provider NOT called.
- **`sendDraft` — accountId not owned**: rejects, provider NOT called.
- **`sendDraft` — provider throws `AuthError`**: returns `{ ok: false, error: <AuthError.message> }`; **draft row is NOT deleted** (verified by re-querying the row after the call).
- **`sendDraft` — provider throws `RateLimitError`**: same behavior — draft preserved.
- **`sendDraft` — invalid `mode` value**: Zod rejects.

## E2E (Playwright)

`tests/e2e/compose.spec.ts` — scaffolded with `test.fixme` since the test-only auth bypass still doesn't exist (matches the unified-inbox-ui convention). Each scenario named so the future fix-up is a straightforward `.fixme` → `.skip` → live conversion.

- `test.fixme("composer opens at /inbox/compose/new with empty fields and selected account")`
- `test.fixme("typing in the composer triggers autosave after 2s, save status flips to 'Saved'")`
- `test.fixme("clicking Reply from a thread pre-fills To and Subject")`
- `test.fixme("clicking Reply all includes all original recipients minus self")`
- `test.fixme("clicking Forward includes the quoted body and Fwd: subject")`
- `test.fixme("subject de-double-prefix: replying to 'Re: Hello' keeps 'Re: Hello'")`
- `test.fixme("attaching a .exe shows an inline error and Send remains disabled")`
- `test.fixme("attaching a 30 MB file shows a size-exceeded error")`
- `test.fixme("Send hits sendDraft, navigates to inbox/[threadId] on reply, /inbox on new")`
- `test.fixme("Discard deletes the draft and navigates away")`
- `test.fixme("Closing the tab and reopening the same route restores the draft")`
- `test.fixme("mobile viewport: composer fills the screen, fields stack vertically")`

## Mocking strategy

- **MSW**: not needed for this spec — no new HTTP calls. The existing Gmail adapter's MSW handlers are exercised via the unit tests only when the Server Action tests choose to wire through the real adapter (we don't — we mock `getProviderForAccount`).
- **Prisma**: real SQLite test DB (via the existing `tests/setup/global.ts` migration); seed users + accounts inside each test as needed (matches `lib/db/inbox-queries.test.ts` pattern).
- **Auth**: mock `@/lib/auth.auth` via `vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))` and resolve to a synthetic session per test.
- **TipTap**: NOT tested directly in unit tests. The composer's TipTap mount path runs only in the browser (jsdom doesn't fully support ProseMirror's selection model); we rely on the underlying state-handling tests instead. E2E `test.fixme`s cover the editor itself when the auth bypass lands.

## What's **not** tested

- TipTap's internal HTML output (covered by upstream TipTap tests).
- Provider HTTP behavior — already covered by `lib/providers/gmail.test.ts`.
- `sanitizeEmailHtml` itself — already covered by `lib/email-html/sanitize.test.ts`. We rely on the fact that the same function is invoked inside `sendDraft`.
