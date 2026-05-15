# Foundation

## Goal
Stand up the project skeleton so all subsequent specs have a working scaffold. Next.js 15 + TypeScript, Auth.js v5 with Google and Azure providers, Prisma + SQLite, AES-256-GCM token encryption, `IEmailProvider` interface (with a `NotImplementedProvider` stub), Inngest dev server, Vitest + Playwright + Biome, and the Claude Code agent / skill / hook files in place.

**No email features yet** — this spec is purely infrastructure. The first adapter lands in `gmail-provider`.

## User stories
1. **As a developer**, I can run `npm install && npm run db:migrate && npm run dev` from a fresh checkout and reach a styled landing page at `localhost:3000`.
2. **As a developer**, I can sign in with Google or Microsoft and land on `/inbox`, which shows an "no accounts connected yet" placeholder — proving Auth.js + Prisma + session middleware work end-to-end.
3. **As a developer running an agent**, `provider-adapter` can be spawned and finds `lib/providers/types.ts` populated with the `IEmailProvider` interface and a `NotImplementedProvider` stub to extend.

## Non-goals
- No actual email fetching. No adapter implementations beyond the stub.
- No AI features. `lib/ai/` not created in this spec.
- No service worker yet (manifest only, deferred to `pwa-offline`).
- No prod deployment.

## In-scope surfaces
- `GET /` — landing page with sign-in CTAs.
- `GET /signin` — Auth.js sign-in UI (styled with Tailwind).
- `GET|POST /api/auth/[...nextauth]` — Auth.js handler.
- `GET /inbox` — gated route; redirects to `/signin` if unauthenticated; shows the empty state.
- `POST /api/inngest` — Inngest handler (empty function list; just proves wiring).

## Claude Code artifacts created in this spec
- `.claude/agents/{planner, provider-adapter, ai-feature, ui-builder, test-author, security-reviewer}.md`
- `.claude/skills/{email-html-sanitize, anthropic-streaming, provider-adapter-template, spec-template}/SKILL.md`
- `.claude/settings.json` with the five hooks from `docs/AGENTS_SKILLS_HOOKS.md`
- `.claude/CURRENT_SPEC` pointing at this spec's `spec.md`

## Risks / open questions
- **Windows hook portability**: prefer Node scripts (`node scripts/hook-x.mjs`) for any hook beyond a single `pnpm <script>` invocation, so behavior is identical in PowerShell and bash.
- **Auth.js v5 + Prisma adapter**: v5 is in beta; pin to a known-good version pair to avoid breaking changes.
- **SQLite + Prisma `Bytes`**: confirm encrypted-token round-trip works through Prisma without base64 detours.
- **Azure permissions**: some Mail scopes need admin consent on work/school tenants. Personal Microsoft accounts may work but will be re-verified in `graph-provider`.

## Definition of done
- `pnpm dev` starts cleanly from a fresh checkout.
- Google and Microsoft sign-in both flow to `/inbox` with the empty state visible.
- All tests in `sub-specs/tests.md` pass.
- `security-reviewer` agent has signed off on the encryption util, session storage, and route guards.
- `.claude/CURRENT_SPEC` advanced to the next spec (`gmail-provider`).
