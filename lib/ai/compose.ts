// New-compose AI draft generator. Server-only.
//
// Mirrors `lib/ai/draft.ts`'s streaming three-variant flow but generates
// FROM A USER INTENT PROMPT instead of from a thread. There's no thread
// context to load, so the only DB read is the sent-samples lookup that
// feeds tone matching.
//
// Output schema is identical to the reply-draft path (terse / friendly /
// detailed), so we reuse `DRAFT_TOOL` and `DraftResultSchema`.

import type Anthropic from "@anthropic-ai/sdk";
import { createStreamableValue, type StreamableValue } from "ai/rsc";
import { prisma } from "@/lib/db";
import { anthropic, MODEL_BEST } from "./client";
import { wrapEmailBody } from "./prompt-injection-guard";
import { DRAFT_TOOL, DraftResultSchema } from "./prompts/draft";
import { COMPOSE_PROMPT_V1 } from "./prompts/compose";

const MAX_INTENT_CHARS = 1500;
const MAX_SENT_SAMPLES = 5;
const MAX_SAMPLE_BYTES = 1024;

export interface StreamComposeDraftInput {
  accountId: string;
  intent: string;
  subject: string;
  to: string[];
}

export interface StreamComposeDraftResult {
  terseStream: StreamableValue<string>;
  friendlyStream: StreamableValue<string>;
  detailedStream: StreamableValue<string>;
  donePromise: Promise<void>;
}

export async function streamComposeDraft(
  input: StreamComposeDraftInput,
  userId: string,
): Promise<StreamComposeDraftResult> {
  const intent = truncateAt(input.intent.trim(), MAX_INTENT_CHARS);

  const sentSamples = await loadSentSamples(input.accountId, userId, MAX_SENT_SAMPLES);
  const samplesXml = sentSamples
    .map(
      (s) =>
        `<sent-sample><subject>${escapeXmlText(s.subject)}</subject><body>${wrapEmailBody(truncateAt(s.bodyText, MAX_SAMPLE_BYTES))}</body></sent-sample>`,
    )
    .join("");

  const userPayload = {
    intent,
    subject: input.subject,
    recipients: input.to,
    sentSamplesXml: `<sent-samples>${samplesXml}</sent-samples>`,
  };
  const userMessageJson = JSON.stringify(userPayload);

  const terseStream = createStreamableValue<string>("");
  const friendlyStream = createStreamableValue<string>("");
  const detailedStream = createStreamableValue<string>("");

  const donePromise = (async () => {
    let buffer = "";
    try {
      const stream = anthropic.messages.stream({
        model: MODEL_BEST,
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: COMPOSE_PROMPT_V1,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: [DRAFT_TOOL as unknown as Anthropic.Messages.Tool],
        tool_choice: { type: "tool", name: "report_draft" },
        messages: [{ role: "user", content: userMessageJson }],
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "input_json_delta"
        ) {
          buffer += event.delta.partial_json;
          const t = extractFieldText(buffer, "terse");
          const f = extractFieldText(buffer, "friendly");
          const d = extractFieldText(buffer, "detailed");
          if (t !== null) terseStream.update(t);
          if (f !== null) friendlyStream.update(f);
          if (d !== null) detailedStream.update(d);
        }
      }

      const final = await stream.finalMessage();
      const toolUse = final.content.find(
        (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (!toolUse) throw new Error("Model did not call report_draft");
      const parsed = DraftResultSchema.parse(toolUse.input);

      terseStream.update(parsed.terse);
      friendlyStream.update(parsed.friendly);
      detailedStream.update(parsed.detailed);
      terseStream.done();
      friendlyStream.done();
      detailedStream.done();
    } catch (e) {
      terseStream.error(e);
      friendlyStream.error(e);
      detailedStream.error(e);
      throw e;
    }
  })();

  return {
    terseStream: terseStream.value,
    friendlyStream: friendlyStream.value,
    detailedStream: detailedStream.value,
    donePromise,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────
// Duplicated from `./draft.ts` rather than exported across modules — the
// shapes here are private-by-convention and an exported helper would
// invite drift between the two files. Keeping them parallel is cheap.

function extractFieldText(
  buffer: string,
  field: "terse" | "friendly" | "detailed",
): string | null {
  const m = new RegExp(
    `"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`,
    "s",
  ).exec(buffer);
  if (!m) return null;
  return m[1]!.replace(/\\(["\\nrt])/g, (_, c) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    return c;
  });
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

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

/**
 * Same shape as `loadSentSamples` in `./draft.ts`. Pulled into this file so
 * the new-compose path doesn't import from a sibling AI module and so the
 * two flows can evolve their tone-matching independently if needed later.
 */
async function loadSentSamples(
  accountId: string,
  userId: string,
  limit: number,
): Promise<Array<{ subject: string; bodyText: string }>> {
  const account = await prisma.mailAccount.findFirst({
    where: { id: accountId, userId },
    select: { emailAddress: true },
  });
  if (!account) return [];

  const rows = await prisma.message.findMany({
    where: { accountId },
    orderBy: { receivedAt: "desc" },
    take: 50,
    select: { from: true, subject: true, bodyText: true, bodyHtml: true },
  });
  const ownEmail = account.emailAddress.toLowerCase();
  const samples: Array<{ subject: string; bodyText: string }> = [];
  for (const r of rows) {
    const fromEmail = (r.from as { email?: string } | null)?.email?.toLowerCase();
    if (fromEmail !== ownEmail) continue;
    const body = r.bodyText ?? (r.bodyHtml ? stripHtml(r.bodyHtml) : "");
    if (!body) continue;
    samples.push({ subject: r.subject, bodyText: body });
    if (samples.length >= limit) break;
  }
  return samples;
}
