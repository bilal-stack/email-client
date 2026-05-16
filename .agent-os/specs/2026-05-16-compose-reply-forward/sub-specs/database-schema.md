# Database Schema — Compose, Reply, Forward

## One new model: `Draft`

```prisma
// Persistent autosave slot for the composer. Source of truth lives on the
// server so a draft is resumable from any browser on any device. The
// `(userId, threadId, mode)` unique index gives us exactly one slot per:
//   - "new" compose (threadId = null) per user
//   - reply / reply-all / forward per (user, thread)
// Attempting to re-open the same slot reuses the row instead of creating a
// duplicate — same-tab autosave is straightforward upsert; cross-tab races
// resolve last-write-wins, which is documented in spec.md non-goals.
model Draft {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Which mailbox the user is composing from. The "new" compose mode lets the
  // user change this; reply / reply-all / forward modes lock it to the
  // mailbox that received the parent thread.
  accountId  String
  account    MailAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)

  // Thread context. NULL for "new" compose; set for the three reply variants.
  // Cascading delete on Thread is appropriate — if the thread is gone the
  // reply draft has nothing to reply to.
  threadId   String?
  thread     Thread?  @relation(fields: [threadId], references: [id], onDelete: Cascade)

  // Composer mode. SQLite doesn't have a native enum so this is a String;
  // the application validates against the four-value enum at the Zod layer.
  // "new" | "reply" | "reply-all" | "forward"
  mode       String

  // Recipients. JSON arrays of CanonicalAddress shape `{ name?, email }`.
  to         Json
  cc         Json
  bcc        Json

  subject    String
  bodyHtml   String   // TipTap-generated HTML, autosaved every 2s after typing stops

  // Reply-only — RFC 5322 header chain. JSON-string arrays so we can grow the
  // shape later without a migration. Both default to empty arrays when null
  // would be ambiguous.
  inReplyTo  Json     // string[]
  references Json     // string[]

  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  // Exactly one draft per (user, thread-slot, mode). For "new" compose,
  // threadId is null and SQLite/Prisma treats nulls as distinct in a unique
  // index — meaning a user can have at most one row with threadId IS NULL
  // and mode = "new" only if we keep the slot key tight. (Prisma 6 + SQLite:
  // multiple NULLs in a composite unique index are allowed by SQLite which
  // would let two "new compose" drafts coexist; we handle this in
  // `upsertDraftForUser` by treating threadId-null as a singleton via the
  // explicit upsert path.)
  @@unique([userId, threadId, mode])
  @@index([userId, updatedAt(sort: Desc)])
}
```

## `User` and `MailAccount` and `Thread` back-relations

Add to the existing models:

```prisma
model User {
  // ... existing fields ...
  drafts        Draft[]
}

model MailAccount {
  // ... existing fields ...
  drafts        Draft[]
}

model Thread {
  // ... existing fields ...
  drafts        Draft[]
}
```

These are required by Prisma when one side declares the FK; pure additive change.

## Migration

```bash
$env:DATABASE_URL = "file:./dev.db"   # PowerShell
npx prisma migrate dev --name add_drafts --skip-seed
```

The migration adds the `Draft` table + unique index + back-relations. No data migration needed (no existing drafts).

## SQLite null-in-composite-unique caveat

SQLite treats each NULL as distinct in a UNIQUE index. That means two `Draft` rows with `userId=U, threadId=NULL, mode="new"` could in principle coexist — the unique constraint *doesn't* enforce singleton "new compose" per user at the DB level.

We handle this at the application layer in `upsertDraftForUser`: for `threadId === null`, we look up the existing row by `(userId, mode)` first (ignoring threadId), update if found, insert if not. The unique index still buys us correctness for the much more common reply / reply-all / forward case (threadId set), where SQLite's behavior is correct.

Postgres (when we migrate for `deploy-vercel`) treats NULLs the same way, so no behavior change is needed across the swap.

## What's **not** in this spec's schema

- No `MailAccount.signature` column. Signature support is post-Phase-5.
- No `Attachment.bytes` column. Attachments still ride along with the `sendDraft` request body; the existing `Attachment` table (populated by inbound sync in `gmail-provider`) is read-only for this spec.
- No new fields on `Message` or `Thread`.
- No new indexes beyond the one on `Draft.updatedAt` (for "list my drafts by recency" — out of scope for the UI in this spec but cheap to add now).
