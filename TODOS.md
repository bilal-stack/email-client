# Deferred TODOs

Items surfaced during testing or audit that we deliberately deferred. Address after current-spec hand-testing is complete and before the eval submission is finalized. Each entry has the source file/line so it's findable later.

---

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
