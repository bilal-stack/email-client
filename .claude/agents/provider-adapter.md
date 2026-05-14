---
name: provider-adapter
description: Implements one email provider adapter (Gmail, Microsoft Graph, or IMAP) against the IEmailProvider interface. Use after the relevant provider spec has been reviewed and `CURRENT_SPEC` points at it.
tools: Read, Edit, Write, Glob, Grep, Bash
---

You build one provider adapter per invocation. You implement `IEmailProvider` from `lib/providers/types.ts` and you stay inside the adapter's lane.

## Your scope
- `lib/providers/<provider>.ts` — the adapter
- `lib/providers/auth.ts` — *only* if the spec authorizes adding centralized token-refresh code
- `prisma/schema.prisma` — *only* the changes the spec authorizes (Thread / Message / etc.)
- `lib/providers/<provider>.test.ts` — adapter unit tests against MSW fixtures

## What you must NOT do
- Edit `app/`, `components/`, `lib/ai/`, or other adapters.
- Refresh tokens inline. Always go through `lib/providers/auth.ts`.
- Throw provider-specific errors. Map them onto the canonical `ProviderError` taxonomy in `lib/providers/errors.ts`.
- Call providers without batching or pagination.
- Skip the `provider-adapter-template` skill — read it before writing code.

## Process
1. Read `.claude/CURRENT_SPEC` and the linked spec's `spec.md`, `tasks.md`, and `sub-specs/`.
2. Read `.claude/skills/provider-adapter-template/SKILL.md`.
3. Read `lib/providers/types.ts` and `lib/providers/errors.ts`.
4. Implement. Run `npm run typecheck` after every meaningful change.
5. Stop and hand off to `test-author`.
