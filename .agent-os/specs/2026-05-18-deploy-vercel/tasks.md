# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation.

This spec is mostly **runbook + configuration**, not feature code. Tasks 1–4 are code; tasks 5–8 are documentation + a manual deploy.

## 1. Prisma datasource swap + env (`prisma/schema.prisma`, `lib/env.ts`) — `provider-adapter` (closest fit; ui-builder OK too)
- In `prisma/schema.prisma`, change the `datasource db` block:
  ```prisma
  datasource db {
    provider  = "postgresql"
    url       = env("DATABASE_URL")
    directUrl = env("DIRECT_URL")
  }
  ```
  The `directUrl` is what Prisma's migration runner uses (it bypasses the connection pooler — pgbouncer/PgPool — which doesn't support every operation `prisma migrate` needs). At runtime, `@prisma/client` uses `DATABASE_URL` (the pooled connection string).
- In `lib/env.ts`, extend the Zod schema:
  ```ts
  DIRECT_URL: z.string().optional(), // Used by prisma migrate; runtime uses DATABASE_URL.
  NEXTAUTH_URL: z.string().url().optional(), // Auth.js derives from VERCEL_URL when absent; explicit on prod avoids cookie / OAuth-redirect surprises.
  ```
  Both optional — local dev with SQLite doesn't set them.
- **DO NOT run `prisma migrate dev` yet.** That happens in task 3 against a real Neon DB.

## 2. `vercel.json` + npm script — `ui-builder`
- New file at repo root `vercel.json`:
  ```json
  {
    "$schema": "https://openapi.vercel.sh/vercel.json",
    "framework": "nextjs",
    "buildCommand": "prisma migrate deploy && next build",
    "regions": ["iad1"]
  }
  ```
  No `crons` field — Inngest cloud handles cron jobs, not Vercel.
- In `package.json`, add a new script `"db:migrate:deploy": "prisma migrate deploy"` alongside the existing `db:migrate`. The Vercel build uses `migrate deploy` (applies pending migrations, never prompts, never generates new ones).

## 3. Postgres migration generation — `provider-adapter` (manual step, runs locally with a real Neon URL)
This is a **one-time generative step**, not pure code editing:
- The agent doing this task creates a Neon project (free tier), copies the two connection strings (pooled + direct), exports them as env vars locally:
  ```
  export DATABASE_URL="postgres://...?sslmode=require"
  export DIRECT_URL="postgres://...?sslmode=require"
  ```
- Run `npx prisma migrate dev --name postgres_init`. Prisma generates `prisma/migrations/<timestamp>_postgres_init/migration.sql` against the empty Neon DB. Commit the generated SQL.
- **The existing SQLite migrations stay committed for documentation, but Vercel only runs `migrate deploy` against Postgres.** Prisma's `_prisma_migrations` table will tracking only the Postgres migration as applied.
- IF the agent doesn't have Neon credentials at hand, the alternative is to run against a local Postgres (Docker: `docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=dev postgres:16`) with `DATABASE_URL=DIRECT_URL=postgres://postgres:dev@localhost:5432/postgres?sslmode=disable`. The generated migration SQL is the same; commit it. Document the workaround in `docs/deploy.md` if Neon credentials are unavailable.
- After the migration is generated, switch DATABASE_URL back to `file:./dev.db` for local dev. The SQLite migrations remain, but `prisma migrate dev` will complain about a provider mismatch. Use `prisma migrate reset` if needed for local-dev parity, OR document in `docs/deploy.md` that local dev now requires Postgres too. **Pick whichever path keeps `npm test:run` green** — likely the "switch to Postgres for local dev too" path, with a Docker compose file. Decision call for the agent.

  **Simpler alternative: keep BOTH provider migration trees.** Move the existing SQLite migrations into `prisma/migrations-sqlite/` (untracked / committed for reference) and the new Postgres migrations into the canonical `prisma/migrations/` location. Update the dev workflow to use `prisma migrate deploy` against a local Postgres container, with a one-shot `npm run db:up` to start it. This is cleaner long-term; the agent should pick this if comfortable.

## 4. `.env.example` overhaul + `lib/env.ts` finalize — `ui-builder`
- `.env.example` is the single source of truth for "what env vars exist + where to get them". Rewrite it to include EVERY production env var with a one-line comment. Keep the existing dev vars at the top, add a clearly-marked production section below:
  ```dotenv
  # ─── Required (both dev and prod) ──────────────────────────────
  DATABASE_URL="file:./dev.db"                       # postgres://... on prod (Neon pooled URL)
  AUTH_SECRET=""                                     # openssl rand -base64 32
  ENCRYPTION_KEY=""                                  # MUST DIFFER between dev and prod. node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

  # ─── OAuth providers ───────────────────────────────────────────
  GOOGLE_CLIENT_ID=""
  GOOGLE_CLIENT_SECRET=""
  AZURE_AD_CLIENT_ID=""
  AZURE_AD_CLIENT_SECRET=""
  AZURE_AD_TENANT_ID="common"

  # ─── AI ────────────────────────────────────────────────────────
  ANTHROPIC_API_KEY=""                               # console.anthropic.com

  # ─── Inngest (local dev tolerates any non-empty value) ─────────
  INNGEST_EVENT_KEY="local-dev"                      # cloud: app.inngest.com → app → Event keys
  INNGEST_SIGNING_KEY="local-dev"                    # cloud: app.inngest.com → app → Signing keys

  # ─── Production-only ───────────────────────────────────────────
  DIRECT_URL=""                                      # Neon direct (un-pooled) URL; used by prisma migrate
  NEXTAUTH_URL=""                                    # https://<your-vercel-domain>
  ```
- Cross-check `lib/env.ts` accepts all variants. Confirm the existing schema doesn't break for any of these.

## 5. Deploy runbook (`docs/deploy.md`) — `ui-builder`
Long-form documentation. The agent should write the steps clearly enough that a reviewer with no prior context can follow. Sections:
- **Prereqs**: a GitHub repo, a Vercel account, a Neon account, an Inngest cloud account, OAuth client credentials for Google + Microsoft, an Anthropic API key.
- **Step 1 — Neon Postgres**: create project, copy pooled + direct connection strings.
- **Step 2 — Vercel project**: import the GitHub repo into Vercel, do NOT auto-deploy yet (the env vars aren't set).
- **Step 3 — Env vars in Vercel**: enumerate every var from `.env.example`, paste the Neon URLs into `DATABASE_URL` + `DIRECT_URL`, paste the OAuth secrets, generate a fresh `ENCRYPTION_KEY` + `AUTH_SECRET` distinct from dev, paste the Anthropic key. Set `NEXTAUTH_URL` to `https://<your-vercel-domain>` (use the auto-generated Vercel URL or your custom domain).
- **Step 4 — Inngest cloud**: create app, copy event key + signing key, set in Vercel.
- **Step 5 — OAuth redirect URIs**: walk through adding `https://<your-vercel-domain>/api/auth/callback/google` in Google Cloud Console and `https://<your-vercel-domain>/api/auth/callback/microsoft-entra-id` in Azure Portal. Note that the localhost redirects stay registered for local dev.
- **Step 6 — First deploy**: trigger via `vercel --prod` or `git push origin main`. Watch the Vercel build log — confirm `prisma migrate deploy` runs successfully, `next build` succeeds.
- **Step 7 — Inngest registration**: navigate to `https://<your-vercel-domain>/api/inngest` once after deploy; Inngest cloud auto-discovers the function registry. Verify the four functions are listed in the Inngest dashboard: `gmail-sync-delta`, `graph-sync-delta`, `imap-sync-poll`, `prioritize-message`.
- **Step 8 — Smoke test**: open the URL, sign in with Google, wait ~60 seconds, send yourself a test email, verify it appears with a priority chip, open the thread, verify the summary banner, click "AI draft", verify the streaming response, install the PWA from the address bar, open offline in DevTools and verify the cached inbox renders.
- **Troubleshooting**: common failure modes — Prisma migration mismatch (manually `prisma migrate resolve --applied <name>` in Neon SQL editor), OAuth redirect mismatch (double-check exact URL string), Inngest functions not appearing (re-fetch `/api/inngest` after the deploy completes).

## 6. README link — `ui-builder`
Modify `README.md` to link to `docs/deploy.md` from a clearly-labeled "Deploying to production" section. Keep the existing local-dev quickstart at the top of the README untouched.

## 7. Tests — `test-author` (almost no automated coverage)
- Nothing meaningful to unit-test in this spec — it's all configuration + documentation.
- Run `npm test:run` to confirm the schema-provider swap didn't break any existing tests. If the tests rely on SQLite-specific behavior, this is where it surfaces. Likely candidates:
  - Tests that read `Bytes` columns — `lib/providers/auth.test.ts` (the encrypted-secret round-trip). The Prisma `Bytes` type maps to BYTEA on Postgres; tests should pass.
  - Tests that read `Json` columns — many; same story, Prisma normalizes.
- If any test breaks, REPORT IT — this is not test-authoring work, it's regression detection.

## 8. Hand-off
- `security-reviewer` runs `/security-review` on the diff. Focus areas:
  - (a) **No secrets committed to the repo.** Run `git log -p | grep -E '(sk-ant-|GOCSPX-|AKIA|-----BEGIN)'` — should produce zero hits.
  - (b) `NEXTAUTH_URL` set in Vercel.
  - (c) `ENCRYPTION_KEY` MUST be distinct between dev and prod — document the requirement; the runbook says so explicitly.
  - (d) Neon connection string uses `sslmode=require` (Neon's default).
  - (e) OAuth redirect URIs added only for the deployed domain (NOT for `localhost` in the Vercel-deployed Google/Azure projects — the localhost callbacks can stay registered in the SAME OAuth project, but the eval reviewer's review project should only have the production URL if they prefer to be conservative).
- After security-reviewer PASS: **do not advance `CURRENT_SPEC`**. This is the last spec in the roadmap. The post-deploy step is the eval submission; mark this spec as DONE in any spec-tracking surface.
- Manually run a `vercel --prod` (or `git push`) deploy. Walk the smoke-test checklist in `docs/deploy.md`. If any step fails, the runbook's troubleshooting section should help; if it doesn't, file a new TODO.
