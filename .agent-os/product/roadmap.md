# Roadmap

Specs are completed in order. Each spec is its own folder under `.agent-os/specs/YYYY-MM-DD-name/` with `spec.md`, `spec-lite.md`, `tasks.md`, and `sub-specs/`. The active spec's path lives in `.claude/CURRENT_SPEC`.

## Phase 1 — Foundation
- **2026-05-14-foundation** — Next.js 15 scaffold, Auth.js v5 (Google + Azure), Prisma + SQLite, AES-256-GCM encryption util, `IEmailProvider` interface + stub, Inngest dev wiring, Vitest + Playwright + Biome, all six subagents + four skills + five hooks. *No email features yet.*

## Phase 2 — One provider, one inbox
- **gmail-provider** — Gmail adapter implementing `IEmailProvider`. History API for delta sync, batched message fetch, label CRUD. MSW fixture tests.
- **unified-inbox-ui** — Inbox list, **account switcher** (filter: all / per-account), thread view, **unread/read state**, **threading reconstruction** for non-Gmail providers (RFC 5322 `References` / `In-Reply-To` walk), **real-time updates** via Server-Sent Events when Inngest sync writes new rows.
- **compose-reply-forward** — Composer with TipTap rich text, **attachments** (upload + send; size/MIME guard), **drafts** (autosave to DB, resumable across devices, replayed offline), reply / reply-all / forward, send via adapter.
- **search-labels-archive-delete** — Provider-agnostic search (delegates to adapter), label add/remove, archive, trash. Bulk select + keyboard shortcuts (j/k/e/#).

## Phase 3 — All three providers
- **graph-provider** — Microsoft Graph adapter. Delta queries, category + folder mapping, send via `/me/sendMail`.
- **imap-provider** — IMAP/SMTP via `imapflow` + `nodemailer`. IDLE in an Inngest worker with reconnect, UIDVALIDITY guard, `\Seen` / `\Flagged` flag handling, header-based threading.

## Phase 4 — AI layer
- **ai-summaries** — Per-thread, Haiku 4.5, prompt-cached system block. Stored in `AISummary` on first request. Invalidated when the thread receives a new message.
- **ai-reply-drafts** — Streaming, Sonnet 4.6. Prompt: thread history + small sample of the user's recent sent messages (tone matching) + optional tone/length controls. Drafts versioned.
- **ai-prioritization** — Haiku 4.5 with tool-use schema `{ priority: 1–5, reason, suggestedActions[] }`. Runs on `message.new` via Inngest. Powers the "Priority Inbox" view.

## Phase 5 — PWA + deploy
- **pwa-offline** — Serwist service worker, manifest, install prompt, offline shell, IndexedDB draft queue with replay on reconnect.
- **deploy-vercel** — Vercel project, Neon Postgres, Inngest cloud, env wiring, OAuth redirect URIs for the deployed domain.

## Stretch / explicit non-goals
- **Stretch (post-Phase-5)**: Web Push notifications for new mail; user signature editor.
- **Out of scope, entire project**: calendar, contacts, tasks, notes, CRM, scheduling, snooze, mail rules / filters UI, .mbox import.
