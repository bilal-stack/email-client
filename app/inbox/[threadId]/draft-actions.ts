"use server";

// `requestAIDraft` — Server Action behind the AI reply-draft panel.
//
// Flow: auth → input validation → per-user rate limit → ownership-scoped
// existence check on (threadId, accountId, account.userId) → invoke the
// streaming generator → return the three RSC streamables.
//
// AI-side error handling lives here (not the canonical-errors helper —
// that's for ProviderError on the provider adapters). Anthropic errors
// map to one of four fixed user-facing strings; the raw `e.message` is
// never echoed because it can include request ids and other
// operator-visible detail.

import Anthropic from "@anthropic-ai/sdk";
import { type StreamableValue } from "ai/rsc";
import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import { streamReplyDraft } from "@/lib/ai/draft";
import { checkRateLimit } from "@/lib/ai/rate-limit";
import { prisma } from "@/lib/db";

const RequestAIDraftInput = z.object({
  threadId: z.string().cuid(),
  accountId: z.string().cuid(),
  mode: z.enum(["reply", "reply-all", "forward"]),
});

export type RequestAIDraftResult =
  | {
      ok: true;
      terseStream: StreamableValue<string>;
      friendlyStream: StreamableValue<string>;
      detailedStream: StreamableValue<string>;
    }
  | { ok: false; error: string };

export async function requestAIDraft(
  input: z.input<typeof RequestAIDraftInput>,
): Promise<RequestAIDraftResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };

  const parsed = RequestAIDraftInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Draft generation failed. Please try again." };
  }

  const rl = checkRateLimit(session.user.id, "ai-draft");
  if (!rl.ok) {
    return { ok: false, error: "Too many AI requests. Please wait a moment." };
  }

  // Ownership: thread row exists AND lives on the requested account AND
  // that account belongs to the authenticated user. A single findFirst
  // enforces all three.
  const owned = await prisma.thread.findFirst({
    where: {
      id: parsed.data.threadId,
      accountId: parsed.data.accountId,
      account: { userId: session.user.id },
    },
    select: { id: true },
  });
  if (!owned) {
    return { ok: false, error: "Draft generation failed. Please try again." };
  }

  try {
    const result = await streamReplyDraft(parsed.data, session.user.id);
    return {
      ok: true,
      terseStream: result.terseStream,
      friendlyStream: result.friendlyStream,
      detailedStream: result.detailedStream,
    };
  } catch (e) {
    return { ok: false, error: aiErrorMessage(e) };
  }
}

/**
 * Map any thrown error from the streaming generator (or its
 * synchronously-thrown setup phase) to one of four fixed user-facing
 * strings. NEVER echo `e.message` — Anthropic's error messages can
 * contain request ids and other operator-visible detail we don't want
 * to surface to a client.
 */
function aiErrorMessage(e: unknown): string {
  if (e instanceof ZodError) return "Draft generation failed. Please try again.";
  if (e instanceof Anthropic.APIError) {
    if (e.status === 429) return "Too many AI requests. Please wait a moment.";
    if (e.status === 503 || e.status === 529) {
      return "AI service is busy. Please try again.";
    }
  }
  return "Draft generation failed. Please try again.";
}
