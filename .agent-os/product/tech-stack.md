# Tech Stack (locked)

Any change to this file requires a new entry in `decisions.md` and a spec update.

| Layer | Choice | Why |
|---|---|---|
| Framework | Next.js 15 (App Router) | One codebase, one deploy on Vercel. Server Actions remove API ceremony. |
| Language | TypeScript `strict: true` | Type safety across server + client. |
| Auth | Auth.js v5 (Google, AzureAD, Credentials) | Handles all three OAuth flavors with token refresh. |
| Database | Prisma + SQLite (dev) / Postgres (prod via Neon) | Single `DATABASE_URL` swap. `Bytes` columns for encrypted tokens. |
| Gmail | `googleapis` | Official SDK; supports history API + watch. |
| O365 | `@microsoft/microsoft-graph-client` | Official SDK; delta + subscriptions. |
| IMAP/SMTP | `imapflow` + `nodemailer` | Best-maintained Node IMAP client; standard SMTP send. |
| AI | `@anthropic-ai/sdk` | Sonnet 4.6 default; Haiku 4.5 for classification. Prompt caching mandatory on reused system blocks. |
| UI | shadcn/ui + Tailwind v4 + Radix primitives | Mobile-first, accessible, no design-system lock-in. |
| Server state | TanStack Query | Cache + invalidation + revalidation. |
| Client state | Zustand | Tiny, no boilerplate. |
| Forms | React Hook Form + Zod | Validation at boundaries. |
| Compose editor | TipTap | Rich-text email composer. |
| PWA | Serwist | Modern, well-typed service worker; manifest generator. |
| Background jobs | Inngest | Durable, retryable, Vercel-native; IMAP IDLE friendly. |
| Real-time push to UI | Server-Sent Events (Next.js streaming) | No extra infra; one-way is all we need. |
| Rate limiting | In-memory per-process (dev) | Anti-abuse only added if deployed traffic warrants it. |
| Lint/format | Biome | One tool, faster than ESLint+Prettier. |
| Unit tests | Vitest | Fast, ESM-native. |
| E2E tests | Playwright | Cross-browser, mobile viewport. |
| Network mocks | MSW | Mock Anthropic + provider APIs deterministically; no token burn in CI. |
| Package manager | npm | Fast, content-addressed; works on Windows. |

## Defaults for new code
- ES modules. Path alias `@/` → project root.
- Server Actions in `app/.../actions.ts`. Validate input with Zod on entry; validate provider/AI responses on exit.
- Components are server by default; mark `"use client"` only when necessary.
- Prefer composition over abstraction. No premature generics.
- All async UI states have explicit loading / empty / error renders.
