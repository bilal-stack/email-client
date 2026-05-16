// Shared loader for the three reply variant routes
// (reply / reply-all / forward). Loads a thread + its latest message and
// checks ownership. Returns `null` when the thread is missing or not owned
// by the signed-in user — the route should call `notFound()`.

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import type { CanonicalAddress } from "@/lib/providers/types";

export interface ParentMessage {
  id: string;
  providerMessageId: string;
  inReplyTo: string | null;
  references: string[];
  from: CanonicalAddress;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  receivedAt: Date;
}

export interface LoadedParent {
  userId: string;
  threadId: string;
  thread: {
    id: string;
    accountId: string;
    providerThreadId: string;
    subject: string;
  };
  account: {
    id: string;
    emailAddress: string;
    displayName: string | null;
  };
  parent: ParentMessage;
}

export async function loadParentForCompose(threadId: string): Promise<LoadedParent | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  const userId = session.user.id;

  const thread = await prisma.thread.findFirst({
    where: { id: threadId, account: { userId } },
    include: {
      account: { select: { id: true, emailAddress: true, displayName: true } },
      messages: {
        orderBy: { receivedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!thread) return null;
  const latest = thread.messages[0];
  if (!latest) return null;

  return {
    userId,
    threadId,
    thread: {
      id: thread.id,
      accountId: thread.accountId,
      providerThreadId: thread.providerThreadId,
      subject: thread.subject,
    },
    account: {
      id: thread.account.id,
      emailAddress: thread.account.emailAddress,
      displayName: thread.account.displayName,
    },
    parent: {
      id: latest.id,
      providerMessageId: latest.providerMessageId,
      inReplyTo: latest.inReplyTo,
      references: jsonAsStrings(latest.references),
      from: jsonAsAddress(latest.from) ?? { email: "" },
      to: jsonAsAddresses(latest.to),
      cc: jsonAsAddresses(latest.cc),
      subject: latest.subject,
      bodyHtml: latest.bodyHtml,
      bodyText: latest.bodyText,
      receivedAt: latest.receivedAt,
    },
  };
}

function jsonAsAddress(v: unknown): CanonicalAddress | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { name?: unknown; email?: unknown };
  if (typeof r.email !== "string") return null;
  return typeof r.name === "string" ? { name: r.name, email: r.email } : { email: r.email };
}

function jsonAsAddresses(v: unknown): CanonicalAddress[] {
  if (!Array.isArray(v)) return [];
  const out: CanonicalAddress[] = [];
  for (const raw of v) {
    const a = jsonAsAddress(raw);
    if (a) out.push(a);
  }
  return out;
}

function jsonAsStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string");
}
