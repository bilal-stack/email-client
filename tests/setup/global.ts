// Vitest globalSetup — runs ONCE before any worker starts. Migrates the test
// DB so all parallel workers can read/write without racing.
import { execSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

export default function setup() {
  const dbPath = resolve(process.cwd(), "test.db");

  process.env.DATABASE_URL ??= "file:./test.db";
  process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.AUTH_SECRET ??= "test-secret";
  process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
  process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";

  // Fresh DB every full run — eliminates stale schema or fixture drift.
  if (existsSync(dbPath)) unlinkSync(dbPath);

  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env },
  });
}
