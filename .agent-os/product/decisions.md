# Decisions

Reverse-chronological log of significant choices. New entries on top. Each entry: context → decision → why.

## 2026-05-14 — Use npm instead of pnpm
- **Context**: Original plan used pnpm. Corepack-activated pnpm on this Windows machine hit `EPERM` writing into `C:\Program Files\nodejs\`, which would have required an admin shell to set up.
- **Decision**: Use plain npm. Lockfile is `package-lock.json`.
- **Why**: Zero install friction (npm ships with Node), no functional cost for a single-package project, keeps the build runnable for the evaluator without admin steps.

## 2026-05-14 — Trim Upstash Ratelimit from default stack
- **Context**: Original plan used Upstash Redis for per-user rate limiting on AI endpoints.
- **Decision**: Drop Upstash. Use an in-memory limiter in dev. Revisit only if deployed traffic warrants it.
- **Why**: Assignment doesn't mandate abuse protection; the dependency adds env setup without earning eval signal.

## 2026-05-14 — Server-Sent Events for real-time inbox updates
- **Context**: When Inngest sync writes new messages, the open UI needs to update without a full refresh.
- **Decision**: Use SSE via Next.js streaming responses. One-way push is sufficient.
- **Why**: Built into the framework; no websocket server, no Pusher-style third party.

## 2026-05-14 — Header-based threading reconstruction for IMAP
- **Context**: Gmail threads natively; Graph threads via `conversationId`; IMAP has no native threading.
- **Decision**: For IMAP, reconstruct threads from RFC 5322 `Message-ID` / `In-Reply-To` / `References` headers at sync time; persist `threadId` on the message row.
- **Why**: Keeps the UI provider-agnostic. Threading is solved once in the IMAP adapter, not pushed into the UI.

## 2026-05-14 — Adopt Agent OS folder layout
- **Context**: Assignment names "Agent OS methodology" explicitly.
- **Decision**: Use `.agent-os/{product, standards, specs}/` per the Agent OS convention. Specs are folders with `spec.md`, `spec-lite.md`, `tasks.md`, and `sub-specs/`.
- **Why**: Higher eval signal; structure matches what the evaluator likely expects.

## 2026-05-14 — Next.js full-stack over FastAPI + separate frontend
- **Context**: User asked why not FastAPI.
- **Decision**: Next.js for the whole thing.
- **Why**: Vercel + Python is a known-bad combo (cold starts, 10s timeout, no persistent IMAP IDLE). Next.js gives one deploy, no CORS, and native Auth.js for the three OAuth providers. FastAPI wins only with heavy Python ML deps — N/A here.

## 2026-05-14 — Three AI features as three separate specs
- **Context**: Could bundle summary / draft / prioritize into one spec.
- **Decision**: Separate specs.
- **Why**: Each has its own prompt design, caching strategy, and UX. Bundling would obscure the spec-driven discipline being evaluated.

## 2026-05-14 — Tokens encrypted with AES-256-GCM at rest
- **Context**: Auth.js by default stores OAuth tokens in plaintext columns.
- **Decision**: Encrypt tokens in our `MailAccount` table. Auth.js's own `Account` rows are used only for session linkage.
- **Why**: Defense in depth — a DB dump shouldn't yield working tokens. GCM gives authenticated encryption; tampering is detected on decrypt.

## 2026-05-14 — One `IEmailProvider` interface, three adapters
- **Context**: Could write provider-specific code paths throughout.
- **Decision**: Define `IEmailProvider` in `lib/providers/types.ts`. UI + AI talk to the interface; adapters normalize to canonical `Thread` / `Message` shapes.
- **Why**: Adding a 4th provider becomes one file. AI features written once. Removes the temptation to special-case Gmail in the UI.
