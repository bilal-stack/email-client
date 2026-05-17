# Database Schema — AI Summaries

One new model. One migration. No changes to existing tables.

## Prisma addition

```prisma
model AISummary {
  id              String   @id @default(cuid())

  threadId        String   @unique
  thread          Thread   @relation(fields: [threadId], references: [id], onDelete: Cascade)

  /// Always populated — the one required field in the locked schema.
  tldr            String

  /// All three optional fields are nullable strings. The model omits them when
  /// the thread doesn't supply enough signal; the UI renders chips only for
  /// non-null fields.
  ask             String?
  decision        String?
  deadline        String?

  /// Model identifier at generation time (e.g. "claude-haiku-4-5-20251001").
  /// Captured so the "Show me the prompt" modal can display it accurately and
  /// so a future audit can correlate behavior shifts with model upgrades.
  model           String

  /// Key into `lib/ai/prompts/summary-registry.ts`. The registry retains every
  /// historical prompt version indefinitely so the trust modal can always
  /// render the prompt that produced any stored summary.
  promptVersion   String

  /// Raw Anthropic `usage` block:
  /// `{ input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }`.
  /// Stored as JSON; the modal pretty-prints it.
  usage           Json

  /// The serialized user payload that was sent to the model — subject,
  /// participants, last-N messages (each body wrapped in <email> tags,
  /// truncated to 2 KB). Shown in the trust modal so the user can see
  /// EXACTLY what was sent. Reasonably large (KBs); SQLite TEXT handles it.
  userMessageJson String

  /// When the summary was generated. Updated on successful regeneration via
  /// the upsert path in `summarizeThread`.
  generatedAt     DateTime @default(now())

  /// Set by the `writeDelta` invalidation hook when a new message lands on
  /// the thread. The next `summarizeThread` call sees `invalidatedAt != null`
  /// and regenerates, then resets this to null in the upsert.
  invalidatedAt   DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}
```

## Required Thread back-relation

```prisma
model Thread {
  // ... existing fields ...
  aiSummary AISummary?
}
```

Single optional back-relation; one summary per thread (the `@unique` on `threadId` enforces it).

## Why this shape

- **`@unique` on `threadId`** — one summary per thread. The Server Action's `upsert(where: { threadId })` relies on this. Regeneration overwrites the row in place; invalidation flips `invalidatedAt` but keeps the row (so the modal can still display the prior summary if the regeneration path fails).
- **All four content fields stored separately** (`tldr` / `ask` / `decision` / `deadline`) — NOT bundled into a JSON column. The UI renders each as its own chip; querying a single field is straightforward. This also makes a future "show me threads with a deadline this week" query feasible without JSON path operators.
- **`usage Json`** — the Anthropic `usage` shape may evolve (cache fields were added relatively recently). JSON keeps the column tolerant.
- **`userMessageJson String`** — kilobyte-scale text. SQLite TEXT handles it; Postgres `TEXT` is equivalent. Storing it means the trust modal renders without a second model call to reconstruct the payload.
- **`promptVersion` as a free-form string** — not an enum. New versions land in `SUMMARY_PROMPT_REGISTRY` as new keys; the column stores whatever key was active at generation time. The registry's persistence rule (never delete entries) is enforced by code review.
- **`onDelete: Cascade` from `Thread`** — when a thread is deleted (deleted-on-server, hard-deleted from our DB), its summary goes with it. No orphan rows.
- **No `accountId` column** — ownership flows through `Thread.account`, the same path the inbox queries use. A summary cannot be retrieved without joining `Thread`, which enforces the userId scope. Adding a denormalized `accountId` would be a query-perf nicety with no security gain.
- **No `invalidationReason` column** — invalidation is binary (a new message landed). We don't track which message triggered it; the `generatedAt` timestamp before/after a regeneration is enough audit trail.

## Migration

`npm db:migrate -- --name ai_summaries` generates `prisma/migrations/<timestamp>_ai_summaries/migration.sql`. Commit schema + migration together. SQLite migration: straightforward `CREATE TABLE` + index on the `@unique` constraint.

## Out of scope here

- `AIDraft` (Phase 4 `ai-reply-drafts` spec).
- `PriorityScore` (Phase 4 `ai-prioritization` spec).
- Postgres full-text indexes on summary fields — `deploy-vercel`.
- Per-user usage aggregation — out of scope; the `usage` column is for the modal, not for billing analytics.
