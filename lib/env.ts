// Boot-time environment-variable validation.
//
// Imported once at server entry (via `lib/auth/index.ts`). Throws on bad config
// the moment Next.js starts the server, instead of letting misconfiguration
// surface as a cryptic Auth.js or Prisma error on someone's first sign-in.
//
// The exported `env` object is what application code should read from. We
// don't ban `process.env.X` access elsewhere — that would be too noisy — but
// any new secret-bearing env var should be added here so it benefits from the
// same boot-time check.

import { z } from "zod";

const HEX_64 = /^[0-9a-fA-F]{64}$/;

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // 32 bytes hex = 64 chars. Used to AES-256-GCM-encrypt provider tokens at
  // rest. If this is wrong, no sign-in can ever complete.
  ENCRYPTION_KEY: z
    .string()
    .regex(
      HEX_64,
      "ENCRYPTION_KEY must be exactly 32 bytes as hex (64 chars). Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    ),

  // Auth.js signs session JWTs with this. Any non-empty string works; for prod
  // use 32+ random bytes (Auth.js recommendation). We only validate non-empty
  // so test environments with shorter values still boot.
  AUTH_SECRET: z
    .string()
    .min(
      1,
      "AUTH_SECRET is required (generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")",
    ),

  // OAuth credentials. Optional at the schema level so the app can boot with
  // partial provider config (e.g. only Google set up, Microsoft not yet), but
  // each provider's sign-in will then fail with a clear runtime error.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  AZURE_AD_CLIENT_ID: z.string().optional(),
  AZURE_AD_CLIENT_SECRET: z.string().optional(),
  AZURE_AD_TENANT_ID: z.string().default("common"),

  // Inngest local-dev tolerates any non-empty value.
  INNGEST_EVENT_KEY: z.string().default("local-dev"),
  INNGEST_SIGNING_KEY: z.string().default("local-dev"),

  // AI features land in Phase 4. Optional now so the app boots without the
  // key; the AI Server Actions will check at call time.
  ANTHROPIC_API_KEY: z.string().optional(),

  // Used by `prisma migrate` against Neon's un-pooled connection; runtime uses DATABASE_URL.
  DIRECT_URL: z.string().optional(),

  // Auth.js derives from VERCEL_URL when absent; explicit on prod avoids cookie / OAuth-redirect surprises.
  NEXTAUTH_URL: z.string().url().optional(),

  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
    .join("\n");
  // Bail loudly and synchronously — Next.js dev server prints this in the
  // terminal where the developer is already looking.
  throw new Error(
    `\n\n❌ Invalid environment variables — see your .env file:\n${issues}\n\nFix the above and restart \`npm run dev\`.\n`,
  );
}

export const env = parsed.data;
export type Env = typeof env;
