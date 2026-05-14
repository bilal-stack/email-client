# Architecture — One-Pager

## System shape
A single Next.js 15 app deployed to Vercel. Frontend (PWA) talks to its own server layer via Server Actions and Route Handlers. The server is the only thing that talks to email providers, the database, and Anthropic. No separate backend, no second deploy.

```
┌──────────────────────────────────────────────┐
│  PWA Client  (React 19, Tailwind, shadcn)   │
│  - TanStack Query  - Zustand  - Serwist SW  │
└────────────┬─────────────────────────────────┘
             │ Server Actions / RSC streaming
┌────────────▼─────────────────────────────────┐
│  Next.js Server Layer                        │
│  ┌─────────────┐ ┌──────────────┐ ┌────────┐ │
│  │ Auth.js v5  │ │ IEmailProvider│ │ AI    │ │
│  │ (G / O365 / │ │ ├ Gmail       │ │ Layer  │ │
│  │  Creds)     │ │ ├ Graph       │ │ (Claude│ │
│  │             │ │ └ IMAP/SMTP   │ │  SDK)  │ │
│  └─────────────┘ └──────────────┘ └────────┘ │
│  ┌─────────────────────────────────────────┐ │
│  │ Prisma → SQLite (dev) / Postgres (prod) │ │
│  └─────────────────────────────────────────┘ │
└────────────┬─────────────────────────────────┘
             │ event-driven sync
┌────────────▼─────────────────────────────────┐
│  Inngest workers                             │
│  - inbox.sync  (cron 60s / push triggers)    │
│  - ai.prioritize (on message.new)            │
│  - ai.summarize (on thread.changed)          │
└──────────────────────────────────────────────┘
```

## Data model (Prisma, simplified)
- `User` 1 ─ N `Account` (one row per connected mailbox: provider, encrypted tokens, sync cursor)
- `Account` 1 ─ N `Thread` 1 ─ N `Message`
- `Message` 1 ─ 0..1 `AISummary` (cached)
- `Message` 1 ─ N `AIDraft` (versioned drafts the user accepted/edited)
- `Message` ─ `PriorityScore` (1–5 + reason + suggested actions, cached)
- Tokens encrypted with AES-256-GCM (key = `ENCRYPTION_KEY`). IV stored alongside ciphertext.

## Provider abstraction
`IEmailProvider` is the single contract:
`listThreads(cursor) · getThread(id) · sendMessage(draft) · reply(id, body) · archive(ids) · trash(ids) · setLabels(ids, +add, -remove) · search(query) · syncDelta(cursor) → { newMessages, deletedIds, nextCursor }`

| Concern | Gmail | Graph (O365) | IMAP/SMTP |
|---|---|---|---|
| List | `users.messages.list` | `/me/messages` | `UID SEARCH` |
| Delta | `historyId` | delta query | `UIDVALIDITY` + last UID |
| Push | Pub/Sub `watch` (prod) / polling (dev) | webhooks (prod) / polling (dev) | IMAP IDLE in Inngest worker |
| Send | `users.messages.send` | `/me/sendMail` | `nodemailer` over SMTP |
| Labels | native | categories + folders | folder moves + `\Flagged` |

UI never branches on provider. The adapter normalizes everything to the canonical `Thread` / `Message` shape stored in the DB.

## AI layer — three features
1. **Summaries (Haiku 4.5)** — Per-thread, batched. System prompt cached. Stored in `AISummary` on first request; reused thereafter. Invalidated when thread receives a new message.
2. **Reply drafts (Sonnet 4.6)** — Streamed via Server Action + RSC. Prompt includes thread history + a small sample of the user's recent sent messages (for tone matching) + an optional tone/length control. Drafts are versioned so the user can A/B them.
3. **Prioritization (Haiku 4.5)** — Runs on `message.new`. Uses Anthropic tool-use to force structured output: `{ priority: 1–5, reason: string, suggestedActions: ("reply" | "archive" | "snooze" | "delegate")[] }`. Feeds the "Priority Inbox" view.

Prompt caching on the system block for all three. All AI lives in `lib/ai/`; client never sees the Anthropic key.

## Sync strategy
- **Connect**: backfill last 30 days, paged.
- **Steady state**: Inngest cron every 60s polls Gmail history / Graph delta. IMAP runs in a long-lived Inngest function on IDLE with reconnect-on-disconnect.
- **New message**: enqueues `ai.prioritize` → score persisted → server emits a Server-Sent Event → open clients revalidate the affected TanStack Query keys. No client polling.

## Threading
- Gmail: native `threadId`. Graph: native `conversationId`. IMAP: reconstructed from RFC 5322 headers (`Message-ID`, `In-Reply-To`, `References`) at sync time and persisted on the `Message` row.
- The UI sees a normalized `threadId` on every message; it never branches on provider.

## Attachments and drafts
- **Attachments** are uploaded via a Server Action to short-lived temp storage; provider-specific MIME assembly happens inside the adapter, not the UI. Size and MIME validated on the server.
- **Drafts** autosave to the `Draft` table with optimistic UI. Offline composes are queued in IndexedDB by the service worker and replayed on reconnect via the `sendDraft` Server Action.

## Read state and bulk actions
- Per-message `isUnread` flag mirrored from the provider (Gmail labels, Graph `isRead`, IMAP `\Seen`). Inbox UI surfaces unread count per account.
- Bulk select with `j/k/x` keyboard shortcuts; `e` archive, `#` trash. All bulk actions go through one `bulkAction` Server Action that fans out to the adapter in batches.

## Security
- **Tokens** encrypted at rest (AES-256-GCM). Never logged, never returned in API responses.
- **CSRF** handled by Auth.js.
- **Email HTML** is rendered only in a sandboxed iframe with `srcdoc` (no fetch escape), DOMPurify-cleaned, tracker pixels stripped, CSP `default-src 'none'; img-src data: https:; style-src 'unsafe-inline'`. Clicking a link warns if it disagrees with the visible URL.
- **Rate limits** on `/api/ai/*` — in-memory per-process limiter in dev; revisited if deployed traffic warrants a distributed limiter.
- **Zod validation** on every Server Action input and every provider/AI response.
- **No SSRF**: provider URLs are static; IMAP host validated against an allow-list of common providers in dev, free-form in prod with TLS required.

## PWA
- Serwist service worker — pre-caches the app shell, network-first for HTML, stale-while-revalidate for static assets, network-only for `/api/*`.
- Manifest with adaptive icons, theme color, `display: standalone`.
- Offline: cached inbox list + last opened threads readable; compose drafts persisted to IndexedDB and replayed when online.
- Installable on iOS/Android; "Add to Home Screen" tested in Playwright via mobile viewport.

## Why this shape
- **One codebase, one deploy** → fits the "live Vercel URL" deliverable cleanly. No CORS, no API gateway, no service-to-service auth.
- **Provider interface** → AI features and UI written once. Adding a new provider (e.g., Proton) is a single file.
- **DB-cached threads** → AI features operate on local data, not provider round-trips, so summaries and prioritization are fast and cheap.
- **Inngest** → durable, observable, retry-safe background work without standing up a queue.
- **Server-only AI** → key safety + prompt-caching savings concentrated in one place.
