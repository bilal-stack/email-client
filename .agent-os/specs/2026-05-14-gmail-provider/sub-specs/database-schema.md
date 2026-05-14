# Database Schema — Gmail Provider

Adds the three core mail tables: `Thread`, `Message`, `Attachment`. SQLite-compatible in dev, Postgres-compatible in prod (the `Json` type maps to `JSONB` on Postgres and `TEXT`-with-JSON on SQLite via Prisma).

## Prisma additions

```prisma
model Thread {
  id            String      @id @default(cuid())
  accountId     String
  account       MailAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  // Native provider thread id (Gmail threadId, Graph conversationId, or IMAP-synthesized).
  // For Gmail in this spec, providerThreadId == Gmail's threadId.
  providerThreadId String
  subject       String
  lastMessageAt DateTime
  unreadCount   Int         @default(0)
  labels        Json        // string[] — provider label ids passed through
  participants  Json        // CanonicalAddress[]
  messages      Message[]
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  @@unique([accountId, providerThreadId])
  @@index([accountId, lastMessageAt(sort: Desc)])
}

model Message {
  id                  String      @id @default(cuid())
  threadId            String
  thread              Thread      @relation(fields: [threadId], references: [id], onDelete: Cascade)
  accountId           String
  account             MailAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  providerMessageId   String      // Gmail messageId
  providerThreadId    String      // denormalized for fast joins during sync writeback
  from                Json        // CanonicalAddress
  to                  Json        // CanonicalAddress[]
  cc                  Json        // CanonicalAddress[]
  bcc                 Json        // CanonicalAddress[]
  subject             String
  snippet             String
  bodyHtml            String?     // full HTML body; null when only text part exists
  bodyText            String?
  receivedAt          DateTime
  isUnread            Boolean     @default(false)
  labels              Json        // string[] — current provider label set
  inReplyTo           String?     // RFC 5322 Message-ID of parent, if any
  references          Json        // string[] — RFC 5322 References chain
  attachments         Attachment[]
  createdAt           DateTime    @default(now())
  updatedAt           DateTime    @updatedAt

  @@unique([accountId, providerMessageId])
  @@index([accountId, receivedAt(sort: Desc)])
  @@index([threadId, receivedAt(sort: Asc)])
}

model Attachment {
  id                    String   @id @default(cuid())
  messageId             String
  message               Message  @relation(fields: [messageId], references: [id], onDelete: Cascade)
  providerAttachmentId  String   // Gmail's attachmentId — fetch token, not a stable global id
  filename              String
  mimeType              String
  size                  Int
  // null until the user opens / downloads the attachment. Future spec lazy-fetches the bytes.
  fetchedAt             DateTime?
  // Bytes column held off until the lazy-fetch handler lands in a later spec.

  @@index([messageId])
}
```

## Required `MailAccount` back-relations

```prisma
model MailAccount {
  // ... existing fields ...
  threads   Thread[]
  messages  Message[]
}
```

Add these two lines to the existing `MailAccount` model; no other field changes.

## Why this shape

- **`(accountId, providerMessageId)` unique** — guarantees `createMany({ skipDuplicates: true })` is safe to retry. The same Gmail history window can replay without producing duplicates.
- **`(accountId, providerThreadId)` unique** on `Thread` — same logic for thread upsert during sync.
- **`(accountId, receivedAt DESC)` index** — drives the inbox-list query in the next spec.
- **`(threadId, receivedAt ASC)` index** — drives the thread-view query.
- **`Json` for `labels` / `participants` / address fields** — these are read as a unit, never queried by sub-field. JSON keeps the schema simple; an over-indexed normalized form would cost write throughput during sync without buying anything for the planned UI.
- **`bodyHtml` / `bodyText` nullable** — Gmail messages may have only one part type. The capping rule lives in the technical spec.
- **`Attachment.fetchedAt` nullable, no body bytes yet** — sync stores metadata only. Lazy fetch is a later spec.

## Migration

`npm db:migrate` generates `prisma/migrations/<timestamp>_gmail_provider/migration.sql`. Commit both the schema and the migration. SQLite migration: straightforward table creation. Verify the migration runs against an empty DB and against a DB seeded with a foundation-era `MailAccount` row.

## Out of scope here

- `AISummary`, `AIDraft`, `PriorityScore` — Phase 4 specs.
- Postgres full-text-search indexes on `bodyText` — added in `deploy-vercel`.
- Attachment body bytes — lazy fetch lands with the UI spec.
