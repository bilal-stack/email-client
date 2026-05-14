# Claude Code Setup — Agents, Skills, Hooks, Plugins

The Claude Code workflow for this project uses six specialist subagents, four reusable skills, five hooks, and one third-party plugin. The split is intentional: agents own *what* gets done, skills own *how it's always done*, hooks own *what must never slip through*.

---

## Subagents (`.claude/agents/`)

Every subagent has a narrow scope, an explicit tool allow-list, and a "must not touch" zone. This keeps blast radius small and reviews fast.

### 1. `planner`
- **Role**: Reads a backlog item, writes/updates `specs/NNN-feature.md`. Hands off only after the user has reviewed the spec.
- **Tools**: `Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch` (for protocol docs).
- **Cannot**: edit anything outside `specs/`, `docs/`, `.claude/CURRENT_SPEC`. No code edits.
- **Output contract**: spec follows the `spec-template` skill.

### 2. `provider-adapter`
- **Role**: Implements one adapter (Gmail / Graph / IMAP) against `IEmailProvider`. One adapter per invocation.
- **Tools**: `Read`, `Edit`, `Write`, `Bash` (typecheck / unit tests only).
- **Cannot**: edit `app/`, `components/`, `lib/ai/`, other adapters, or `prisma/schema.prisma` beyond what the spec authorizes.
- **Required**: token refresh goes through `lib/providers/auth.ts`; errors mapped through `lib/providers/errors.ts`; uses `provider-adapter-template` skill.

### 3. `ai-feature`
- **Role**: Builds AI features (summary, draft, prioritize). Owns `lib/ai/` and the matching Server Actions.
- **Tools**: `Read`, `Edit`, `Write`, `Bash`.
- **Required**: prompt caching on system blocks; Zod schema on tool-use outputs; streaming for any user-facing generation; fixture-based tests against recorded Anthropic responses (MSW).
- **Cannot**: call providers directly; bypass the rate limiter.

### 4. `ui-builder`
- **Role**: Implements components and routes using shadcn primitives, Tailwind, TanStack Query hooks, Zustand stores.
- **Tools**: `Read`, `Edit`, `Write`, `Bash`.
- **Cannot**: import provider SDKs; call Anthropic directly; introduce a third state library.
- **Required**: all data fetches go through Server Actions defined under `app/`; loading + empty + error states for every async view.

### 5. `test-author`
- **Role**: Writes Vitest unit tests and Playwright e2e tests against an existing spec's test plan. Spawned after a build agent finishes.
- **Tools**: `Read`, `Edit`, `Write`, `Bash`.
- **Required**: unit tests for every adapter method, every AI helper, every Server Action; e2e for the spec's user stories. Network mocked with MSW.

### 6. `security-reviewer`
- **Role**: Reads the diff before merge. Pass / fail with line-level comments.
- **Tools**: `Read`, `Glob`, `Grep`, `Bash` (read-only).
- **Checklist**: token storage encrypted; no Anthropic key on client; HTML rendered in sandboxed iframe with strict CSP; Zod on every boundary; rate limit on AI endpoints; no plaintext credentials in logs; no SSRF on user-supplied IMAP hosts; OAuth scopes minimal.

---

## Skills (`.claude/skills/`)

Each skill is a markdown file with a canonical recipe. Agents `Read` the skill at the start of any matching task.

### 1. `email-html-sanitize`
The exact pipeline for rendering email HTML safely. DOMPurify config (allowed tags/attrs, `FORBID_TAGS`, `FORBID_ATTR`), tracker-pixel strip-list (regex over common analytics domains), iframe `sandbox` attributes, CSP header values, and a reference test fixture (a phishing-style email) the sanitizer must defeat.

### 2. `anthropic-streaming`
Anthropic SDK streaming + prompt caching pattern. Shows: how to mark the system block with `cache_control: { type: "ephemeral" }`, how to stream from a Server Action to a client component using `createStreamableValue`, how to handle `overloaded_error` with retry-with-jitter, and how to count input/output tokens for cost reporting.

### 3. `provider-adapter-template`
Boilerplate that every `IEmailProvider` adapter follows: required method signatures, the canonical error type, the token-refresh flow (`lib/providers/auth.ts`), pagination convention, and the fixture format the adapter's tests consume.

### 4. `spec-template`
Skeleton for `specs/NNN-*.md`:
```
# Spec NNN — <feature>

## Goal
## User stories
## Non-goals
## API surface (Server Actions / Route Handlers)
## Data model changes (Prisma)
## AI prompt design (if applicable)
## UI surfaces
## Test plan (unit + e2e)
## Risks / open questions
```

---

## Hooks (`.claude/settings.json`)

Hooks are the safety net. They run in Claude Code's harness regardless of which agent is active. All hook actions are implemented as Node scripts under `scripts/hooks/` so they behave identically in PowerShell and bash.

| Mechanism | Trigger | Action | Why |
|---|---|---|---|
| `permissions.deny` | Edit/Write/Read on `.env*`, `node_modules/**`, `.next/**` | Block at the harness level | Protect secrets and generated artifacts without spending hook execution. |
| `SessionStart` hook | every new context | `scripts/hooks/session-start.mjs` — prints `git status --short` and the contents of `.claude/CURRENT_SPEC` | Every new context knows the in-flight spec. |
| `PostToolUse` hook | `Edit \| Write \| MultiEdit` | `scripts/hooks/post-edit.mjs` — runs `npm run typecheck` if a `.ts/.tsx` file changed; emits a `db:migrate` reminder if `prisma/schema.prisma` changed | Catch type drift immediately; never forget a migration. |
| `Stop` hook | end of every agent turn | `scripts/hooks/stop.mjs` — runs `npm run lint` and `npm run test:run`, surfaces failures | Don't ship a session that broke a previously-green project. |

Why permissions.deny instead of a `PreToolUse` block hook for `.env*`: the harness denies the call before any hook runs, so it's both faster and harder to bypass.

---

## Plugins

- **`anthropic-skills`** — used for `/security-review`, `/review`, and `/init` commands. `security-reviewer` agent invokes `/security-review` before merge.
- **No custom plugin.** Custom agents + skills already give us the workflow we need; packaging them into a plugin would only matter if we were sharing across multiple repos.

---

## How they compose
A typical feature pass looks like:

```
SessionStart hook → reminder of CURRENT_SPEC
   ↓
planner agent       → spec written/updated, user reviews
   ↓
provider-adapter    → reads provider-adapter-template skill, builds adapter
   ↓ (PostToolUse typecheck on each edit)
test-author         → adds Vitest tests against the spec's test plan
   ↓
security-reviewer   → invokes /security-review, checks the checklist
   ↓
Stop hook           → lint + test summary; user merges
```

Every step is reviewable, every guarantee has a hook or an agent owning it, and the spec is always the source of truth.
