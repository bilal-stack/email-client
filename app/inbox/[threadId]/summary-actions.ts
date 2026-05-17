"use server";

// `summarizeThread` — the Server Action behind the per-thread summary banner.
//
// Flow: auth → input validation → per-user rate limit → ownership-scoped
// cached-summary lookup → return cached OR call generator + upsert + return
// fresh. On any internal error — including a Zod parse failure on a
// malformed model response — surface a single canonical user-facing string;
// never echo `e.message` to the client.

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { generateThreadSummary } from "@/lib/ai/summary";
import { checkRateLimit } from "@/lib/ai/rate-limit";
import type { Prisma, AISummary } from "@prisma/client";
import { z } from "zod";

const SummarizeInput = z.object({ threadId: z.string().cuid() });

export interface SummaryDTO {
  tldr: string;
  ask: string | null;
  decision: string | null;
  deadline: string | null;
  model: string;
  promptVersion: string;
  usage: unknown;
  userMessageJson: string;
  generatedAt: Date;
}

export async function summarizeThread(
  input: z.input<typeof SummarizeInput>,
): Promise<
  | { ok: true; data: SummaryDTO }
  | { ok: false; error: string; retryAfterSeconds?: number }
> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Unauthorized" };

  const parsed = SummarizeInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const rl = checkRateLimit(session.user.id, "summarize");
  if (!rl.ok) {
    return {
      ok: false,
      error: "Rate limit exceeded",
      retryAfterSeconds: rl.retryAfterSeconds,
    };
  }

  // Ownership-scoped existence check + cached-summary fetch in one query —
  // the `thread: { account: { userId } }` filter enforces the scope without
  // a separate Thread.findFirst.
  const cached = await prisma.aISummary.findFirst({
    where: {
      threadId: parsed.data.threadId,
      thread: { account: { userId: session.user.id } },
      invalidatedAt: null,
    },
  });
  if (cached) {
    return { ok: true, data: toDTO(cached) };
  }

  try {
    const result = await generateThreadSummary(
      parsed.data.threadId,
      session.user.id,
    );
    const row = await prisma.aISummary.upsert({
      where: { threadId: parsed.data.threadId },
      create: {
        threadId: parsed.data.threadId,
        tldr: result.tldr,
        ask: result.ask ?? null,
        decision: result.decision ?? null,
        deadline: result.deadline ?? null,
        model: result.model,
        promptVersion: result.promptVersion,
        usage: result.usage as unknown as Prisma.InputJsonValue,
        userMessageJson: result.userMessageJson,
      },
      update: {
        tldr: result.tldr,
        ask: result.ask ?? null,
        decision: result.decision ?? null,
        deadline: result.deadline ?? null,
        model: result.model,
        promptVersion: result.promptVersion,
        usage: result.usage as unknown as Prisma.InputJsonValue,
        userMessageJson: result.userMessageJson,
        invalidatedAt: null,
        generatedAt: new Date(),
      },
    });
    return { ok: true, data: toDTO(row) };
  } catch (e) {
    if (e instanceof Error && /Thread not found/.test(e.message)) {
      return { ok: false, error: "Not found" };
    }
    // Includes Zod parse failure on malformed tool-use output. Surface a
    // single canonical string; never echo `e.message`.
    return { ok: false, error: "Summary failed — please retry" };
  }
}

function toDTO(row: AISummary): SummaryDTO {
  return {
    tldr: row.tldr,
    ask: row.ask,
    decision: row.decision,
    deadline: row.deadline,
    model: row.model,
    promptVersion: row.promptVersion,
    usage: row.usage,
    userMessageJson: row.userMessageJson,
    generatedAt: row.generatedAt,
  };
}
