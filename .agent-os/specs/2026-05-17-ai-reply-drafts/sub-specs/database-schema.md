# Database Schema — AI Reply Drafts

**No schema changes in this spec.**

Accepted variants flow into the existing `Draft` row (created in the `compose-reply-forward` spec) through the composer's existing autosave path. When the user picks a variant from `<AIDraftPanel>`, the panel's `onPick(text)` callback converts the plain text to HTML and writes it into the composer's form state; the composer's debounced autosave fires `upsertDraft` shortly after, which updates the `Draft` row. From the DB's perspective the row is indistinguishable from a draft the user typed.

## Why no `AIDraft` table

An `AIDraft` table would let the user reopen previously-generated variants for a thread without paying for a new Anthropic call. Trade-offs:

- Storage cost: three strings up to ~16 KB total, per (user, thread, mode) tuple. Cheap.
- Generation cost: a Sonnet call with prompt-cached system block costs roughly $0.005–0.015 per draft request after warmup. Even an aggressive user generating drafts on 50 threads a day costs under $1/day.
- Invalidation: when does an `AIDraft` row become stale? When a new message lands on the thread (the reply should reference the new content)? When the user types over the variants and the panel forgets them?
- UX: a returning user expects either "I'll pick up where I left off" (the Draft row already gives them that) or "fresh ideas" (a regenerate). A persisted-but-stale set of three variants is the worst of both.

Given the costs are low and the invalidation rules are not obvious, **defer the table**. If a future spec finds the regeneration latency annoying enough to warrant caching, add the table then with the invalidation semantics that pattern reveals.

## What about the `Draft.bodyHtml`?

When the user accepts a variant, the AI-generated text overwrites whatever was in `Draft.bodyHtml`. The composer's existing behavior preserves the rest of the row (recipients, subject, attachments) — only the body is replaced. This matches the spec's user story about "AI draft overwrites composer content with confirmation."

## Out of scope (recap)

- `AIDraft` table — deferred per above.
- Postgres full-text-search on draft bodies — `deploy-vercel` spec.
- A field on `MailAccount` tracking "how many sent samples are available" — premature; the `loadSentSamples` helper returns an empty array when none exist, and the prompt handles that case.
