# Deferred TODOs

Items surfaced during testing or audit that we deliberately deferred. Address after current-spec hand-testing is complete and before the eval submission is finalized. Each entry has the source file/line so it's findable later.

---

## Explicitly **not** addressing (future watch-outs, out of scope for current submission)

- Tailwind v4 utility renames (`shadow-sm` → `shadow-xs`, `rounded-sm` → `rounded-xs`, etc.) — visual drift but no breakage.
- Tailwind v4 `outline-none` vs `outline-hidden` — both work; the existing `focus-visible:outline-none + focus-visible:ring-2` pattern preserves a11y.
- Next.js 16 deprecating `dynamic = "force-dynamic"` — we're on 15.x; the route segment config still applies.
- Microsoft Entra ID OAuth path is wired but never exercised end-to-end; first real test happens when `graph-provider` spec lands.
