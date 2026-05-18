# Database Schema — Deploy to Vercel

The Prisma model definitions **do not change** in this spec — every model from foundation through `ai-prioritization` stays as authored. What changes is the **datasource provider** and the **generated migration SQL**.

## Provider swap

```prisma
// prisma/schema.prisma — datasource block change
datasource db {
  provider  = "postgresql"   // was "sqlite"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")  // NEW — used by prisma migrate against Neon's un-pooled connection
}
```

## Column-type mapping

Prisma normalizes the model-level types across providers; only the generated SQL changes:

| Prisma type | SQLite (pre-deploy) | Postgres (this spec) |
|---|---|---|
| `String` | `TEXT` | `TEXT` |
| `Int` | `INTEGER` | `INTEGER` |
| `Boolean` | `INTEGER` (0/1) | `BOOLEAN` |
| `DateTime` | `DATETIME` | `TIMESTAMP(3)` |
| `Bytes` | `BLOB` | `BYTEA` |
| `Json` | `TEXT` (JSON-shaped) | `JSONB` |

Application code does not branch on the underlying SQL type — Prisma's client API surface is identical. The encrypted-secret round-trip (`MailAccount.encryptedSecret/secretIv/secretTag`) continues to work because `Buffer` ↔ `BYTEA` is one-to-one. The `Json` columns (`Thread.labels`, `Thread.participants`, `Message.from/to/cc/bcc/labels/references`, `Draft.to/cc/bcc/inReplyTo/references`, `AISummary.usage`, `PriorityScore.suggestedActions/usage`) deserialize as objects on Postgres exactly as they did on SQLite.

## Migration directory layout

Before this spec, `prisma/migrations/` contained SQLite-generated migrations:
```
20260514_foundation/
20260514_gmail_provider/
... (and so on)
20260518_ai_prioritization/
```

After this spec:
```
prisma/migrations/                          ← Postgres migrations (used by prod)
  20260518_postgres_init/migration.sql      ← single migration creating every table

prisma/migrations-sqlite-historical/        ← committed for reference only
  20260514_foundation/
  ...                                       ← the historical SQLite migration trail
```

The SQLite historical tree stays committed because it documents the schema's evolution across the eval. Neither dev (now on Postgres too — see below) nor prod uses it.

## Local development implications

Two options for dev workflow post-deploy:

**Option A (recommended): Docker Postgres for local dev too.** Add a `docker-compose.yml` with `postgres:16` + `npm run db:up` script. Dev `DATABASE_URL` becomes `postgres://postgres:dev@localhost:5432/postgres?sslmode=disable`. `prisma migrate dev` and `prisma migrate deploy` both work locally. Tests run against the local Postgres.

**Option B: Keep SQLite for dev, Postgres for prod.** Maintains the foundation's "no setup friction" stance. Requires juggling two Prisma migration trees: dev needs SQLite migrations, prod needs Postgres. Prisma supports per-environment provider with multi-schema files (`schema.dev.prisma` + `schema.prisma`), but this adds complexity.

**The runbook recommends Option A.** Docker is a one-time install; the dev DX gains are: identical column types between dev and prod, no surprises during smoke test, tests exercise the same engine that production uses. The cost is `npm run db:up` before tests. Document the trade in `docs/deploy.md`.

If Option A is too invasive for the eval timeline, fall back to Option B with explicit documentation that `npm test:run` requires Postgres OR the test runner uses `@prisma/adapter-pglite` for an in-memory Postgres at test time. PGlite is a recent option worth considering for a future spec; out of scope here.

## Neon-specific notes

- **Default region**: `us-east-2` (Ohio). Vercel `iad1` is Virginia — same network neighborhood; expected latency between them is sub-50ms.
- **Connection limits on free tier**: 100 concurrent. The pooled URL handles this transparently; serverless functions don't hold connections beyond a single request.
- **Branching**: Neon supports DB branches (similar to git branches). Out of scope; the eval uses a single prod branch.
- **Backups**: Neon free tier includes 7 days of point-in-time recovery. The runbook mentions this for reassurance; nothing to configure.

## Smoke-test column verification (post-deploy)

The runbook's smoke test implicitly verifies every column type maps correctly:
- Sign-in → `MailAccount.encryptedSecret` (BYTEA) round-trips. The next sync uses the decrypted token; if BYTEA decode were broken, sync would fail with an auth error.
- New message arrives → `Message.from / to / labels` (JSONB) populated. Inbox list renders → JSON parsing works.
- AI summary generates → `AISummary.usage` (JSONB) populated. Modal renders → object shape preserved.
- Priority assigned → `PriorityScore.suggestedActions` (JSONB) → row chip renders.

If any of these surface as broken in production, the failure mode is loud (UI error or sync run failure in Inngest's dashboard), not silent.

## Out of scope here

- New tables / columns — this spec does not add or modify any model.
- Indexes — the existing indexes (e.g. `(accountId, lastMessageAt(sort: Desc))` on `Thread`) regenerate identically on Postgres.
- Postgres full-text-search indexes on `bodyText` — would be useful for in-app search but not authorized by the spec.
- Read replicas — out of free-tier scope and unnecessary for a single user.
