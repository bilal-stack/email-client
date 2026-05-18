// Per-message priority generator. Server-only.
//
// Loads the (ownership-scoped) message + its thread context (prior messages
// summarized to from + receivedAt + 100-char snippet only), assembles a user
// payload with the current message body wrapped in <email>...</email>,
// calls Anthropic via `callWithRetry` with a cached system prompt + tool-use
// forced output, Zod-validates, sanitizes the `reason` field, and returns
// the parsed result + usage + the exact `userMessageJson` we sent.

import type Anthropic from "@anthropic-ai/sdk";
import { anthropic, MODEL_FAST, callWithRetry } from "./client";
import { wrapEmailBody } from "./prompt-injection-guard";
import {
  PRIORITIZE_PROMPT_V1,
  PRIORITIZE_TOOL,
  PrioritizeResultSchema,
} from "./prompts/prioritize";
import { prisma } from "@/lib/db";

const MAX_CURRENT_BODY_BYTES = 4096;
const MAX_PRIOR_SNIPPET = 100;
const MAX_PRIOR_MESSAGES = 5;

interface PrioritizeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface PrioritizeGenerationResult {
  priority: number;
  reason: string;
  suggestedActions: Array<"reply" | "archive" | "snooze" | "delegate">;
  riskFlag: "phish" | "promo" | "ok";
  usage: PrioritizeUsage;
  promptVersion: "v1";
  model: string;
  userMessageJson: string;
}

export async function prioritizeMessage(
  messageId: string,
  userId: string,
): Promise<PrioritizeGenerationResult> {
  // Ownership-scoped load. The Inngest event payload carried a `userId`, but
  // we re-assert against the DB so a forged event can't lift another user's
  // message into a prioritization run.
  const message = await prisma.message.findFirst({
    where: { id: messageId, account: { userId } },
    include: {
      thread: {
        include: {
          messages: {
            orderBy: { receivedAt: "asc" },
            select: {
              id: true,
              from: true,
              receivedAt: true,
              bodyText: true,
              bodyHtml: true,
            },
          },
        },
      },
      attachments: { select: { id: true } },
    },
  });
  if (!message) throw new Error("Message not found or not owned");

  const priorMessages = message.thread.messages
    .filter((m) => m.id !== messageId && m.receivedAt < message.receivedAt)
    .slice(-MAX_PRIOR_MESSAGES)
    .map((m) => ({
      from: m.from as unknown,
      receivedAt: m.receivedAt.toISOString(),
      snippet: truncate(
        (m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : "")) || "",
        MAX_PRIOR_SNIPPET,
      ),
    }));

  const currentBody =
    (message.bodyText ?? (message.bodyHtml ? stripHtml(message.bodyHtml) : "")) || "";

  const userPayload = {
    subject: message.thread.subject,
    participants: (message.thread.participants as unknown) ?? [],
    priorMessages,
    currentMessage: {
      from: message.from as unknown,
      receivedAt: message.receivedAt.toISOString(),
      hasAttachments: message.attachments.length > 0,
      body: wrapEmailBody(truncate(currentBody, MAX_CURRENT_BODY_BYTES)),
    },
  };
  const userMessageJson = JSON.stringify(userPayload);

  // The `as const`-frozen PRIORITIZE_TOOL declares `required: readonly [...]`,
  // while the SDK's `Tool` type wants a mutable `string[]`. Identical at
  // runtime; cast once at the boundary rather than dropping the `as const`
  // (which the spec mandates so the registry can mirror it).
  const response: Anthropic.Messages.Message = await callWithRetry(() =>
    anthropic.messages.create({
      model: MODEL_FAST,
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: PRIORITIZE_PROMPT_V1,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: [PRIORITIZE_TOOL as unknown as Anthropic.Messages.Tool],
      tool_choice: { type: "tool", name: "report_priority" },
      messages: [{ role: "user", content: userMessageJson }],
    }),
  );

  const toolUse = response.content.find(
    (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
  );
  if (!toolUse) throw new Error("Model did not call report_priority");
  const parsed = PrioritizeResultSchema.parse(toolUse.input);

  return {
    priority: parsed.priority,
    reason: sanitizeReason(parsed.reason),
    suggestedActions: parsed.suggestedActions,
    riskFlag: parsed.riskFlag,
    usage: response.usage as PrioritizeUsage,
    promptVersion: "v1",
    model: MODEL_FAST,
    userMessageJson,
  };
}

// Belt-and-suspenders sanitization on the model-supplied `reason`. The Zod
// schema enforces 1–80 chars; the 6-word truncation is the user-facing
// display contract. Strips HTML tag attempts and link attempts before the
// truncate, so a sanitized reason can never carry markup or a URL to the DB.
function sanitizeReason(raw: string): string {
  let s = raw;
  s = s.replace(/<[^>]*>/g, ""); // strip HTML tag attempts
  s = s.replace(/https?:\/\/\S+/gi, ""); // strip link attempts
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return "AI flagged — see thread";
  const words = s.split(" ");
  if (words.length > 6) return words.slice(0, 6).join(" ");
  return s;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}… [truncated]`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
