# Database Schema — Foundation

Initial Prisma schema. Includes Auth.js's required models plus our `MailAccount` extension. Thread / Message / AI tables come in later specs.

```prisma
datasource db { provider = "sqlite"; url = env("DATABASE_URL") }
generator client { provider = "prisma-client-js" }

// ─── Auth.js v5 + Prisma adapter required models ──────────────────────────
model User {
  id            String        @id @default(cuid())
  name          String?
  email         String?       @unique
  emailVerified DateTime?
  image         String?
  accounts      Account[]
  sessions      Session[]
  mailAccounts  MailAccount[]
  createdAt     DateTime      @default(now())
}

model Account {
  id                String   @id @default(cuid())
  userId            String
  type              String
  provider          String
  providerAccountId String
  refresh_token     String?
  access_token      String?
  expires_at        Int?
  token_type        String?
  scope             String?
  id_token          String?
  session_state     String?
  user              User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Session {
  id           String   @id @default(cuid())
  sessionToken String   @unique
  userId       String
  expires      DateTime
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model VerificationToken {
  identifier String
  token      String   @unique
  expires    DateTime
  @@unique([identifier, token])
}

// ─── Our extension ────────────────────────────────────────────────────────
model MailAccount {
  id              String    @id @default(cuid())
  userId          String
  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider        String    // "gmail" | "graph" | "imap"
  emailAddress    String
  displayName     String?
  // Encrypted blob (AES-256-GCM) holding tokens (OAuth) or password (IMAP).
  encryptedSecret Bytes
  secretIv        Bytes
  secretTag       Bytes
  // Per-provider sync cursor: Gmail historyId, Graph delta token, IMAP UIDVALIDITY+UID.
  syncCursor      String?
  lastSyncedAt    DateTime?
  createdAt       DateTime  @default(now())
  @@unique([userId, provider, emailAddress])
}
```

## Why this shape
- **Auth.js's `Account` row** holds the *current* OAuth session for Auth.js's own use (refresh token rotation, sign-in). It is not our source of truth for mailbox access.
- **`MailAccount`** is our source of truth — encrypted, separate from session lifecycle, and survives Auth.js token rotations. It also holds the sync cursor.
- **Tokens never decrypt at rest.** They're decrypted only inside `lib/providers/auth.ts` when an adapter needs to make a call, then re-encrypted on refresh.

## Out of scope here
- `Thread`, `Message`, `AISummary`, `AIDraft`, `PriorityScore` — added by their respective specs.
- Postgres-specific tweaks (citext, full-text search) — added during `deploy-vercel`.
