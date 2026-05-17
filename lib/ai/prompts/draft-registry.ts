// Client-safe mirror of the draft prompt registry.
//
// Parallel to `summary-registry.ts`. A future "Show me the prompt" trust
// modal for drafts — a client component — needs to look up the prompt text
// + tool schema for the version that produced a stored draft. This file
// imports ONLY plain constants from `./draft.ts`, never `@anthropic-ai/sdk`,
// so importing it from a client component does not drag the SDK into the
// browser bundle.
//
// Registry persistence rule: NEVER delete a version entry. The current spec
// does not persist drafts to the DB, but the registry exists so a future
// spec can wire one up without a refactor — once stored rows reference a
// version key, pulling it orphans the lookup path. Enforced by code review.

import { DRAFT_PROMPT_V1, DRAFT_TOOL } from "./draft";

export const DRAFT_PROMPT_REGISTRY = {
  v1: { text: DRAFT_PROMPT_V1, tool: DRAFT_TOOL },
} as const;

export type DraftPromptVersion = keyof typeof DRAFT_PROMPT_REGISTRY;

export function getDraftPromptForVersion(
  v: string,
): { text: string; tool: typeof DRAFT_TOOL } | null {
  return (
    (DRAFT_PROMPT_REGISTRY as Record<
      string,
      { text: string; tool: typeof DRAFT_TOOL }
    >)[v] ?? null
  );
}
