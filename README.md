# Email Client

AI-first universal email client. Mobile-ready PWA. Gmail, Office 365, and IMAP (Yahoo / AOL) in one inbox, with AI summaries, AI reply drafts, and AI prioritization.

Built as a Claude Code agentic-workflow deliverable.

## Deliverables — pointers
- Live Vercel URL — *added near the end of the build (final spec: `deploy-vercel`)*
- [CLAUDE.md](./CLAUDE.md) — conventions, tech stack, no-go list
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — one-page architecture doc
- [docs/AGENTS_SKILLS_HOOKS.md](./docs/AGENTS_SKILLS_HOOKS.md) — list of agents, skills, hooks, plugins
- [docs/WORKFLOW.md](./docs/WORKFLOW.md) — workflow writeup
- [.agent-os/product/](./.agent-os/product) — mission, roadmap, tech-stack, decisions (Agent OS)
- [.agent-os/specs/](./.agent-os/specs) — feature specs, the source of truth (Agent OS)

## Status
Planning phase — docs and Agent OS scaffolding in place; code scaffolding pending. The first spec ([`.agent-os/specs/2026-05-14-foundation/`](./.agent-os/specs/2026-05-14-foundation)) is what lands first.

## Quick start (once scaffolded)
```bash
npm install
cp .env.example .env.local   # fill in credentials
npm db:migrate
npm dev
# in another terminal:
npm inngest:dev
```

## Required credentials (local dev)
- **Anthropic API key** — [console.anthropic.com](https://console.anthropic.com)
- **Google OAuth client** — Google Cloud Console → enable Gmail API → OAuth Web Client with redirect `http://localhost:3000/api/auth/callback/google`
- **Azure AD app** — Azure Portal → App registrations → redirect `http://localhost:3000/api/auth/callback/azure-ad` → permissions `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`, generate a client secret
- **Yahoo/AOL app passwords** — only needed when testing IMAP (spec 006)

See `CLAUDE.md` for the full `.env.local` template.

## How this codebase is built
Every feature follows a spec → review → build → test → review → merge loop, with specialized Claude Code subagents owning each step. See [docs/WORKFLOW.md](./docs/WORKFLOW.md).
