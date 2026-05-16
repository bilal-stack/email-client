# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation. Owning agent in brackets.

## 1. Prisma migration — `Draft` model — [`ui-builder`]
- Edit `prisma/schema.prisma` per `sub-specs/database-schema.md`.
- Add the `Draft` model with `@@unique([userId, threadId, mode])`.
- Run `npm db:migrate` and commit the migration alongside.
- **No other schema changes** in this spec. (No `MailAccount.signature`, no `Attachment` bytes column.)

## 2. Reply-headers + forward-quote builders (`lib/compose/headers.ts`) — [`ui-builder`]
- Pure functions. Export `buildReplyHeaders(parent: { providerMessageId: string; inReplyTo: string | null; references: string[] }) => { inReplyTo: string; references: string[] }` and `buildForwardQuote(parent: { from: CanonicalAddress; receivedAt: Date; subject: string; to: CanonicalAddress[]; bodyHtml: string | null; bodyText: string | null }) => string`.
- Subject helpers: `prefixReplySubject(s: string): string` and `prefixForwardSubject(s: string): string` (de-double-prefix per `spec.md` risk #4).
- Co-locate `headers.test.ts` (see `sub-specs/tests.md`).

## 3. Upload guard (`lib/compose/upload-guard.ts`) — [`ui-builder`]
- Pure function `validateAttachments(files: File[]): { ok: true; attachments: SendAttachment[] } | { ok: false; error: string }`.
- Hard caps: total bytes ≤ 25 MB; per-file MIME not in the deny list (see technical spec for the list); count ≤ 20 files.
- Reads each `File`'s bytes via `await file.arrayBuffer()` → `Buffer.from(...)` to produce `SendAttachment`.
- Co-locate `upload-guard.test.ts`.

## 4. Draft DB helpers (`lib/compose/draft-queries.ts`) — [`ui-builder`]
- `upsertDraftForUser(userId, input)`, `getDraftForUser(userId, { threadId?, mode })`, `getDraftByIdForUser(userId, id)`, `deleteDraftForUser(userId, id)`.
- All four queries scope by `userId`. Uses Prisma's `upsert` on the unique index for `upsertDraftForUser`.
- Co-locate `draft-queries.test.ts`.

## 5. Server Actions (`app/inbox/compose/actions.ts`) — [`ui-builder`]
- Implement `sendDraft`, `upsertDraft`, `discardDraft`, `getDraft` per `sub-specs/technical-spec.md`.
- Zod-validate every input. Resolve session via `auth()`; reject with `{ ok: false, error: "Unauthorized" }` on no session.
- `sendDraft`:
  1. Parse `FormData` → recipients (JSON-string fields), subject, body, mode, draftId, accountId, threadId?, inReplyTo?, references? (JSON).
  2. Run the body through `sanitizeEmailHtml` (defense-in-depth — see risk #6).
  3. Run `validateAttachments` on the `File[]` field.
  4. Look up `MailAccount` by `accountId` scoped to the user; reject if not owned.
  5. Construct `SendDraft`.
  6. `mode === "new"` → `provider.sendMessage(draft)`; otherwise `provider.reply(parentThreadProviderId, draft)`. Note: providers want the *provider* thread id, not the local `Thread.id` — load it via `prisma.thread.findUnique`.
  7. On success: `deleteDraftForUser(userId, draftId)` if `draftId` was passed; return `{ ok: true, data: { providerMessageId, providerThreadId } }`.
  8. On provider throw: return `{ ok: false, error }`; **do NOT delete the draft.**
- `upsertDraft`: thin wrapper over `upsertDraftForUser`. Returns `{ draftId, updatedAt }`.
- `discardDraft`: validate ownership before delete.
- `getDraft`: returns `DraftDTO | null` shaped for the composer's initial paint.

## 6. Composer client component (`app/inbox/_components/composer/composer.tsx`) — [`ui-builder`]
- `"use client"`. Props per `sub-specs/technical-spec.md` — `{ mode, accountId, accountOptions, initialDraft, threadId?, parentMessage? }`.
- State: `to`, `cc`, `bcc`, `subject`, `bodyHtml` (TipTap controlled), `attachments` (`File[]`), `draftId`, `saveStatus: "idle"|"saving"|"saved"|"error"`.
- Mounts `<TipTapEditor initialContent={initialDraft?.bodyHtml ?? parentMessage?.forwardQuote ?? ""} onUpdate={...} />`.
- Autosave: a `useEffect` with `setTimeout(2000)` on every state change calls `upsertDraft({...})`; clears the timeout on unmount or when a new change arrives.
- Send: wraps state into a `FormData`, attaches `File`s, calls `sendDraft(formData)`. On success calls `router.push(threadId ? \`/inbox/\${threadId}\` : "/inbox")`.
- Discard: calls `discardDraft({ draftId })`, then `router.push("/inbox")` (or back to the thread for reply/forward).

## 7. TipTap editor wrapper (`app/inbox/_components/composer/tiptap-editor.tsx`) — [`ui-builder`]
- Client component. Wraps `useEditor` from `@tiptap/react` with the extension list locked in `sub-specs/technical-spec.md`: `StarterKit`, `Link.configure({ openOnClick: false })`, `Placeholder.configure({ placeholder: "Write your message…" })`.
- **No `Image` extension** (attachments are separate).
- Props: `initialContent: string`, `onUpdate: (html: string) => void`.
- Add `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-link`, `@tiptap/extension-placeholder` to `package.json` (npm install runs in the build phase, not here).

## 8. Supporting composer subcomponents — [`ui-builder`]
- `recipients-input.tsx`, `account-picker.tsx`, `attachment-list.tsx`, `compose-action-bar.tsx` — all under `app/inbox/_components/composer/`.
- `recipients-input.tsx`: comma-separated text input; parses to `CanonicalAddress[]` on blur via the same regex used in `parseAddressList` (copy the regex into a `lib/compose/parse-addresses.ts` helper rather than importing from the Gmail adapter — keeps the dependency direction clean).
- `account-picker.tsx`: shadcn `Select`; `disabled` when `mode !== "new"`.
- `attachment-list.tsx`: hidden `<input type="file" multiple />`, chip list, per-chip remove. Runs `validateAttachments` client-side for fast feedback; server re-runs the same check.
- `compose-action-bar.tsx`: Send button (primary), Discard button (ghost), save-status badge.

## 9. `/inbox/compose/new/page.tsx` — [`ui-builder`]
- Server component. Reads `searchParams.accountId?`.
- Loads `MailAccount[]` for the signed-in user; picks `accountId` from search param OR most-recently-used (`orderBy: { lastSyncedAt: "desc" }`).
- Loads any existing `Draft` for `(userId, threadId=null, mode="new")` (note: composing fresh always upserts a single per-user "new compose" draft slot per the unique constraint).
- Renders `<Composer mode="new" accountId={selected} accountOptions={accounts} initialDraft={draft} />`.
- Co-locate `loading.tsx` and `error.tsx`.

## 10. `/inbox/[threadId]/reply/page.tsx` + `reply-all/page.tsx` + `forward/page.tsx` — [`ui-builder`]
- Three sibling routes, share most logic — factor into `app/inbox/[threadId]/_lib/load-parent.ts` (loads thread + latest message + checks ownership).
- Each page:
  1. Loads parent thread + latest message via the shared helper. `notFound()` if missing.
  2. Computes pre-fill from `buildReplyHeaders` / `buildForwardQuote` / address-list filtering.
  3. Loads any existing `Draft` for the slot `(userId, threadId, mode)`.
  4. Renders `<Composer mode={...} accountId={thread.accountId} accountOptions={[matching account]} initialDraft={draft} parentMessage={...} threadId={threadId} />`.
- Account picker is locked (disabled) — the reply must come from the same mailbox that received the thread.
- Co-locate `loading.tsx` / `error.tsx` / `not-found.tsx`.

## 11. Thread-view "Reply / Reply all / Forward" buttons — [`ui-builder`]
- Edit `app/inbox/[threadId]/_components/thread-view.tsx`. Add three `<Link>`s in the existing header.
- Reply-all rendered only when the latest message has more than one recipient (`(to.length + cc.length) > 1` after filtering the user's own address).
- **Only edit** to thread-view; no other behavior change.

## 12. Inbox-level Compose button — [`ui-builder`]
- New `app/inbox/_components/compose-button.tsx`. Floating button on `<md`, header button on `≥md`.
- Mount once in `app/inbox/layout.tsx`. Single-line edit to the layout.

## 13. Tests — [`test-author`]
- Per `sub-specs/tests.md`. Six concerns:
  1. Unit: `headers.ts` — reply-header chain construction, subject de-double-prefix, forward-quote HTML shape.
  2. Unit: `upload-guard.ts` — size cap, MIME deny list, count cap.
  3. Unit: `draft-queries.ts` — upsert idempotency on the unique key, ownership scoping, get-by-id ownership.
  4. Unit: Server Actions — happy paths + auth + ownership + provider-failure-preserves-draft.
  5. Unit: `parse-addresses.ts` — same fixtures as the Gmail adapter's parser.
  6. E2E (Playwright): scaffold scenarios with `test.fixme` (matching unified-inbox-ui — no test-only auth bypass yet).

## 14. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas:
  - Every `Draft` query scoped by `userId`.
  - Outbound HTML run through `sanitizeEmailHtml` before send.
  - `validateAttachments` enforces both size and MIME deny list **server-side**.
  - `sendDraft` rejects an `accountId` the user doesn't own.
  - Server Action inputs Zod-validated.
- On pass: bump `.claude/CURRENT_SPEC` to `.agent-os/specs/2026-05-XX-search-labels-archive-delete/spec.md` *(spec folder not yet authored — planner produces it next)*.
