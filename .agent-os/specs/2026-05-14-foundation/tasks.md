# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete.

## 1. Project scaffold *(manual — no specialist agent for infra)*
- `npm dlx create-next-app@latest email-client --typescript --tailwind --app --src-dir=false --no-eslint --import-alias "@/*"` (then remove what we don't use).
- Replace ESLint with Biome: `npm add -D @biomejs/biome` + `biome.json` config + `npm` scripts.
- Add core deps: `@auth/prisma-adapter next-auth@beta @prisma/client prisma zod react-hook-form @hookform/resolvers @tanstack/react-query zustand`.
- Add dev deps: `vitest @vitest/ui jsdom @testing-library/react @testing-library/jest-dom @playwright/test msw`.
- Add `tsconfig.json` `strict: true`.
- Add `package.json` scripts per `CLAUDE.md`.

## 2. Database (Prisma)
- `prisma init --datasource-provider sqlite`.
- Add Auth.js Prisma adapter models + our `MailAccount` model (see `sub-specs/database-schema.md`).
- `npm db:migrate` produces the initial migration.

## 3. Encryption util (`lib/auth/crypto.ts`)
- `encrypt(plain: string)` and `decrypt(ciphertext, iv, tag)` using `crypto.createCipheriv("aes-256-gcm", ...)`.
- Key derived from `ENCRYPTION_KEY` (32-byte hex env var) via `crypto.createSecretKey`.
- Throws on tag mismatch; never returns ambiguous results.
- Unit tests per `sub-specs/tests.md`.

## 4. Auth.js wiring (`lib/auth/index.ts`)
- `NextAuth({ adapter, providers: [Google, AzureAD], callbacks })`.
- Session strategy: `database`.
- `signIn` callback: on Google / Azure success, write or update a `MailAccount` row, encrypting the tokens via `lib/auth/crypto.ts`.
- `Credentials` provider stub (returns null) — fleshed out in `imap-provider`.

## 5. Provider interface (`lib/providers/types.ts`)
- Define `IEmailProvider`, canonical `CanonicalThread` / `CanonicalMessage` / `SendDraft` / `ListResult` / `DeltaResult`.
- Implement `NotImplementedProvider` — every method throws `NotImplementedError`.
- Define provider error taxonomy in `lib/providers/errors.ts`.

## 6. Inngest dev wiring
- `lib/inngest/client.ts` — `new Inngest({ id: "email-client" })`.
- `app/api/inngest/route.ts` — `serve({ client, functions: [] })`.
- `package.json` script: `inngest:dev`.

## 7. UI surfaces
- `app/page.tsx` — landing with hero + "Sign in with Google" / "Sign in with Microsoft" / "IMAP (coming soon)".
- `app/signin/page.tsx` — Auth.js sign-in UI styled with Tailwind.
- `app/(mail)/layout.tsx` — shell with sidebar slot (empty for now), header with avatar.
- `app/(mail)/inbox/page.tsx` — empty state ("Connect a mailbox to get started").
- `middleware.ts` — redirect unauthenticated requests for `(mail)/*` to `/signin`.
- shadcn primitives: `button`, `card`, `avatar`. No more in this spec.

## 8. Tests (handed to `test-author` agent)
- Unit tests per `sub-specs/tests.md`.
- Playwright e2e per `sub-specs/tests.md`.

## 9. Claude Code artifacts
- Six subagent definitions under `.claude/agents/` per `docs/AGENTS_SKILLS_HOOKS.md`.
- Four skill files under `.claude/skills/<name>/SKILL.md`.
- `.claude/settings.json` with the five hooks.
- `.claude/CURRENT_SPEC` with the path to this spec.

## 10. Hand-off
- `security-reviewer` runs `/security-review` on the diff.
- On pass: bump `.claude/CURRENT_SPEC` to the next spec folder (`gmail-provider`).
