"use server";

// `requestAIComposeDraft` — Server Action behind the new-compose AI panel
// (`AIComposePanel`). Mirrors `requestAIDraft` in
// `app/inbox/[threadId]/draft-actions.ts` but for the brand-new compose
// path: no thread context, the user's typed intent IS the seed.
//
// Flow: auth → Zod validation (incl. intent length cap) → per-user rate
// limit → ownership check (the accountId belongs to the caller) → invoke
// the streaming generator → return the three RSC streamables.

import Anthropic from "@anthropic-ai/sdk";
import { type StreamableValue } from "ai/rsc";
import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import { streamComposeDraft } from "@/lib/ai/compose";
import { checkRateLimit } from "@/lib/ai/rate-limit";
import { prisma } from "@/lib/db";

const RequestAIComposeDraftInput = z.object({
  accountId: z.string().cuid(),
  intent: z.string().min(1, "Tell the AI what you want to write.").max(1500),
  subject: z.string().max(998).default(""),
  to: z.array(z.string().email()).max(50).default([]),
});

export type RequestAIComposeDraftResult =
  | {
      ok: true;
      terseStream: StreamableValue<string>;
      friendlyStream: StreamableValue<string>;
      detailedStream: StreamableValue<string>;
    }
  | { ok: false; error: string };

export async function requestAIComposeDraft(
  input: z.input<typeof RequestAIComposeDraftInput>,
): Promise<RequestAIComposeDraftResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };

  const parsed = RequestAIComposeDraftInput.safeParse(input);
  if (!parsed.success) {
    // Surface the first user-facing message when present (e.g. the empty-
    // intent guard), otherwise the same canonical phrase as the reply path.
    const first = parsed.error.issues[0]?.message;
    return {
      ok: false,
      error: first ?? "Draft generation failed. Please try again.",
    };
  }

  const rl = checkRateLimit(session.user.id, "ai-draft");
  if (!rl.ok) {
    return { ok: false, error: "Too many AI requests. Please wait a moment." };
  }

  // Ownership: the supplied accountId must belong to the authenticated user.
  // Single findFirst enforces both.
  const owned = await prisma.mailAccount.findFirst({
    where: { id: parsed.data.accountId, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) {
    return { ok: false, error: "Draft generation failed. Please try again." };
  }

  try {
    const result = await streamComposeDraft(parsed.data, session.user.id);
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
