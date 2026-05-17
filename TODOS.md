# Deferred TODOs

Items surfaced during testing or audit that we deliberately deferred. Address after current-spec hand-testing is complete and before the eval submission is finalized. Each entry has the source file/line so it's findable later.

---

## Graph-provider hardening (security-reviewer nits from graph-provider)

- **SSRF defense-in-depth on `syncCursor`.**
  `lib/providers/graph.ts` — incremental branch of `syncDelta` reads `cursor` from the DB and hands it verbatim to `client.api(cursor).get()`. Today the only writer is `_write-delta.ts` storing Graph-returned URLs, so practical exposure is low. Harden by asserting `new URL(cursor).hostname === "graph.microsoft.com"` at the top of the incremental branch before reuse. Spec's risk #4-ish area; reviewer flagged it under checklist item 7 (SSRF).

- **`sanitizeCause` includes the full Graph error envelope.**
  `lib/providers/error-mapping.ts` `sanitizeCause` strips circular refs but keeps `responseData` — which on Graph errors carries tenant id, request id, and user-readable details. Correct per the spec's gating (it only travels on `Error.cause`, never returned to the browser), but unbounded. A future caller that ever spreads `error.cause` into a Server Action would leak. Mitigation: explicitly project to `{ code, message }` only when serializing — drop the rest of `responseData` defensively.

- **`AuthError.message` widens via Graph.**
  Pre-existing TODO below (`ProviderError.message returned verbatim…`) anticipated this. **Confirmed by graph-provider review**: Graph's `pickMessage` returns the raw Graph envelope message, which can carry tenant flavor on 401s. Action remains the same: swap `sendDraft`'s pass-through of `e.message` to a fixed allow-list of canonical user-facing strings. Now actually load-bearing rather than speculative.

## Graph-provider tests deferred (will be written tonight)

`.agent-os/specs/2026-05-17-graph-provider/sub-specs/tests.md` lists ~6 test files / ~25 cases. We shipped a subset under time pressure for the eval; what landed and what's outstanding:

**Landed:**
- `lib/providers/error-mapping.test.ts` — extended for the 410 / deltaLink branch.
- `lib/providers/auth.test.ts` — extended for Microsoft refresh-token rotation persistence.
- `lib/providers/graph.test.ts` — happy-path coverage of `listThreads`, `getThread`, `setLabels`, `reply`, `search`. (9 tests.)
- `lib/providers/graph.syncDelta.test.ts` — cold start, incremental, attachment fanout, expired-delta. (4 tests.)
- `lib/providers/index.test.ts` — `"graph"` branch returns `GraphProvider`.

**Still owed per the menu:**
- `lib/inngest/functions/_write-delta.test.ts` — the extracted shared writer (idempotency, happy path). The writer is exercised transitively by the gmail-sync tests today, but a focused unit would catch a regression earlier.
- `lib/inngest/functions/graph-sync.test.ts` — orchestration: provider-filter (`"graph"` only), SSE emit on success, no cursor advance on `AuthError`.
- `lib/inngest/functions/gmail-sync.test.ts` — trim the writer-mechanics assertions that now belong to `_write-delta.test.ts`. Currently the file still asserts internals that moved; not broken, but redundant.

## Compose hardening (security-reviewer nits from compose-reply-forward)

- **Client-side attachment guard doesn't mirror `MIME_DENY`.**
  `app/inbox/_components/composer/attachment-list.tsx` only checks the extension list, not the MIME deny set in `lib/compose/upload-guard.ts`. Server is authoritative, so this is UX-only — a user attaching `harmless.txt` with `application/x-msdownload` MIME would only see the error after pressing Send. Fix: export both deny sets from `upload-guard.ts` and import in the client component so the two lists can't drift.

- **`ProviderError.message` returned verbatim to the browser from `sendDraft`.**
  `app/inbox/compose/actions.ts:~241` returns `e.message` as-is when the provider throws. Fine today (Gmail adapter emits canonicalized strings like "Reconnect Google account"). When `graph-provider` / `imap-provider` land, audit their error messages — if any leak raw provider details, swap to a fixed allow-list of canonical user-facing messages.

- **MIME deny list could expand.**
  Current list covers `.ps1`, `.sh`, etc. via `EXT_DENY` but doesn't include MIMEs like `application/x-powershell`, `application/x-php`, `application/wasm`. The extension-based deny backstops the common cases; consider expanding both lists if the threat model widens (e.g. webshells via email).

---

## Explicitly **not** addressing (future watch-outs, out of scope for current submission)

- Tailwind v4 utility renames (`shadow-sm` → `shadow-xs`, `rounded-sm` → `rounded-xs`, etc.) — visual drift but no breakage.
- Tailwind v4 `outline-none` vs `outline-hidden` — both work; the existing `focus-visible:outline-none + focus-visible:ring-2` pattern preserves a11y.
- Next.js 16 deprecating `dynamic = "force-dynamic"` — we're on 15.x; the route segment config still applies.
- Microsoft Entra ID OAuth path is wired but never exercised end-to-end; first real test happens when `graph-provider` spec lands.
