// Optimistically persist a just-sent message into the local DB so the user
// sees it in the Sent folder (and threaded into the original conversation,
// if it was a reply) within milliseconds — without waiting for the next
// provider-sync tick. Background sync (gmail-sync.ts / graph-sync.ts) is
// idempotent via the `(accountId, providerMessageId)` unique constraint, so
// if a delta later returns the same message, `writeDelta` will see the row
// already exists and skip it.
//
// All writes are wrapped in a single transaction so a partial failure can't
// leave us with a Thread row without its Message (or vice versa).

import { prisma } from "@/lib/db";
import type { CanonicalAddress, SendDraft } from "@/lib/providers/types";
import type { Prisma } from "@prisma/client";

export interface RecordSentMessageInput {
  /// Local MailAccount.id — the row this message belongs to.
  accountId: string;
  /// The sender's address — used to populate `Message.from` so the Sent-
  /// folder row renders a sensible "From" line. Provider responses don't
  /// include this; the caller (the Server Action that owns the account)
  /// already has it.
  fromAddress: CanonicalAddress;
  /// The draft as sent (post-sanitization). We persist its sanitized HTML
  /// body verbatim and derive the snippet from it.
  draft: SendDraft;
  /// The provider's id for the message, as returned by `sendMessage` / `reply`.
  providerMessageId: string;
  /// The provider's id for the thread the message landed in. For a fresh
  /// "new compose" this is whatever id the provider auto-assigned (Gmail
  /// reuses `result.threadId === result.id`; Graph mints a separate
  /// conversation id).
  providerThreadId: string;
}

/**
 * Strip HTML tags and collapse whitespace to produce a list-row preview.
 * Same shape `inbox-queries.ts → listDraftsForUser` uses for the drafts
 * folder, kept locally to avoid an import cycle.
 */
function htmlToSnippet(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function uniqueParticipants(
  addresses: ReadonlyArray<CanonicalAddress>,
): CanonicalAddress[] {
  const out: CanonicalAddress[] = [];
  const seen = new Set<string>();
  for (const a of addresses) {
    if (a.email && !seen.has(a.email)) {
      out.push(a);
      seen.add(a.email);
    }
  }
  return out;
}

/**
 * Insert the just-sent message into the local DB. Returns `{ threadDbId }`
 * — the caller can navigate the user to `/inbox/${threadDbId}` to land
 * them on the thread view straight away.
 *
 * Idempotency: if a row with the same `(accountId, providerMessageId)` is
 * already present (e.g. a background sync raced us between the provider
 * call and this write), we no-op the message insert and still return the
 * existing thread's DB id.
 */
export async function recordSentMessage(
  input: RecordSentMessageInput,
): Promise<{ threadDbId: string }> {
  const { accountId, fromAddress, draft, providerMessageId, providerThreadId } = input;

  const sentAt = new Date();
  const snippet = htmlToSnippet(draft.bodyHtml);
  const labels = ["SENT"];
  // We deliberately do NOT add INBOX. A sent message belongs in the Sent
  // folder; if the provider later mirrors it into INBOX (e.g. you Cc'd
  // yourself), the sync will overwrite the labels via `writeDelta`'s
  // `changedMessages` path.

  const participantsForThread = uniqueParticipants([
    fromAddress,
    ...draft.to,
    ...(draft.cc ?? []),
    ...(draft.bcc ?? []),
  ]);

  return prisma.$transaction(async (tx) => {
    // ── 1. Upsert the thread row ─────────────────────────────────
    const thread = await tx.thread.upsert({
      where: {
        accountId_providerThreadId: {
          accountId,
          providerThreadId,
        },
      },
      update: {
        subject: draft.subject,
        lastMessageAt: sentAt,
        // Replies leave existing labels in place; we just guarantee SENT
        // is present so the thread shows up in the Sent view. We can't
        // read-then-write the labels array atomically in Prisma, so we do
        // it in two steps below.
      },
      create: {
        accountId,
        providerThreadId,
        subject: draft.subject,
        lastMessageAt: sentAt,
        unreadCount: 0,
        labels: labels as unknown as Prisma.InputJsonValue,
        participants: participantsForThread as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, labels: true, participants: true },
    });

    // ── 1b. Ensure SENT is in the labels array (for the reply case). ──
    const existingLabels = Array.isArray(thread.labels)
      ? (thread.labels as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    if (!existingLabels.includes("SENT")) {
      const mergedLabels = [...existingLabels, "SENT"];
      // Merge participants too — replies to/from new people grow the set.
      const existingParticipants = Array.isArray(thread.participants)
        ? (thread.participants as Array<{ email?: string; name?: string }>)
        : [];
      const seenEmails = new Set(
        existingParticipants.map((p) => p.email).filter((e): e is string => Boolean(e)),
      );
      const mergedParticipants = [...existingParticipants];
      for (const p of participantsForThread) {
        if (p.email && !seenEmails.has(p.email)) {
          mergedParticipants.push(p);
          seenEmails.add(p.email);
        }
      }
      await tx.thread.update({
        where: { id: thread.id },
        data: {
          labels: mergedLabels as unknown as Prisma.InputJsonValue,
          participants: mergedParticipants as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // ── 2. Insert the message row (idempotent on replays) ─────────
    const existing = await tx.message.findUnique({
      where: {
        accountId_providerMessageId: {
          accountId,
          providerMessageId,
        },
      },
      select: { id: true },
    });
    if (!existing) {
      await tx.message.create({
        data: {
          threadId: thread.id,
          accountId,
          providerMessageId,
          providerThreadId,
          from: fromAddress as unknown as Prisma.InputJsonValue,
          to: draft.to as unknown as Prisma.InputJsonValue,
          cc: (draft.cc ?? []) as unknown as Prisma.InputJsonValue,
          bcc: (draft.bcc ?? []) as unknown as Prisma.InputJsonValue,
          subject: draft.subject,
          snippet,
          bodyHtml: draft.bodyHtml,
          bodyText: null,
          receivedAt: sentAt,
          isUnread: false,
          labels: labels as unknown as Prisma.InputJsonValue,
          inReplyTo: draft.inReplyTo ?? null,
          references: (draft.references ?? []) as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return { threadDbId: thread.id };
  });
}
