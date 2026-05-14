# Workflow

## The loop
Every feature flows through the same five stages. No exceptions.

```
1. Spec       planner agent → .agent-os/specs/YYYY-MM-DD-name/ → user review
2. Build      specialist agent (provider-adapter | ai-feature | ui-builder)
3. Test       test-author agent (Vitest + Playwright)
4. Review     security-reviewer agent (/security-review)
5. Merge      user merges; .claude/CURRENT_SPEC advances to the next spec folder
```

Specs follow the **Agent OS** layout — each is a folder with `spec.md`, `spec-lite.md`, `tasks.md`, and `sub-specs/{technical-spec, database-schema, tests}.md`. The path of the in-flight spec is written to `.claude/CURRENT_SPEC` so the `SessionStart` hook reminds every new agent context what's authorized. Product context (mission, roadmap, tech-stack, decisions) lives in `.agent-os/product/`. If a build agent wants to do something the spec doesn't allow, it stops and asks `planner` to revise the spec first.

## Spec backlog (ordered, written one at a time)

The roadmap (`.agent-os/product/roadmap.md`) is the canonical list. Summary here:

| # | Spec folder | Owner agent | Why this order |
|---|---|---|---|
| 1 | `2026-05-14-foundation` | planner → manual scaffold | Next.js, Auth.js, Prisma, encryption util, hooks/agents in place |
| 2 | `gmail-provider` | provider-adapter | First adapter validates the `IEmailProvider` shape |
| 3 | `unified-inbox-ui` | ui-builder | Inbox list, account switcher, threading, unread state, SSE real-time |
| 4 | `compose-reply-forward` | ui-builder | TipTap editor, attachments, drafts, reply/forward via adapter |
| 5 | `search-labels-archive-delete` | ui-builder + provider-adapter | Full CRUD parity, bulk + keyboard shortcuts |
| 6 | `graph-provider` | provider-adapter | Second adapter stresses the interface |
| 7 | `imap-provider` | provider-adapter | Third adapter — IDLE + UID + header-based threading |
| 8 | `ai-summaries` | ai-feature | First AI feature on real data, prompt-cached |
| 9 | `ai-reply-drafts` | ai-feature | Streaming, tone-matched |
| 10 | `ai-prioritization` | ai-feature | Background scoring + Priority Inbox view |
| 11 | `pwa-offline` | ui-builder | Serwist + manifest + offline shell + IndexedDB draft queue |
| 12 | `deploy-vercel` | manual | Postgres + Inngest cloud + env + OAuth redirects |

Each spec gates its build. We don't write code that doesn't match a spec. The order is chosen so the first AI feature (007) lands when there's already real mail in the DB to summarize — AI features shouldn't be debugged against fixtures alone.

## Why this works for an AI-first project
- **Specs make AI-generated code reviewable before it lands.** A spec is the user's chance to say "no, the priority categories should be 1–3, not 1–5" *before* an agent generates 400 lines around the wrong shape.
- **Specialist agents stay narrow.** A `provider-adapter` agent that can only touch `lib/providers/` won't accidentally rewrite the inbox UI when its real job is finishing a token-refresh edge case.
- **Skills package institutional knowledge.** The HTML sanitizer pipeline and the Anthropic streaming pattern get derived once, then reused — no agent re-invents the wheel on its third try.
- **Hooks catch the rule-breaks agents miss.** Typecheck after every edit, lint+test at session end, secrets-folder writes blocked outright.
- **Tests land with code.** The spec's test plan is part of the spec; `test-author` runs immediately after the build agent finishes; nothing merges without `pnpm test` green.

## How this maps to the assignment's judging criteria
- **Product quality** — specs force feature completeness before code; nothing half-shipped.
- **AI-first thinking** — three distinct AI features (summary, draft, prioritize), each with its own spec, prompt-caching, and tool-use schema; AI is integrated into background sync, not bolted onto the UI.
- **UI / UX** — shadcn primitives + Tailwind keep visuals consistent; streaming + skeleton states; PWA install + offline shell.
- **Architecture** — one provider interface, three adapters; AI layer isolated; Inngest-based sync; encrypted-at-rest tokens.
- **Claude Code discipline** — CLAUDE.md, six subagents, four skills, five hooks, spec-driven; every commit traceable to a spec.
- **Testing** — Vitest unit + Playwright e2e + MSW network mocks; `test-author` agent + `Stop` hook enforce green test runs.
