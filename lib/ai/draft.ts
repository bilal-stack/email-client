// Reply-draft generator. Server-only.
//
// Streams three tone variants (terse / friendly / detailed) for a thread
// reply in a single Anthropic tool-use call. The system prompt is
// prompt-cached; every email body in the user payload is wrapped via
// `wrapEmailBody` to defuse prompt-injection attempts; the user's recent
// sent messages (loaded via `loadSentSamples`) are passed in their own
// <sent-samples> tag for tone matching.
//
// The generator returns three RSC streamables + a `donePromise`. The
// streamables receive progressive `update()` calls as `input_json_delta`
// events arrive from the SDK; the final validated tool_use input is
// pushed into each before they `done()`. On any throw, each streamable
// receives `.error(e)` and the promise rejects so the Server Action can
// translate it into a canonical user-facing string.

import type Anthropic from "@anthropic-ai/sdk";
import { createStreamableValue, type StreamableValue } from "ai/rsc";
import { prisma } from "@/lib/db";
import { getThreadByIdForUser } from "@/lib/db/inbox-queries";
import { anthropic, MODEL_BEST } from "./client";
import { wrapEmailBody } from "./prompt-injection-guard";
import {
  DRAFT_PROMPT_V1,
  DRAFT_TOOL,
  DraftResultSchema,
} from "./prompts/draft";

const MAX_THREAD_MESSAGES = 20;
const MAX_BODY_BYTES = 2048;
const MAX_SENT_SAMPLES = 5;
const MAX_SAMPLE_BYTES = 1024;

export interface StreamReplyDraftInput {
  threadId: string;
  mode: "reply" | "reply-all" | "forward";
  accountId: string;
}

export interface StreamReplyDraftResult {
  terseStream: StreamableValue<string>;
  friendlyStream: StreamableValue<string>;
  detailedStream: StreamableValue<string>;
  donePromise: Promise<void>;
}

export async function streamReplyDraft(
  input: StreamReplyDraftInput,
  userId: string,
): Promise<StreamReplyDraftResult> {
  const thread = await getThreadByIdForUser(userId, input.threadId);
  if (!thread) throw new Error("Thread not found or not owned");

  const lastN = thread.messages.slice(-MAX_THREAD_MESSAGES);
  const truncatedNote =
    thread.messages.length > MAX_THREAD_MESSAGES
      ? `Showing last ${MAX_THREAD_MESSAGES} of ${thread.messages.length} messages.`
      : null;

  const sentSamples = await loadSentSamples(
    input.accountId,
    userId,
    MAX_SENT_SAMPLES,
  );
  const samplesXml = sentSamples
    .map(
      (s) =>
        `<sent-sample><subject>${escapeXmlText(s.subject)}</subject><body>${wrapEmailBody(truncateAt(s.bodyText, MAX_SAMPLE_BYTES))}</body></sent-sample>`,
    )
    .join("");

  const userPayload = {
    mode: input.mode,
    subject: thread.subject,
    participants: (thread.participants as unknown) ?? [],
    truncatedNote,
    messages: lastN.map((m) => ({
      from: m.from as unknown,
      receivedAt: m.receivedAt.toISOString(),
      body: wrapEmailBody(
        truncateAt(
          m.bodyText ?? (m.bodyHtml ? stripHtml(m.bodyHtml) : ""),
          MAX_BODY_BYTES,
        ),
      ),
    })),
    sentSamplesXml: `<sent-samples>${samplesXml}</sent-samples>`,
  };
  const userMessageJson = JSON.stringify(userPayload);

  const terseStream = createStreamableValue<string>("");
  const friendlyStream = createStreamableValue<string>("");
  const detailedStream = createStreamableValue<string>("");

  const donePromise = (async () => {
    let buffer = "";
    try {
      // The `as const`-frozen DRAFT_TOOL declares `required` as a readonly
      // tuple, while the SDK's `Tool` type wants a mutable string[]. The
      // runtime shape is identical; cast once at the boundary.
      const stream = anthropic.messages.stream({
        model: MODEL_BEST,
        max_tokens: 4096,
        system: [
          {
            type: "text",
            text: DRAFT_PROMPT_V1,
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

      // Final parse — pull the validated tool_use input off the finalized
      // message. `messages.stream()` exposes `finalMessage()` for exactly
      // this purpose; it resolves once the stream has flushed.
      const final = await stream.finalMessage();
      const toolUse = final.content.find(
        (b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use",
      );
      if (!toolUse) throw new Error("Model did not call report_draft");
      const parsed = DraftResultSchema.parse(toolUse.input);

      // Defensive: ensure each streamable ends on the final validated value
      // even if the regex parser undershot on a tricky escape sequence.
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

/**
 * Permissive regex-based extractor for the current text value of a single
 * tool-use field inside a streaming JSON buffer. Reads up to wherever the
 * buffer ends — no closing quote required. The final `DraftResultSchema`
 * parse against the completed tool input is the rigorous check; this is
 * just for progressive UI updates.
 */
function extractFieldText(
  buffer: string,
  field: "terse" | "friendly" | "detailed",
): string | null {
  const m = new RegExp(
    `"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`,
    "s",
  ).exec(buffer);
  if (!m) return null;
  // Unescape JSON-style escapes: \", \\, \n, \r, \t.
  return m[1]!.replace(/\\(["\\nrt])/g, (_, c) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    return c; // " or \
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
 * Tone-matching helper — returns up to `limit` of the user's most recent
 * sent messages on the given account. Ownership-scoped at the query level
 * (`findFirst({ accountId, userId })` on MailAccount) so a tampered call
 * with someone else's accountId returns `[]` rather than leaking sent
 * mail. Provider-neutral: the JS-side filter picks rows whose `from.email`
 * matches the account's address.
 *
 * Body source: prefer `bodyText`; fall back to a cheap `stripHtml` over
 * `bodyHtml`. Empty bodies are dropped. Each sample's body is truncated
 * at 1 KB before assembly into the user payload.
 *
 * Returns `[]` for users with no sent history; the prompt's "If
 * <sent-samples> is empty, default to neutral professional" clause picks
 * up the slack.
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

  // Pull a bounded recent batch and filter in JS. The Json `from` column
  // can't be cleanly index-searched on SQLite; ~50 rows is a tiny pull and
  // matches the technical-spec's pragmatic approach.
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
