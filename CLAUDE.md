# Email Client — Claude Code Conventions

## What this project is
AI-first universal email client. Mobile-ready PWA. Supports Gmail, Office 365, and IMAP (Yahoo / AOL). Unified inbox across all accounts. AI summaries, AI reply drafts, AI prioritization. Built as the deliverable for a Claude Code agentic-workflow evaluation — so **how** we build it matters as much as what we build.

Deadline window: 3–5 days from 2026-05-14.

## Tech stack — locked. Do not change without updating a spec.
- **Next.js 15** (App Router) + **TypeScript** (`strict: true`)
- **Auth.js v5** (NextAuth) with Google, Azure AD, and Credentials (for IMAP) providers
- **Prisma** with **SQLite** in dev and **Postgres** in prod (one `DATABASE_URL` swap; Neon free tier on Vercel)
- Email SDKs: `googleapis` (Gmail), `@microsoft/microsoft-graph-client` (O365), `imapflow` + `nodemailer` (IMAP/SMTP)
- **`@anthropic-ai/sdk`** — Claude Sonnet 4.6 default, Haiku 4.5 for bulk classification
- **shadcn/ui** + **Tailwind v4** + **Radix primitives**
- **TanStack Query** (server state) + **Zustand** (client UI state) — nothing else
- **React Hook Form** + **Zod** for forms & validation; Zod everywhere at trust boundaries
- **TipTap** for the compose editor
- **Serwist** for the PWA service worker + manifest
- **Inngest** for background inbox sync (works on Vercel; local dev server too)
- **Server-Sent Events** (Next.js streaming) for real-time inbox push to the UI
- **Vitest** (unit) + **Playwright** (e2e) + **MSW** (network mocks)
- **Biome** for lint/format (one tool, faster than ESLint+Prettier)
- Package manager: **npm**

## Architectural rules — non-negotiable
1. **One `IEmailProvider` interface, three adapters.** Every provider (Gmail, Graph, IMAP) implements the same TypeScript interface in `lib/providers/types.ts`. UI and server actions never import provider SDKs directly — they go through the interface.
2. **Server-only secrets.** OAuth tokens and IMAP passwords live in the Prisma `Account` row, encrypted at rest with AES-256-GCM (key from `ENCRYPTION_KEY` env var). They never reach the client.
3. **AI calls are server-only.** The Anthropic API key never crosses to the browser. All AI features go through Server Actions or Route Handlers.
4. **Stream any AI output longer than ~1s.** Anthropic streaming + RSC streaming. No spinners on text generation.
5. **Prompt caching is mandatory** wherever a system prompt is reused (summary, prioritization, draft). Use `cache_control: { type: "ephemeral" }` on the system block.
6. **Email HTML is never rendered raw.** Pipeline is: DOMPurify → tracker-pixel strip → sandboxed `<iframe>` with `sandbox="allow-popups allow-popups-to-escape-sandbox"` and a strict `Content-Security-Policy` (`default-src 'none'; img-src data: https:; style-src 'unsafe-inline'`).
7. **Token refresh is centralized** in `lib/providers/auth.ts`. Adapters request fresh tokens from this helper; they do not refresh inline.
8. **No N+1 to providers.** Batch list calls. Cache message bodies in the DB. Background-sync new mail; never call a provider during a render.
9. **Idempotent sync.** Every sync run must be safe to re-run. Use provider deltas (Gmail `historyId`, Graph delta tokens, IMAP UIDVALIDITY+UID).
10. **Rate-limit AI endpoints per user.** In-memory limiter is fine for dev. Revisit only if deployed traffic warrants a distributed limiter.
11. **Real-time updates push from server to client via SSE.** Background sync writes to DB → server emits an SSE event → open clients revalidate the relevant TanStack Query keys. No client-side polling.

## What NOT to do
- Don't add a CRM, calendar, contacts, or tasks UI. Email only. The assignment is explicit.
- Don't introduce a state library beyond Zustand + TanStack Query.
- Don't write custom OAuth flows. Use Auth.js.
- Don't store plaintext passwords or tokens anywhere — DB, logs, or otherwise.
- Don't render email HTML in the main DOM. Sandboxed iframe only.
- Don't call Anthropic from a client component.
- Don't write code that the spec doesn't authorize. Update the spec first.
- Don't add tests after the fact. Specs include a test plan; tests land with the feature in the same PR.
- Don't skip prompt caching on repeated AI calls.
- Don't "improve" code outside the current spec's scope. File a follow-up task instead.
- Don't add error handling for impossible states. Validate at boundaries (Zod on inputs, response parsing on provider/AI calls). Trust internal code.

## Workflow — one rule
Every feature: **spec → review → build → test → review → merge.** We follow the **Agent OS** methodology. Specs live as folders under `.agent-os/specs/YYYY-MM-DD-name/` with `spec.md`, `spec-lite.md`, `tasks.md`, and `sub-specs/`. The active spec's folder path goes in `.claude/CURRENT_SPEC` so every session knows what's in scope. Product context lives in `.agent-os/product/` (mission, roadmap, tech-stack, decisions). Coding standards live in `.agent-os/standards/`. Specialist subagents (see `docs/AGENTS_SKILLS_HOOKS.md`) implement against the spec; the `security-reviewer` agent reviews the diff before merge.

## Commands
- `npm dev` — Next.js dev server on :3000
- `npm build` / `npm start` — production build & serve
- `npm typecheck` — `tsc --noEmit`
- `npm lint` / `npm format` — Biome
- `npm test` — Vitest (unit, watch)
- `npm test:run` — Vitest one-shot
- `npm test:e2e` — Playwright
- `npm db:migrate` — `prisma migrate dev`
- `npm db:studio` — Prisma Studio
- `npm inngest:dev` — Inngest dev server (for background sync locally)

## File layout
```
app/                       Next.js App Router (routes, server actions, layouts)
  (auth)/                  sign-in, connect-account, callback pages
  (mail)/                  inbox, thread, compose, search, settings
  api/                     route handlers (auth callbacks, inngest, webhooks)
components/                shadcn primitives + composed components
lib/
  providers/               IEmailProvider + adapters
    types.ts               the interface
    gmail.ts               googleapis adapter
    graph.ts               microsoft-graph adapter
    imap.ts                imapflow + nodemailer adapter
    auth.ts                token refresh + encryption
    index.ts               provider registry / selector
  ai/                      Anthropic client, prompts, streaming helpers
    client.ts              SDK instance + cache config
    summary.ts             per-thread summary
    draft.ts               reply draft generation (streamed)
    prioritize.ts          inbox priority scoring
    prompts/               system prompts (versioned)
  db/                      Prisma client + query helpers
  auth/                    Auth.js config + encryption util
  inngest/                 background sync functions
prisma/schema.prisma
.agent-os/                 Agent OS methodology files
  product/                 mission, roadmap, tech-stack, decisions
  standards/               code-style, best-practices, default tech-stack
  specs/                   feature specs (the source of truth)
    YYYY-MM-DD-name/       spec.md + spec-lite.md + tasks.md + sub-specs/
docs/                      deliverable docs (architecture, agents/skills/hooks, workflow)
tests/
  unit/                    Vitest
  e2e/                     Playwright
.claude/
  agents/                  subagent definitions
  skills/                  reusable recipes
  settings.json            hooks + permissions
  CURRENT_SPEC             path of the spec currently being implemented
```

## Environment variables (`.env.local`)
```
DATABASE_URL=file:./dev.db
ANTHROPIC_API_KEY=...
AUTH_SECRET=...                  # openssl rand -base64 32
ENCRYPTION_KEY=...               # 32 bytes hex — encrypts provider tokens
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
AZURE_AD_CLIENT_ID=...
AZURE_AD_CLIENT_SECRET=...
AZURE_AD_TENANT_ID=common
INNGEST_EVENT_KEY=...            # local dev: any string
INNGEST_SIGNING_KEY=...
```

## When in doubt
Ask the user. Do not invent scope. Do not refactor adjacent code. Update the spec first, then code.
