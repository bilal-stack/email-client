// Prisma wrappers for the `Draft` table. Every query is scoped by `userId`
// — there is no "lookup by id alone" path. Used by both Server Actions and
// the compose route's initial-paint loader.
//
// SQLite quirk: NULLs are distinct in a composite UNIQUE index, so the
// `(userId, threadId, mode)` constraint does NOT enforce singleton "new
// compose" per user when `threadId IS NULL`. We work around this in
// `upsertDraftForUser` by hand: for `threadId === null` we look up via
// `findFirst` and then either `update` or `create`. For the much more common
// `threadId !== null` reply/forward case, SQLite's unique constraint behaves
// correctly and we use the native upsert.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type DraftMode = "new" | "reply" | "reply-all" | "forward";

export interface DraftSlot {
  threadId: string | null;
  mode: DraftMode;
}

export interface UpsertDraftInput {
  draftId?: string;
  accountId: string;
  threadId: string | null;
  mode: DraftMode;
  to: unknown;
  cc: unknown;
  bcc: unknown;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string[];
  references?: string[];
}

export async function getDraftForUser(userId: string, slot: DraftSlot) {
  if (slot.threadId === null) {
    return prisma.draft.findFirst({
      where: { userId, threadId: null, mode: slot.mode },
    });
  }
  return prisma.draft.findUnique({
    where: {
      userId_threadId_mode: { userId, threadId: slot.threadId, mode: slot.mode },
    },
  });
}

export async function getDraftByIdForUser(userId: string, id: string) {
  return prisma.draft.findFirst({ where: { id, userId } });
}

export async function upsertDraftForUser(userId: string, input: UpsertDraftInput) {
  const toJson = input.to as Prisma.InputJsonValue;
  const ccJson = input.cc as Prisma.InputJsonValue;
  const bccJson = input.bcc as Prisma.InputJsonValue;
  const inReplyToJson = (input.inReplyTo ?? []) as unknown as Prisma.InputJsonValue;
  const referencesJson = (input.references ?? []) as unknown as Prisma.InputJsonValue;

  // threadId === null can't use Prisma's `upsert` because SQLite treats NULL
  // as distinct in the composite unique index — `upsert` would always insert.
  if (input.threadId === null) {
    const existing = await prisma.draft.findFirst({
      where: { userId, threadId: null, mode: input.mode },
    });
    if (existing) {
      return prisma.draft.update({
        where: { id: existing.id },
        data: {
          accountId: input.accountId,
          to: toJson,
          cc: ccJson,
          bcc: bccJson,
          subject: input.subject,
          bodyHtml: input.bodyHtml,
          inReplyTo: inReplyToJson,
          references: referencesJson,
        },
      });
    }
    return prisma.draft.create({
      data: {
        userId,
        accountId: input.accountId,
        threadId: null,
        mode: input.mode,
        to: toJson,
        cc: ccJson,
        bcc: bccJson,
        subject: input.subject,
        bodyHtml: input.bodyHtml,
        inReplyTo: inReplyToJson,
        references: referencesJson,
      },
    });
  }

  return prisma.draft.upsert({
    where: {
      userId_threadId_mode: { userId, threadId: input.threadId, mode: input.mode },
    },
    create: {
      userId,
      accountId: input.accountId,
      threadId: input.threadId,
      mode: input.mode,
      to: toJson,
      cc: ccJson,
      bcc: bccJson,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      inReplyTo: inReplyToJson,
      references: referencesJson,
    },
    update: {
      accountId: input.accountId,
      to: toJson,
      cc: ccJson,
      bcc: bccJson,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      inReplyTo: inReplyToJson,
      references: referencesJson,
    },
  });
}

export async function deleteDraftForUser(userId: string, id: string) {
  // Filter by id AND userId — never delete someone else's draft.
  return prisma.draft.deleteMany({ where: { id, userId } });
}
