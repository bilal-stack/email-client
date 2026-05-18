# Deploying to production

Step-by-step runbook for getting the app onto Vercel + Neon Postgres + Inngest Cloud. Assumes you've finished local development against SQLite and want to ship the deployed version that an eval reviewer can use.

End state: `https://<your-app>.vercel.app/inbox` — a reviewer signs in with Google, Microsoft, or IMAP and uses the full inbox + AI features.

---

## Prereqs

Accounts you need (all free tier is fine):

- **GitHub** — for the source repo Vercel imports from.
- **Vercel** — https://vercel.com/signup. Hobby tier.
- **Neon** — https://console.neon.tech. Free tier: 0.5 GB storage, plenty for an eval.
- **Inngest Cloud** — https://app.inngest.com. Free tier covers the four cron / event functions we run.
- **Google Cloud Console** — for the existing OAuth client (already set up for local dev). https://console.cloud.google.com.
- **Azure Portal** — for Microsoft Entra ID (already set up for local dev). https://portal.azure.com.
- **Anthropic Console** — https://console.anthropic.com. The API key from local dev works in prod too; you can also create a separate prod key.

Local prereqs:

- `node` ≥ 20.
- `npm` (locked package manager).
- The repo cloned + `npm install` successful.

---

## Step 1 — Provision Neon Postgres

1. Sign in at https://console.neon.tech → **New project**.
2. Name: `email-client` (anything). Region: pick **AWS US East 2 (Ohio)** — Vercel's default region (`iad1`) is Virginia; co-locating keeps query latency under 50 ms.
3. After creation, on the project dashboard, click **Connection details**.
4. Copy **both** connection strings:
   - **Pooled** (default, has `pgbouncer=true` in the URL). This is your `DATABASE_URL`. The runtime client uses it.
   - **Direct connection** (toggle the "Connection pooling" switch off, copy the URL). This is your `DIRECT_URL`. `prisma migrate` uses it.
5. Both URLs include `?sslmode=require` — keep it.

Save both strings — you'll paste them into Vercel in step 3.

---

## Step 2 — Generate the Postgres migration locally

This is a one-time step that regenerates the Prisma migration tree for Postgres. The SQLite migrations under `prisma/migrations/` were generated for dev and aren't compatible with Postgres.

In a local shell, **only for this step**, export the Neon URLs:

```bash
export DATABASE_URL="postgres://...?sslmode=require&pgbouncer=true"
export DIRECT_URL="postgres://...?sslmode=require"
```

Move the SQLite migrations aside and generate the Postgres ones:

```bash
mv prisma/migrations prisma/migrations-sqlite-historical
mkdir prisma/migrations
npx prisma migrate dev --name postgres_init
```

Prisma connects to your Neon DB, generates `prisma/migrations/<timestamp>_postgres_init/migration.sql`, and applies it. The SQL creates every table (User, Account, Session, MailAccount, Thread, Message, Attachment, Draft, AISummary, PriorityScore) with Postgres types (BYTEA for `Bytes`, JSONB for `Json`).

Commit:

```bash
git add prisma/migrations prisma/migrations-sqlite-historical
git commit -m "deploy: regenerate Prisma migrations for Postgres"
git push origin main
```

The SQLite-historical tree stays committed for documentation; Vercel doesn't touch it.

> If you can't reach Neon from your machine (firewall, etc.), use a local Postgres container instead:
> ```bash
> docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=dev --name pg postgres:16
> export DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres?sslmode=disable"
> export DIRECT_URL="$DATABASE_URL"
> npx prisma migrate dev --name postgres_init
> docker stop pg
> ```
> The generated SQL is identical to what Neon would produce.

---

## Step 3 — Create the Vercel project

1. https://vercel.com/new → import your GitHub repo.
2. **Do NOT click Deploy yet.** The env vars aren't set; the first build would fail.
3. Verify the framework auto-detection caught Next.js, root directory is the repo root, build command is `prisma migrate deploy && next build` (this comes from `vercel.json` in the repo — Vercel reads it automatically).
4. In the same import flow, click **Environment Variables** and add the values below. **All variables go in all three scopes** (Production / Preview / Development) unless noted.

```
DATABASE_URL          = <Neon pooled URL>
DIRECT_URL            = <Neon direct URL>

AUTH_SECRET           = <run: openssl rand -base64 32>
                        # Fresh value per environment — distinct from dev.
ENCRYPTION_KEY        = <run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
                        # MUST be a fresh value, distinct from dev. Re-using the dev key
                        # against prod would let a leaked dev key decrypt prod tokens.

NEXTAUTH_URL          = https://<your-vercel-domain>
                        # The auto-generated URL; visible on the Vercel project page after first deploy.
                        # If you don't know it yet, leave blank for the first deploy and set it after.

GOOGLE_CLIENT_ID      = <from Google Cloud Console>
GOOGLE_CLIENT_SECRET  = <from Google Cloud Console>

AZURE_AD_CLIENT_ID    = <from Azure Portal>
AZURE_AD_CLIENT_SECRET = <from Azure Portal>
AZURE_AD_TENANT_ID    = common

ANTHROPIC_API_KEY     = sk-ant-...   (console.anthropic.com)

INNGEST_EVENT_KEY     = <see step 4>
INNGEST_SIGNING_KEY   = <see step 4>
```

---

## Step 4 — Set up Inngest Cloud

1. https://app.inngest.com → **New app**. Name: `email-client`.
2. The app dashboard shows your **Event Key** and **Signing Key** under **Manage → Keys**. Copy both.
3. Paste into Vercel:
   - `INNGEST_EVENT_KEY` = the event key.
   - `INNGEST_SIGNING_KEY` = the signing key.

You'll register the deployed app with Inngest in step 7 after the first deploy lands.

---

## Step 5 — Update OAuth redirect URIs

Both Google and Microsoft require pre-registered redirect URIs.

### Google Cloud Console

1. https://console.cloud.google.com → **APIs & Services → Credentials**.
2. Click your OAuth 2.0 Client ID.
3. Under **Authorized redirect URIs**, **Add URI**:
   ```
   https://<your-vercel-domain>/api/auth/callback/google
   ```
4. Save. **Keep the existing localhost URI** in the list — local dev continues to work in parallel.

### Azure Portal (Microsoft Entra ID)

1. https://portal.azure.com → **App registrations** → your app → **Authentication**.
2. Under **Web → Redirect URIs**, **Add URI**:
   ```
   https://<your-vercel-domain>/api/auth/callback/microsoft-entra-id
   ```
3. Save. Same as Google — keep the localhost callback registered.

### IMAP (Yahoo / AOL)

No redirect URIs. IMAP uses Credentials sign-in (email + app password). Nothing to configure provider-side.

---

## Step 6 — First deploy

Back on the Vercel project page:

1. Click **Deploy** (or `git push` to main if you've already wired the GitHub integration).
2. Watch the build log:
   - `npm install` runs.
   - `prisma generate` runs (postinstall hook).
   - `prisma migrate deploy` runs — verify it reports `1 migration found and applied` (the `postgres_init` you committed in step 2).
   - `next build` runs.
3. The deploy goes live at `https://<your-vercel-domain>`.

If `prisma migrate deploy` fails, see Troubleshooting below.

If you left `NEXTAUTH_URL` blank earlier, set it now to the URL shown on the project page and redeploy.

---

## Step 7 — Register the deployed app with Inngest

After the first deploy is live:

1. Visit `https://<your-vercel-domain>/api/inngest` once in a browser. Status 200, JSON response showing the registered functions.
2. In the Inngest dashboard, your app should auto-discover within 30 seconds. The four functions appear:
   - `gmail-sync-delta` — cron `*/1 * * * *`
   - `graph-sync-delta` — cron `*/1 * * * *`
   - `imap-sync-poll` — cron `*/1 * * * *`
   - `prioritize-message` — event-trigger `inbox/message.created`
3. If the functions don't appear, in Inngest's app settings → **Sync URL** is set to `https://<your-vercel-domain>/api/inngest` — paste it and click **Sync**.

The Vercel ↔ Inngest integration (one-click from Inngest's Integrations tab) automates the sync URL setting if you prefer.

---

## Step 8 — Smoke test the deployed app

Walk through this checklist against the production URL:

1. Open `https://<your-vercel-domain>/inbox` → redirected to sign-in.
2. Sign in with Google → grant the `gmail.modify` scope → land on `/inbox`.
3. Wait 60 seconds for the first cron tick. In the Inngest dashboard, `gmail-sync-delta` should show one run.
4. From another account, send yourself a test email. Within 60 s it appears in the inbox with a priority chip.
5. Open the new thread. The AI summary banner renders within ~2 s.
6. Click the info icon on the banner. The "Show me the prompt" modal opens with the system prompt, user payload, model name, and token usage.
7. Click Reply → "AI draft". Three tabs (Terse / Friendly / Detailed) populate progressively. Pick one → "Use this draft" → the TipTap editor populates.
8. Click Send. The reply lands in the recipient's mailbox.
9. In Chrome's address bar, click the install icon. Install the PWA. Open the installed app — standalone display, no browser chrome.
10. Open DevTools → Network → set to **Offline**. Reload `/inbox`. The cached inbox + priority chips render. Type a reply in a thread — "Queued offline" indicator. Go online — indicator returns to "Saved" within 2 s.

All 10 passing = deploy is green.

Sign in with Microsoft and IMAP and verify their inbox populates too (repeating steps 3 / 4 for each provider).

---

## Troubleshooting

### `prisma migrate deploy` fails on Vercel

- **`P3009: migrate found failed migration`** — the migration tree was mid-applied. In Neon's SQL editor, check the `_prisma_migrations` table for a row with `finished_at IS NULL`. Run `npx prisma migrate resolve --applied <migration_name>` locally with `DATABASE_URL` pointing at Neon, then redeploy.
- **`P1001: Can't reach database server`** — `DATABASE_URL` typo or Neon project paused. Resume in Neon dashboard.
- **`P3018: A migration failed to apply`** — Postgres rejected the SQL. Read the underlying error; usually a name collision with an existing schema. Inspect Neon's table list; the cleanest fix during initial setup is to delete the Neon DB and recreate (the project's free, no data lost in an eval).

### OAuth callback URL mismatch

`error=redirect_uri_mismatch` — the exact string in `https://<your-vercel-domain>/api/auth/callback/<provider>` must match what's registered in Google / Azure character-for-character (no trailing slash, correct subdomain). Re-check the registered URI.

### Inngest functions don't appear

- The deployed `/api/inngest` route returned non-200. Visit the URL in a browser; if 401 / 500, the build was incomplete. Check Vercel logs.
- `INNGEST_SIGNING_KEY` mismatch between Vercel and Inngest. Re-copy from Inngest's dashboard and redeploy.
- The "Sync URL" in Inngest's app settings is set to the wrong domain (or a preview deploy's URL). Set it to the canonical production URL.

### Preview deploys can't sign in

Vercel auto-generates a fresh URL for every preview branch (`<project>-<branch-hash>.vercel.app`). OAuth callbacks aren't registered for these — by design. Use the production URL for sign-in tests.

### Summary banner stuck on "Generating summary…"

- `ANTHROPIC_API_KEY` missing in Vercel. Check **Environment Variables**.
- Anthropic workspace doesn't have access to Haiku 4.5 / Sonnet 4.6. Confirm via console.anthropic.com.
- Inspect Vercel function logs for the Server Action — the canonical error string surfaces ("Summary failed — please retry") and the underlying Anthropic error is in the run log.

### "Mailbox state reset — reconnect required"

Provider sent a 410 (Graph deltaLink expired) or IMAP UIDVALIDITY flipped. The UI surfaces this as a reconnect prompt. Click reconnect — the next sync's cold-start path recovers.

### Local dev after the Postgres migration

After step 2, local dev still uses `file:./dev.db` from `.env.local`. The Postgres migration in `prisma/migrations/` doesn't affect dev because Prisma reads the provider from `schema.prisma` (now `postgresql`). If you run `prisma migrate dev` locally with `DATABASE_URL=file:./dev.db`, Prisma will complain about the provider mismatch.

**Two options** to keep local dev clean:

- **A. Use Postgres locally too.** Run `docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=dev --name pg postgres:16`, set `DATABASE_URL="postgres://postgres:dev@localhost:5432/postgres"` in `.env.local`, run `npx prisma migrate dev`. Parity with prod.
- **B. Keep two schema files.** `schema.prisma` stays Postgres for prod; create a `schema.dev.prisma` with `provider = "sqlite"` and run `prisma --schema=schema.dev.prisma migrate dev`. More juggling, less recommended.

Option A is what the spec recommends. Vitest tests pick up `.env.local` and run against whichever provider you've configured.

---

## What's intentionally not included

- **CI separate from Vercel.** Vercel's build runs typecheck via `next build`; tests run locally as part of pre-submission checks.
- **Monitoring / alerting.** Vercel's built-in logs + Inngest's function dashboard are the observability surface.
- **Custom domain.** Use the auto-generated `*.vercel.app` URL for the eval. Adding a custom domain is a one-click Vercel addition if needed later.
- **Staging environment.** Vercel's preview deploys are the staging surface; no separate Neon DB for them.
- **Backup / DR plan.** Neon retains 7 days of point-in-time recovery automatically on the free tier; nothing to configure.
- **Production-grade rate limiter.** The in-memory limiter is acceptable for an eval's traffic; a distributed limiter is a future spec if real usage warrants.

Once the smoke test passes, the deploy is the eval submission.
