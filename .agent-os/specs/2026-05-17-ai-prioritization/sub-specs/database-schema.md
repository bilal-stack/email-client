# Database Schema — AI Prioritization

One new model. One migration. No changes to existing tables (except a back-relation on `Message`).

## Prisma addition

```prisma
model PriorityScore {
  id              String   @id @default(cuid())

  /// One score per message. Re-prioritization overwrites the row in place.
  messageId       String   @unique
  message         Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)

  /// 1 (noise) – 5 (urgent). Indexed for sort-by-priority queries.
  priority        Int

  /// ≤6 words, plain text (sanitized in `prioritizeMessage`). Surfaced as the
  /// row chip in the inbox.
  reason          String

  /// JSON array drawn from {"reply","archive","snooze","delegate"}.
  suggestedActions Json

  /// "phish" | "promo" | "ok". Drives the trust badge.
  riskFlag        String

  model           String
  promptVersion   String

  /// Same Anthropic `usage` shape as AISummary's usage field.
  usage           Json

  /// The serialized user payload sent to Haiku — supports a future "Show me
  /// the prompt"-style trust modal for prioritization. Not surfaced in this
  /// spec's UI, but stored so the modal can be added without re-running.
  userMessageJson String

  scoredAt        DateTime @default(now())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  /// Sort-by-priority query reads `priority` per scored message; the
  /// per-thread aggregation lives in `listThreadsForUser`. Indexing on
  /// (messageId) is already covered by the @unique.
  @@index([priority])
}
```

## Required `Message` back-relation

```prisma
model Message {
  // ... existing fields ...
  priorityScore PriorityScore?
}
```

Single optional back-relation; one score per message.

## Why this shape

- **`@unique` on `messageId`** — the upsert path in the Inngest function keys off this. Re-prioritization overwrites in place. The score row never accumulates duplicates.
- **`priority` as `Int`** — straightforward range query target (the `(priority)` index helps any future cross-thread "show me priority-5" filter). Per-thread aggregation runs in JS today, but a future migration to Postgres can switch to a SQL-side aggregation without schema change.
- **`reason` stored sanitized** — the Server Action / Inngest function runs `sanitizeReason` BEFORE the upsert. The DB row is the safe form; the UI renders it as a React text node with no further escaping required.
- **`suggestedActions` as `Json`** — bounded string array, ≤4 items. The enum constraint lives at the Zod boundary (`PrioritizeResultSchema`) not at the DB; SQLite has no array type, JSON is the practical choice.
- **`riskFlag` as `String`** — enum stored as text. Prisma's `String` accepts any UTF-8; the Zod schema enforces the closed set on the way in.
- **`userMessageJson` stored** — same pattern as `AISummary`. Lets a future "Show me the prompt" trust modal render without re-calling Haiku. Cost: ~5 KB per row. Cheap.
- **`onDelete: Cascade` from `Message`** — when a message is deleted (sync detects a server-side delete), its score goes with it. No orphans.
- **`(priority)` index** — supports any future "filter by priority" UX. Not currently used by `listThreadsForUser`, but cheap to add now.
- **No `userId` / `accountId` columns** — ownership flows through `Message.account.userId`. Same pattern as `AISummary`. A denormalized `userId` would be a query-perf nicety with no security gain.

## Migration

`npm db:migrate -- --name ai_prioritization`. SQLite migration: straightforward `CREATE TABLE` + index on `priority` + unique on `messageId`.

## Out of scope here

- `MessageActionLog` table for tracking user-applied actions (a future spec when snooze / delegate land).
- `ManualPriorityOverride` — out of scope per the spec's non-goals.
- Postgres full-text index on `reason` — `deploy-vercel` if at all.
