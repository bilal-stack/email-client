# Compose, Reply, Forward

## Goal
Ship the first user-visible write surface. After this spec lands, a signed-in user can compose a new email, reply, reply-all, or forward from `/inbox` with a TipTap rich-text editor, attach files (size and MIME-guarded server-side), pick which connected mailbox to send from, and watch the message hand off through `IEmailProvider.sendMessage` / `reply` to Gmail (the only adapter wired today; Graph and IMAP slot in later). While the user types, the composer autosaves to a new `Draft` row in the DB (debounced 2 s after the last keystroke) so the same draft is resumable from any browser on any device — the source of truth is the server, not the tab. The thread view gains a "Reply" button that opens the composer in the same route group; the inbox gains a top-level "Compose" affordance. Provider-agnostic: the composer, the Server Actions, and the upload guard all consume the canonical `SendDraft` / `SendAttachment` shapes — adapter-specific MIME assembly already lives inside `GmailProvider.sendMessage` / `reply` and does not change here.

## User stories
1. **As a signed-in user**, I click "Compose" on `/inbox` and arrive at `/inbox/compose/new`. A TipTap rich-text editor opens with empty To / Cc / Bcc / Subject / body fields and an account picker pre-selected to my most-recently-used mailbox.
2. **As a user with multiple connected mailboxes**, the account picker in the composer shows one option per `MailAccount` row I own; the selection drives which adapter handles the send.
3. **As a user reading a thread at `/inbox/[threadId]`**, I click "Reply" and arrive at `/inbox/[threadId]/reply`. The composer is pre-filled with **To** = the latest message's `from`, **Subject** = `Re: <original>` (no double-prefix if it already starts with `Re:`), and the parent message's `Message-ID` lives in the hidden `inReplyTo` field while the parent's `References` chain plus that `Message-ID` lives in the hidden `references` field. The account picker is locked to the mailbox that received the thread.
4. **As a user**, I click "Reply all" and the composer pre-fills exactly like reply, except **To** = original sender plus all original `to` recipients (minus my own mailbox address), and **Cc** = the original `cc` (minus my own mailbox address).
5. **As a user**, I click "Forward" and arrive at `/inbox/[threadId]/forward`. The composer is pre-filled with **Subject** = `Fwd: <original>` (no double-prefix), **To** = blank, and the editor's initial content is the original message's HTML body prefixed with a `---------- Forwarded message ----------` header block listing the original `From / Date / Subject / To`.
6. **As a user typing in any of the four composer modes**, my work autosaves silently to a `Draft` row every 2 s after I stop typing. Closing the tab and reopening the same route restores my draft (e.g. revisiting `/inbox/[threadId]/reply` re-hydrates the in-progress reply).
7. **As a user**, I can attach files via a file input. Each attachment shows as a chip with filename + human-readable size. The server rejects (per-request) any single attachment whose MIME type is on the deny list (executables, scripts) and any request whose total size exceeds 25 MB.
8. **As a user**, I click "Send" and the composer hands off `SendDraft` (with `SendAttachment[]` carrying the just-uploaded bytes) to a Server Action. On success the route navigates to `/inbox/[threadId]` for replies / forwards (the existing thread will receive the new message on the next sync) or `/inbox` for new compose, and the `Draft` row is deleted.
9. **As a user**, I can click "Discard" to delete the current draft and navigate away with no send.
10. **As a build agent (`ui-builder`)**, the composer routes and Server Actions I implement consume the canonical `SendDraft` shape — no `if (provider === "gmail")` branch lives in `app/inbox/compose/**` or `app/inbox/[threadId]/(reply|reply-all|forward)/**`.

## Non-goals
- **No AI features.** No "draft this for me", no tone-matched suggestions, no inline summary. Those land in the `ai-reply-drafts` and `ai-summaries` specs (Phase 4). Do **not** pre-wire hooks or placeholders in the composer.
- **No offline draft queue with IndexedDB replay.** The draft store is the DB only; no service-worker queue, no resend-on-reconnect-from-the-browser logic. That lands in `pwa-offline`.
- **No recipient autocomplete.** To / Cc / Bcc are plain comma-separated text inputs validated as RFC 5322 addresses on the client; we do not query a contacts directory.
- **No scheduled send / send later.** Not on the roadmap; do not add the field, do not add the Inngest job.
- **No bulk forward and no forward-as-attachment.** Forward attaches the original body as quoted HTML only.
- **No long-lived attachment storage.** Bytes ride along with the `sendDraft` form submission; no S3, no Vercel Blob, no DB column for attachment bytes. See `sub-specs/technical-spec.md` "Attachment upload mechanism" for the trade-off.
- **No inline image paste / drag-drop into the editor.** The TipTap config deliberately excludes the Image extension; images attach via the file input only. Nice-to-have for a follow-up spec; not blocking.
- **No real-time draft sync across two open tabs of the same draft.** Because the draft is a DB row, opening a second tab will load whatever was last autosaved; we do not push subsequent autosaves to the other tab. (No SSE for draft updates.) The user is expected not to edit the same draft in two tabs simultaneously.
- **No "send and archive" / "send and mark done" combo button.** Send only.
- **No signature editor.** A signature column is not added to `MailAccount` here; signature support is a stretch goal post-Phase-5.
- **No CC / BCC autocomplete from prior thread participants.** Same reasoning as recipient autocomplete.
- **No conflict resolution if two devices autosave the same draft slot concurrently.** Last-write-wins on the `(userId, threadId, mode)` unique constraint. Acceptable for MVP.
- **No "discard draft" confirmation dialog.** One click, gone. (Drafts are still in the DB until explicitly discarded or sent; closing a tab without clicking discard preserves the draft.)

## In-scope surfaces

### Routes
- **`/inbox/compose/new`** (server component) — renders the composer in `mode: "new"`. Reads `?accountId=` from search params (optional; defaults to most-recently-used). Renders a blank `<Composer />`.
- **`/inbox/[threadId]/reply`** (server component) — renders the composer in `mode: "reply"`. Loads the parent thread + latest message to derive `to`, `subject`, `inReplyTo`, `references`, and the locked `accountId`.
- **`/inbox/[threadId]/reply-all`** (server component) — same as reply but with the full recipient list pre-filled (minus the signed-in user's own mailbox address).
- **`/inbox/[threadId]/forward`** (server component) — renders the composer in `mode: "forward"` with the quoted original body as `initialBody`.

All four routes share `app/inbox/_components/composer.tsx` (client component). On ≥768 px they render as the right pane of the same split layout as the thread view (no thread visible behind compose-new; thread visible behind reply/forward routes for context).

### Server Actions (`app/inbox/compose/actions.ts`)
```ts
sendDraft(input: SendDraftInput, formData: FormData)
  : Promise<{ ok: true; data: { providerMessageId: string; providerThreadId: string } } | { ok: false; error: string }>

upsertDraft(input: UpsertDraftInput)
  : Promise<{ ok: true; data: { draftId: string; updatedAt: Date } } | { ok: false; error: string }>

discardDraft(input: { draftId: string })
  : Promise<{ ok: true } | { ok: false; error: string }>

getDraft(input: { userId-implicit; threadId?: string; mode: DraftMode })
  : Promise<{ ok: true; data: DraftDTO | null } | { ok: false; error: string }>
```

`sendDraft` is the only action that takes a `FormData` — the attachments are a `File[]` field. The other three are plain JSON. Exact Zod-validated shapes live in `sub-specs/technical-spec.md`.

### Components (`app/inbox/_components/composer/`)
- **`composer.tsx`** (client) — orchestrates the editor + recipient inputs + account picker + attachment list + send/discard buttons. Wires autosave.
- **`tiptap-editor.tsx`** (client) — TipTap `EditorContent` with the locked-down extension set (see technical spec). Emits HTML via `onUpdate`.
- **`recipients-input.tsx`** (client) — comma-separated text input for To / Cc / Bcc with client-side RFC 5322 parse + chip rendering.
- **`account-picker.tsx`** (client) — `<Select>` of the user's `MailAccount` rows. Locked (disabled) in reply / reply-all / forward modes.
- **`attachment-list.tsx`** (client) — file input + chip list + remove button per attachment. Validates size + MIME client-side as a courtesy; server re-validates.
- **`compose-action-bar.tsx`** (client) — Send / Discard / autosave status indicator ("Saved 3 s ago" / "Saving…").

### Thread-view affordance (one edit outside `app/inbox/compose/**`)
- **`app/inbox/[threadId]/_components/thread-view.tsx`** — add three buttons in the header: "Reply" → `Link href="/inbox/[threadId]/reply"`; "Reply all" → `…/reply-all` (rendered only when the latest message has >1 recipient); "Forward" → `…/forward`. No other change to thread-view. This is the **only edit outside the new compose routes** the `ui-builder` agent makes for this spec.

### Inbox-level affordance
- **`app/inbox/_components/compose-button.tsx`** (client) — floating action button (mobile) / header button (desktop). Links to `/inbox/compose/new`. Mounted in the existing `app/inbox/layout.tsx` shell. This is the **second small edit** to existing files.

### Library additions
- **`lib/compose/headers.ts`** — pure functions `buildReplyHeaders(parent: Message) => { inReplyTo, references }` and `buildForwardQuote(parent: Message) => string` (HTML). Unit-tested without touching the DB or TipTap.
- **`lib/compose/upload-guard.ts`** — exports `validateAttachments(files: File[]): { ok: true; attachments: SendAttachment[] } | { ok: false; error: string }`. Enforces the 25 MB cap and the MIME deny list. Used inside `sendDraft`.
- **`lib/compose/draft-queries.ts`** — `upsertDraftForUser`, `getDraftForUser`, `deleteDraftForUser` — thin Prisma wrappers used by both the Server Actions and the route's initial-paint loader.

## Risks / open questions

1. **Autosave thrash on every keystroke.** *Mitigation:* debounced 2 s after last `onUpdate`; the indicator shows "Saving…" only while a request is in flight. We do not autosave on every diff. The `upsertDraft` action is also idempotent against the `(userId, threadId, mode)` unique constraint — duplicate races resolve cleanly.
2. **Attachment bytes in memory.** A 25 MB request body parses into Node `Buffer`s in the Server Action runtime; Vercel's serverless functions have a 50 MB request body limit on the Pro tier. *Mitigation:* the 25 MB cap is comfortably under the platform ceiling; Buffer lifetime is bounded by the request, which Next.js's runtime cleans up on return. *Trade-off documented:* in exchange for not provisioning object storage, the user can't upload a 100 MB video. Acceptable for an evaluation deliverable; Gmail's send limit is the same 25 MB so we're not under-shooting providers.
3. **Reply-all may include the user's own address.** *Mitigation:* the action filters the user's `MailAccount.emailAddress` out of both `to` and `cc` before pre-filling. Edge: a user who replies to a message they themselves sent will see To = empty after the filter — acceptable; they can type a recipient.
4. **Subject de-double-prefix.** *Decision (not open):* strip a leading `Re: ` (case-insensitive, with optional trailing whitespace, also recognizing the localized `Aw: ` prefix? — **no, English-only for MVP**) before re-prefixing. Same rule for `Fwd: ` (also recognizes `FW: `).
5. **TipTap server-side rendering.** TipTap is a client-only editor (it depends on `prosemirror` and a real DOM). *Mitigation:* `composer.tsx` is `"use client"`; routes that host it render only the layout shell on the server. The TipTap editor mounts inside a `useEffect` to avoid hydration mismatch.
6. **HTML output sanitization on the *outbound* side.** TipTap with our locked extension set cannot emit `<script>`. *Decision (not open):* we still pass the editor's `getHTML()` output through DOMPurify with the **same allow-list as `sanitizeEmailHtml`** before assembling the `SendDraft`. Defense-in-depth: prevents a TipTap extension upgrade from sneaking an unsafe tag past us.
7. **Same draft opened in two tabs.** *Decision (not open):* last-write-wins on the unique constraint. No SSE for drafts (we documented this in non-goals). If we ever observe user pain, revisit in a follow-up.
8. **Forward quote and large bodies.** Pre-filling a 500 KB original-body HTML as `initialBody` for forward is fine in TipTap (ProseMirror handles big documents) but the autosave payload will be large. *Mitigation:* the autosave debounce + the 25 MB request cap apply; the `Draft.bodyHtml` column is `String` (SQLite TEXT) and handles MB-range fine.
9. **CSRF on Server Actions.** Next.js Server Actions are CSRF-protected by the framework's encrypted action ids. *No additional mitigation needed*, just calling it out so the security-reviewer doesn't add belt-and-braces.
10. **Provider hand-off on send failure.** If `GmailProvider.sendMessage` throws (e.g. `AuthError`, `RateLimitError`), the `Draft` row must survive so the user can retry. *Mitigation:* `sendDraft` only calls `discardDraftForUser` after `provider.sendMessage` resolves; on throw we return `{ ok: false, error }` and leave the draft intact.

## Definition of done
- [ ] `/inbox/compose/new` renders the composer with TipTap, account picker pre-selected, autosave debounced to 2 s, send hits `GmailProvider.sendMessage`, draft row deleted on success.
- [ ] `/inbox/[threadId]/reply` and `…/reply-all` and `…/forward` render the composer with the right pre-fill rules; locked account picker; `inReplyTo` and `References` propagate into the outbound `SendDraft`.
- [ ] Thread view header shows "Reply" / "Reply all" / "Forward" buttons that link to the three routes; reply-all hidden when only one recipient.
- [ ] Inbox layout shows a "Compose" button linking to `/inbox/compose/new`.
- [ ] Attachment list accepts files, enforces 25 MB total + MIME deny list **on the server** (client validation is a courtesy); rejected attachments show an inline error.
- [ ] `Draft` table migrated with `(userId, threadId, mode)` unique index; `upsertDraft` is idempotent on that key.
- [ ] All four routes restore from an existing `Draft` row when one matches the slot.
- [ ] All unit tests in `sub-specs/tests.md` pass under `npm test:run`.
- [ ] Playwright e2e scenarios in `sub-specs/tests.md` are scaffolded with `test.fixme` (matching the unified-inbox-ui convention — no test-only auth bypass yet).
- [ ] No provider SDK import inside `app/inbox/compose/**` or `app/inbox/[threadId]/(reply|reply-all|forward)/**`. No `if (provider === ...)` branch anywhere in the composer code.
- [ ] `security-reviewer` has signed off on: outbound HTML sanitization, attachment MIME deny list, attachment size guard, draft ownership scoping (every `Draft` query is `WHERE userId = session.user.id`), Server Action input validation.
- [ ] `.claude/CURRENT_SPEC` advanced to `.agent-os/specs/2026-05-16-compose-reply-forward/spec.md` and then to `search-labels-archive-delete` on hand-off.
