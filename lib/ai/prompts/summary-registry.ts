// Client-safe mirror of the summary prompt registry.
//
// The "Show me the prompt" trust modal — a client component — needs to look
// up the prompt text + tool schema for the `promptVersion` stored on the
// `AISummary` row. This file imports ONLY plain constants from
// `./summary.ts`, never `@anthropic-ai/sdk`, so importing it from a client
// component does not drag the SDK into the browser bundle.
//
// Registry persistence rule: NEVER delete a version entry. Stored
// `AISummary` rows reference these keys; pulling an entry orphans the modal
// render path. Enforced by code review.

import { SUMMARY_PROMPT_V1, SUMMARY_TOOL } from "./summary";

export const SUMMARY_PROMPT_REGISTRY = {
  v1: { text: SUMMARY_PROMPT_V1, tool: SUMMARY_TOOL },
} as const;

export type SummaryPromptVersion = keyof typeof SUMMARY_PROMPT_REGISTRY;

export function getSummaryPromptForVersion(
  v: string,
): { text: string; tool: typeof SUMMARY_TOOL } | null {
  return (
    (SUMMARY_PROMPT_REGISTRY as Record<
      string,
      { text: string; tool: typeof SUMMARY_TOOL }
    >)[v] ?? null
  );
}
