// @vitest-environment node
//
// Tests for the optimistic-local-write helper used by `sendDraft`. The
// helper lives in the DB layer, not in the Server Action, so we exercise it
// directly against Prisma — no provider mocking required.

import { randomBytes, randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import type { SendDraft } from "@/lib/providers/types";
import { afterEach, describe, expect, it } from "vitest";
import { recordSentMessage } from "./record-sent-message";

const createdUserIds: string[] = [];

afterEach(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

async function createUserWithAccount(): Promise<{ userId: string; accountId: string; email: string }> {
  const user = await prisma.user.create({
    data: { email: `record-sent-${randomUUID()}@example.com` },
  });
  createdUserIds.push(user.id);
  const email = `mb-${randomUUID()}@example.com`;
  const account = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "gmail",
      emailAddress: email,
      encryptedSecret: randomBytes(16),
      secretIv: randomBytes(12),
      secretTag: randomBytes(16),
    },
  });
  return { userId: user.id, accountId: account.id, email };
}

function exampleDraft(overrides: Partial<SendDraft> = {}): SendDraft {
  return {
    to: [{ email: "rcpt@example.com" }],
    subject: "Hi",
    bodyHtml: "<p>Body</p>",
    ...overrides,
  };
}

describe("recordSentMessage", () => {
  it("creates a Thread + Message tagged SENT for a brand-new send", async () => {
    const { accountId, email } = await createUserWithAccount();

    const providerMessageId = `pmsg-${randomUUID()}`;
    const providerThreadId = `pth-${randomUUID()}`;
    const { threadDbId } = await recordSentMessage({
      accountId,
      fromAddress: { email },
      draft: exampleDraft({ subject: "Hello world" }),
      providerMessageId,
      providerThreadId,
    });

    const thread = await prisma.thread.findUnique({
      where: { id: threadDbId },
      include: { messages: true },
    });
    expect(thread).not.toBeNull();
    expect(thread?.subject).toBe("Hello world");
    expect(thread?.providerThreadId).toBe(providerThreadId);
    // The thread MUST carry the SENT label so it shows in the Sent folder.
    expect(Array.isArray(thread?.labels) ? (thread?.labels as unknown[]) : []).toContain("SENT");
    // And it must NOT carry INBOX — outbound mail does not belong in the
    // inbox view (Gmail mirrors a self-Cc'd message into INBOX via sync, but
    // the optimistic write deliberately stays conservative).
    expect(Array.isArray(thread?.labels) ? (thread?.labels as unknown[]) : []).not.toContain(
      "INBOX",
    );
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]?.providerMessageId).toBe(providerMessageId);
    expect(thread?.messages[0]?.isUnread).toBe(false);
  });

  it("merges SENT into an existing thread's labels on reply (preserves INBOX)", async () => {
    const { accountId, email } = await createUserWithAccount();

    // Seed a received thread already in INBOX — the scenario where the
    // user replies to an inbound message. Their reply must show up in
    // BOTH Inbox (because INBOX is still on the thread) and Sent
    // (because we'll add SENT now).
    const providerThreadId = `pth-${randomUUID()}`;
    const seeded = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId,
        subject: "Re: existing",
        lastMessageAt: new Date("2026-05-12T10:00:00Z"),
        unreadCount: 0,
        labels: ["INBOX"],
        participants: [{ email: "other@example.com" }],
      },
    });
    await prisma.message.create({
      data: {
        threadId: seeded.id,
        accountId,
        providerMessageId: `pmsg-inbound-${randomUUID()}`,
        providerThreadId,
        from: { email: "other@example.com" },
        to: [{ email }],
        cc: [],
        bcc: [],
        subject: "existing",
        snippet: "Hello",
        bodyHtml: null,
        bodyText: "Hello",
        receivedAt: new Date("2026-05-12T10:00:00Z"),
        isUnread: false,
        labels: ["INBOX"],
        inReplyTo: null,
        references: [],
      },
    });

    const { threadDbId } = await recordSentMessage({
      accountId,
      fromAddress: { email },
      draft: exampleDraft({
        subject: "Re: existing",
        to: [{ email: "other@example.com" }],
        inReplyTo: "msg-id-1",
      }),
      providerMessageId: `pmsg-reply-${randomUUID()}`,
      providerThreadId,
    });

    expect(threadDbId).toBe(seeded.id);
    const updated = await prisma.thread.findUnique({
      where: { id: seeded.id },
      include: { messages: true },
    });
    const labels = Array.isArray(updated?.labels) ? (updated?.labels as unknown[]) : [];
    // INBOX preserved, SENT added.
    expect(labels).toContain("INBOX");
    expect(labels).toContain("SENT");
    expect(updated?.messages).toHaveLength(2);
    // Other participant kept; "self" added.
    const participants = Array.isArray(updated?.participants)
      ? (updated?.participants as Array<{ email?: string }>)
      : [];
    const emails = participants.map((p) => p.email).filter(Boolean);
    expect(emails).toContain("other@example.com");
    expect(emails).toContain(email);
  });

  it("is idempotent on replay — second call doesn't duplicate the message", async () => {
    // Background sync may pick up the just-sent message and call this same
    // path, OR the user may double-click submit. Either way, the
    // (accountId, providerMessageId) unique constraint means the second
    // call must no-op the message insert.
    const { accountId, email } = await createUserWithAccount();

    const providerMessageId = `pmsg-${randomUUID()}`;
    const providerThreadId = `pth-${randomUUID()}`;
    const params = {
      accountId,
      fromAddress: { email },
      draft: exampleDraft(),
      providerMessageId,
      providerThreadId,
    };

    const first = await recordSentMessage(params);
    const second = await recordSentMessage(params);
    expect(second.threadDbId).toBe(first.threadDbId);

    const messages = await prisma.message.findMany({
      where: { accountId, providerMessageId },
    });
    expect(messages).toHaveLength(1);
  });
});
