// Vitest globalSetup — runs ONCE before any worker starts. Migrates the test
// DB so all parallel workers can read/write without racing.
//
// Test DB: a dedicated Postgres database `email_client_test` on the same
// local Postgres server as `email_client` (dev). Separate DB keeps test
// resets from clobbering dev data — every full test run does a `prisma
// migrate reset` which drops and recreates every table. The two DBs share
// a server, user, and schema definition; only the database name differs.
//
// Override the connection by setting `TEST_DATABASE_URL` in your env (e.g.
// CI with a fresh Postgres service). If unset, we fall back to the local
// default that matches `.env.example`. Same value gets propagated to
// `DIRECT_URL` because there's no PgBouncer between localhost and Prisma.

import { execSync } from "node:child_process";

const DEFAULT_TEST_DB =
  "postgres://postgres:root@localhost:5432/email_client_test?schema=public";

export default function setup() {
  const testUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB;

  // Force Prisma's runtime AND its CLI into the test DB. We overwrite (not
  // `??=`) because a stray `DATABASE_URL` in the developer's shell would
  // otherwise point the migration runner at their dev DB and wipe it.
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testUrl;

  // Other env vars only fill in if missing — these are project-wide secrets
  // that the developer may have set legitimately.
  process.env.ENCRYPTION_KEY ??=
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.AUTH_SECRET ??= "test-secret";
  process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";

  // `migrate reset --force --skip-seed`:
  //   - DROPs every table in the test DB.
  //   - Replays the migration tree from `prisma/migrations/`.
  //   - Skips Prisma's optional seed step (we don't have one).
  // The result is identical to a freshly-created DB — guarantees no
  // schema drift or fixture leftovers between full test runs.
  //
  // `--force` skips Prisma's "are you sure?" prompt (we're certain — this
  // is the test DB, and DATABASE_URL above was explicitly set to it).
  execSync("npx prisma migrate reset --force --skip-seed", {
    stdio: "inherit",
    env: { ...process.env },
  });
}
