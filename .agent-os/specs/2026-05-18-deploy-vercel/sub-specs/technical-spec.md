# Technical Spec — Deploy to Vercel

## Stack

- **Vercel** (hobby) — Next.js host + Edge / Serverless functions runtime.
- **Neon** (free tier) — Postgres. 0.5 GB storage, connection-pooled URL via PgBouncer + a direct URL for migrations.
- **Inngest cloud** (free tier) — cron + event-trigger functions.
- **Google Cloud Console** + **Azure Portal** + **Anthropic Console** — pre-existing OAuth / API credentials, updated with the deployed redirect URI.

All four services are free for the eval scope (single tenant, hundreds of messages, dozens of AI calls). Neon's free tier is the binding constraint at ~0.5 GB; everything else has wide headroom.

## Prisma datasource swap

```prisma
// prisma/schema.prisma — datasource block, replacing the SQLite version
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

**Why `directUrl`**: Neon's default connection string goes through PgBouncer (transaction pooling). Prisma's migration runner needs a session-level connection (for things like advisory locks during migration) and reading the connection string from `DATABASE_URL` would route migrations through the pooler too — which fails. The `directUrl` field tells Prisma's migrate runner to use the un-pooled URL while runtime queries continue to use the pooled URL. Both URLs are provided by Neon in the dashboard.

The runtime client (`@prisma/client`) does NOT use `directUrl`; it always reads `DATABASE_URL`.

## Migration generation flow

1. Provision the Neon project (or local Docker Postgres).
2. Set the env vars locally:
   ```
   DATABASE_URL="postgres://...?sslmode=require&pgbouncer=true"
   DIRECT_URL="postgres://...?sslmode=require"  # no pgbouncer=true
   ```
3. Delete or move the existing SQLite migration directories so Prisma starts fresh on Postgres:
   ```
   mv prisma/migrations prisma/migrations-sqlite-historical
   mkdir prisma/migrations
   ```
   (The historical SQLite migrations are committed for documentation in `prisma/migrations-sqlite-historical/` — not used by either dev or prod going forward.)
4. Run `npx prisma migrate dev --name postgres_init`. Prisma generates a single SQL migration that creates every table with Postgres types: `BYTEA` for `Bytes` columns, `JSONB` for `Json` columns, `TIMESTAMP(3)` for `DateTime`, etc.
5. Commit `prisma/migrations/<timestamp>_postgres_init/` AND `prisma/migrations-sqlite-historical/`.

Vercel's build runs `npm run db:migrate:deploy` which is `prisma migrate deploy` — applies any pending migrations under `prisma/migrations/` without prompting for input.

## `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "buildCommand": "prisma migrate deploy && next build",
  "regions": ["iad1"]
}
```

- `buildCommand` overrides Vercel's default `next build` to chain migrations first. If a migration fails, the build fails — that's the right semantic. A successful build implies the schema is in sync.
- `regions: ["iad1"]` (US East) co-locates with Neon's default region. Lambda cold-starts to a Neon instance in the same region are ~50ms vs ~150ms cross-region.
- No `crons` — Vercel's cron primitive is unused; Inngest cloud handles the scheduling.

## `lib/env.ts` additions

```ts
// At the top of the existing schema:
DIRECT_URL: z.string().optional(),
NEXTAUTH_URL: z.string().url().optional(),
```

Both optional. Local dev with SQLite leaves them unset. Vercel production has both set explicitly.

## Inngest cloud registration

Once the deploy is live, navigate to `https://<deployed-domain>/api/inngest`. Inngest's `serve` handler at that route exposes function metadata that Inngest cloud auto-discovers when:
- The `INNGEST_SIGNING_KEY` env var matches the app's key in the Inngest dashboard.
- The Inngest cloud project has the deployed URL registered as the "sync URL".

The Vercel + Inngest integration (one-click from the Inngest dashboard's "Integrations" tab) automates this — it imports the Vercel project's env vars and sets the sync URL automatically.

After integration: the four functions should appear in the Inngest cloud dashboard within ~30 seconds:
- `gmail-sync-delta` (cron `*/1 * * * *`)
- `graph-sync-delta` (cron `*/1 * * * *`)
- `imap-sync-poll` (cron `*/1 * * * *`)
- `prioritize-message` (event `inbox/message.created`)

## OAuth redirect URI updates

### Google Cloud Console
1. https://console.cloud.google.com → APIs & Services → Credentials → click the OAuth 2.0 Client ID.
2. **Authorized redirect URIs** → Add → `https://<your-vercel-domain>/api/auth/callback/google`.
3. Save. The localhost callback stays in the list for local dev.

### Azure Portal (Microsoft Entra ID)
1. https://portal.azure.com → App registrations → your app → Authentication.
2. **Web → Redirect URIs** → Add → `https://<your-vercel-domain>/api/auth/callback/microsoft-entra-id`.
3. Save.

### IMAP (Yahoo / AOL)
No redirect URIs — IMAP uses Credentials sign-in. The deployed app accepts the same email + app-password combo as local dev. No provider-side configuration changes.

## Secret management

- `ENCRYPTION_KEY` **must differ** between dev and prod. Re-using the dev key against the prod DB would mean a leaked dev key could decrypt prod tokens. The runbook explicitly says to generate a fresh key.
- `AUTH_SECRET` similarly — should be a fresh `openssl rand -base64 32`.
- All other secrets (OAuth client secrets, Anthropic key, Inngest keys) can be the same as dev IF the OAuth projects are dev-only AND the Anthropic key is a dev key with appropriate budget caps. For an eval submission with a single reviewer, sharing keys is acceptable; for a real product, separate.

## Smoke test (post-deploy)

The runbook walks through this. Briefly:
1. Open `https://<your-vercel-domain>/inbox` → redirects to sign-in.
2. Sign in with Google → grant `gmail.modify` → redirect back to `/inbox`.
3. Wait 60 seconds for the first Inngest cron tick. Verify in the Inngest dashboard that `gmail-sync-delta` ran.
4. Send yourself a test email from another account. Within 60s it appears in the inbox.
5. Open the new thread. Summary banner renders within 2s. Click the "info" icon → "Show me the prompt" modal opens.
6. Click Reply → click "AI draft" → three tabs populate progressively → click "Use this draft" on one → TipTap editor populates → Send.
7. Verify the reply lands in the recipient's mailbox.
8. Install the PWA via Chrome's address-bar install button. Open the installed app — confirm standalone display.
9. DevTools → Network → Offline → reload `/inbox`. Cached threads + priority chips render.
10. Type a reply offline — "Queued offline" indicator appears. Go online — indicator returns to "Saved" within 2s.

If all 10 pass, the deploy is green.

## Out of scope (recap)

CI separate from Vercel, monitoring / alerting, custom domain, staging environment, distributed rate limiter, backup / DR plan, Vercel Analytics, Edge-runtime migration.
