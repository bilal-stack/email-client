// Per-thread summary generator. Server-only.
//
// Loads the (ownership-scoped) thread, assembles the user payload with
// prompt-injection-guard wrapping on every body, calls Anthropic via
// `callWithRetry` with a cached system prompt + tool-use forced output,
// validates the response shape with Zod, and returns the parsed result +
// usage breakdown + the exact `userMessageJson` we sent (for the trust
// modal).

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL_FAST, callWithRetry } from "./client";
import { wrapEmailBody } from "./prompt-injection-guard";
import {
  SUMMARY_PROMPT_V1,
  SUMMARY_TOOL,
  SummaryResultSchema,
} from "./prompts/summary";
import { getThreadByIdForUser } from "@/lib/db/inbox-queries";

const MAX_MESSAGES = 20;
const MAX_BODY_BYTES = 2048;

function truncateAt(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}… [truncated]`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface SummaryUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SummaryGenerationResult {
  tldr: string;
  ask?: string;
  decision?: string;
  deadline?: string;
  usage: SummaryUsage;
  promptVersion: "v1";
  model: string;
  userMessageJson: string;
}

export async function generateThreadSummary(
  threadId: string,
  userId: string,
): Promise<SummaryGenerationResult> {
  const thread = await getThreadByIdForUser(userId, threadId);
  if (!thread) throw new Error("Thread not found or not owned");

  const lastN = thread.messages.slice(-MAX_MESSAGES);
  const truncatedNote =
    thread.messages.length > MAX_MESSAGES
      ? `Showing last ${MAX_MESSAGES} of ${thread.messages.length} messages.`
      : null;

  const userPayload = {
    subject: thread.subject,
    participants: (thread.participants as unknown) ?? [],
    truncatedNote,
    messages: lastN.map((m) => {
      const bodySource = m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : "");
      return {
        from: m.from as unknown,
        receivedAt: m.receivedAt.toISOString(),
        body: wrapEmailBody(truncateAt(bodySource, MAX_BODY_BYTES)),
      };
    }),
  };
  const userMessageJson = JSON.stringify(userPayload);

  // The `as const`-frozen SUMMARY_TOOL declares `required: readonly ["tldr"]`,
  // while the SDK's `Tool` type wants a mutable `string[]`. The shape is
  // identical at runtime; cast once at the boundary rather than dropping the
  // `as const` (which the spec mandates so the registry can mirror it).
  const response: Anthropic.Messages.Message = await callWithRetry(() =>
    anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 512,
      system: [
        {
          type: "text",
          text: SUMMARY_PROMPT_V1,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [SUMMARY_TOOL as unknown as Anthropic.Messages.Tool],
      tool_choice: { type: "tool", name: "report_summary" },
      messages: [{ role: "user", content: userMessageJson }],
    }),
  );

  const toolUse = response.content.find(
    (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("Model did not call report_summary");
  const parsed = SummaryResultSchema.parse(toolUse.input);

  // Defense-in-depth: the system prompt says plain text only, but a stray tag
  // would otherwise reach the DTO and then the DOM. Strip on every field.
  const sanitize = (s: string | undefined) =>
    s ? s.replace(/<[^>]+>/g, "").trim() || undefined : undefined;

  return {
    tldr: sanitize(parsed.tldr) ?? "",
    ask: sanitize(parsed.ask),
    decision: sanitize(parsed.decision),
    deadline: sanitize(parsed.deadline),
    usage: response.usage as SummaryUsage,
    promptVersion: "v1",
    model: MODEL_FAST,
    userMessageJson,
  };
}
