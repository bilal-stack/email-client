# Best Practices

These are the architectural rules from `CLAUDE.md`, restated as Agent OS standards. `CLAUDE.md` is the canonical version; this file exists so the methodology is portable across projects.

1. **Provider interface, not provider code.** Every email provider implements `IEmailProvider`. UI and AI never import provider SDKs.
2. **Server-only secrets.** OAuth tokens and IMAP passwords are encrypted at rest with AES-256-GCM. Never returned to the client.
3. **Server-only AI.** Anthropic API key stays on the server. AI features go through Server Actions or Route Handlers.
4. **Stream long AI output.** Anything > ~1s streams. No spinners on text generation.
5. **Prompt caching is mandatory** on any reused system prompt. Use `cache_control: { type: "ephemeral" }` on the system block.
6. **Email HTML in sandboxed iframe only.** DOMPurify + tracker-pixel strip + strict CSP. Never inline-rendered.
7. **Centralized token refresh.** `lib/providers/auth.ts` is the only place tokens get refreshed.
8. **Cache, don't poll providers per render.** Background sync writes to the DB; UI reads from the DB.
9. **Idempotent sync.** Every sync run must be safe to re-run. Use provider delta cursors.
10. **Validate at boundaries.** Zod on every Server Action input and every provider / AI response.
11. **One state lib of each kind.** TanStack Query for server state; Zustand for client state. Nothing else.
12. **Tests with code, not after.** Specs include a test plan; tests land in the same PR as the feature.
13. **Real-time via SSE, not polling.** When the DB receives new mail from background sync, push to open clients via Server-Sent Events.
14. **No dead defensive code.** Do not handle states that can't occur. Validate at boundaries; trust internal calls.
