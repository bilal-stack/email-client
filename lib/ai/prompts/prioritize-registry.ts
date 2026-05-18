// Client-safe mirror of the prioritize prompt registry.
//
// Parallel to `summary-registry.ts` / `draft-registry.ts`. A future "Show me
// the prompt" trust modal for prioritization — a client component — needs to
// look up the prompt text + tool schema for the version that produced a
// stored `PriorityScore` row. This file imports ONLY plain constants from
// `./prioritize.ts`, never `@anthropic-ai/sdk`, so importing it from a client
// component does not drag the SDK into the browser bundle.
//
// Registry persistence rule: NEVER delete a version entry. Stored
// `PriorityScore` rows reference these keys; pulling an entry orphans the
// modal render path. Enforced by code review.

import { PRIORITIZE_PROMPT_V1, PRIORITIZE_TOOL } from "./prioritize";

export const PRIORITIZE_PROMPT_REGISTRY = {
  v1: { text: PRIORITIZE_PROMPT_V1, tool: PRIORITIZE_TOOL },
} as const;

export type PrioritizePromptVersion = keyof typeof PRIORITIZE_PROMPT_REGISTRY;

export function getPrioritizePromptForVersion(
  v: string,
): { text: string; tool: typeof PRIORITIZE_TOOL } | null {
  return (
    (PRIORITIZE_PROMPT_REGISTRY as Record<
      string,
      { text: string; tool: typeof PRIORITIZE_TOOL }
    >)[v] ?? null
  );
}
