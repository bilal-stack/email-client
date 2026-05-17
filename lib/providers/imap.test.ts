// @vitest-environment node
// Load-bearing tests for the IMAP provider adapter. Focus areas:
//   - Threading lookup-then-mint (`resolveThreadId`) — both branches.
//   - `syncDelta` cold-start cursor format.
//   - `syncDelta` UIDVALIDITY drift → AuthError; host NOT echoed.
//   - `setLabels` system-label → IMAP flag translation; user labels dropped silently.
//
// Per-method happy paths for `listThreads`, `getThread`, `sendMessage`, etc.
// are thin wrappers around imapflow — manual smoke testing is the right gate
// per the spec, not an MVP unit test.

import { randomUUID } from "node:crypto";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── imapflow mock (vi.hoisted state) ─────────────────────────────────────
// vi.mock factories are hoisted; module-scope variables referenced inside them
// would be undefined at mock-time. vi.hoisted lifts the shared state alongside
// the factory so the mock class can reach it.

interface ImapState {
  uidValidity: bigint | number;
  uidNext: number;
  fetched: Iterable<unknown>;
  searchResults: Map<string, number[]>;
  flagsAddCalls: Array<{ uids: number[]; flags: string[] }>;
  flagsRemoveCalls: Array<{ uids: number[]; flags: string[] }>;
  moveCalls: Array<{ uids: number[]; dest: string }>;
}

const hoisted = vi.hoisted(() => {
  const state: { current: ImapState | null } = { current: null };
  return { state };
});

function freshImapState(): ImapState {
  return {
    uidValidity: 1111n,
    uidNext: 100,
    fetched: [],
    searchResults: new Map(),
    flagsAddCalls: [],
    flagsRemoveCalls: [],
    moveCalls: [],
  };
}

vi.mock("imapflow", () => {
  class MockImapFlow {
    mailbox: { uidValidity: bigint | number; uidNext: number } | null = null;
    async connect() {
      return;
    }
    async logout() {
      return;
    }
    async mailboxOpen(_path: string) {
      const s = hoisted.state.current;
      if (!s) throw new Error("ImapState not initialized");
      this.mailbox = { uidValidity: s.uidValidity, uidNext: s.uidNext };
      return this.mailbox;
    }
    async listTree() {
      return { path: "", folders: [{ path: "INBOX", folders: [] }] };
    }
    async *fetch(_range: unknown, _fields: unknown, _opts?: unknown) {
      const s = hoisted.state.current;
      if (!s) return;
      for (const msg of s.fetched) yield msg;
    }
    async search(query: { header?: Record<string, string> }, _opts?: unknown) {
      const s = hoisted.state.current;
      const headerMid = query.header?.["message-id"];
      if (s && headerMid && s.searchResults.has(headerMid)) {
        return s.searchResults.get(headerMid) ?? [];
      }
      return [];
    }
    async messageFlagsAdd(uids: number[], flags: string[], _opts?: unknown) {
      hoisted.state.current?.flagsAddCalls.push({ uids, flags });
    }
    async messageFlagsRemove(uids: number[], flags: string[], _opts?: unknown) {
      hoisted.state.current?.flagsRemoveCalls.push({ uids, flags });
    }
    async messageMove(uids: number[], dest: string, _opts?: unknown) {
      hoisted.state.current?.moveCalls.push({ uids, dest });
    }
  }
  return { ImapFlow: MockImapFlow };
});

// mailparser is exercised inside normalizeFetchedMessage. None of these tests
// supply a `source` field, so mailparser is never called — but we stub it
// defensively to keep the module graph cheap.
vi.mock("mailparser", () => ({
  simpleParser: vi.fn(async () => ({
    html: null,
    text: null,
    attachments: [],
    headers: new Map(),
  })),
}));

// SSRF guard is exercised in `lib/auth/imap-host-guard.test.ts`. Stubbed here
// so we can point at any host without DNS resolution.
vi.mock("@/lib/auth/imap-host-guard", () => ({
  assertHostAllowed: vi.fn(async () => undefined),
}));

// ─── Imports under test ───────────────────────────────────────────────────
// Must come AFTER the mocks above so the adapter binds the mocked modules.
import { AuthError } from "./errors";
import { ImapProvider, resolveThreadId } from "./imap";

// ─── Helpers ──────────────────────────────────────────────────────────────

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

async function createImapAccount(): Promise<{ accountId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `imap-${randomUUID()}@example.com` },
  });
  const secret = {
    kind: "imap" as const,
    password: "app-password",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 465,
  };
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "imap",
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    },
  });
  createdAccountIds.push(row.id);
  createdUserIds.push(user.id);
  return { accountId: row.id, userId: user.id };
}

beforeEach(() => {
  hoisted.state.current = freshImapState();
});

afterEach(async () => {
  if (createdAccountIds.length) {
    await prisma.mailAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
    createdAccountIds.length = 0;
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

describe("resolveThreadId — lookup-then-mint", () => {
  it("returns the parent's threadId when inReplyTo matches an existing message; mints from its own id when there's no parent in the DB", async () => {
    const { accountId } = await createImapAccount();

    // Seed: a stored message with providerMessageId=abc@example.com whose
    // thread root is known. resolveThreadId should look it up by inReplyTo.
    const parentThread = await prisma.thread.create({
      data: {
        accountId,
        providerThreadId: "root-thread-id@example.com",
        subject: "Parent",
        lastMessageAt: new Date(),
        unreadCount: 0,
        labels: [] as unknown as Prisma.InputJsonValue,
        participants: [] as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.message.create({
      data: {
        threadId: parentThread.id,
        accountId,
        providerMessageId: "abc@example.com",
        providerThreadId: "root-thread-id@example.com",
        from: { email: "p@example.com" } as unknown as Prisma.InputJsonValue,
        to: [] as unknown as Prisma.InputJsonValue,
        cc: [] as unknown as Prisma.InputJsonValue,
        bcc: [] as unknown as Prisma.InputJsonValue,
        subject: "Parent",
        snippet: "Sn",
        receivedAt: new Date(),
        isUnread: false,
        labels: [] as unknown as Prisma.InputJsonValue,
        references: [] as unknown as Prisma.InputJsonValue,
      },
    });

    // Run both branches inside a single $transaction so the helper sees
    // the seeded row.
    await prisma.$transaction(async (tx) => {
      // Branch 1: parent found → returns the parent's providerThreadId.
      const found = await resolveThreadId(
        "new-msg@example.com",
        "abc@example.com",
        [],
        accountId,
        tx,
      );
      expect(found).toBe("root-thread-id@example.com");

      // Branch 2: parent NOT in DB → mints from the message's own id.
      const minted = await resolveThreadId(
        "new-msg@example.com",
        "unknown@example.com",
        [],
        accountId,
        tx,
      );
      expect(minted).toBe("new-msg@example.com");
    });
  });
});

describe("ImapProvider.syncDelta", () => {
  it("cold start (null cursor) records <UIDVALIDITY>:<uidNext-1> and returns empty arrays", async () => {
    const { accountId } = await createImapAccount();
    hoisted.state.current!.uidValidity = 1234n;
    hoisted.state.current!.uidNext = 50;
    // No messages fetched — cold start path doesn't fetch.
    hoisted.state.current!.fetched = [];

    const provider = new ImapProvider(accountId);
    const delta = await provider.syncDelta(null);

    expect(delta.newMessages).toEqual([]);
    expect(delta.changedMessages).toEqual([]);
    expect(delta.deletedIds).toEqual([]);
    expect(delta.nextCursor).toBe("1234:49");
  });

  it("UIDVALIDITY drift throws AuthError with the canonical reconnect message; host is NOT echoed", async () => {
    const { accountId } = await createImapAccount();
    hoisted.state.current!.uidValidity = 1111n;
    hoisted.state.current!.uidNext = 10;

    const provider = new ImapProvider(accountId);
    // cursor encodes a different uidValidity → drift.
    await expect(provider.syncDelta("9999:42")).rejects.toBeInstanceOf(AuthError);

    try {
      await provider.syncDelta("9999:42");
      throw new Error("expected to throw");
    } catch (e) {
      const err = e as Error;
      expect(err.message).toBe("Mailbox state reset — reconnect required");
      // The host string must not appear anywhere in the message — defense
      // against a future drift of the error template.
      expect(err.message).not.toContain("imap.example.com");
    }
  });
});

describe("ImapProvider.setLabels — system-label → IMAP flag translation", () => {
  it("UNREAD added removes \\Seen; STARRED removed removes \\Flagged; user labels are silently dropped", async () => {
    const { accountId } = await createImapAccount();
    // resolveUidsByMessageIds uses `client.search({ header: { 'message-id': 'uid:42' }})`.
    // Map that to a UID so the flag-mutation calls fire.
    hoisted.state.current!.searchResults.set("uid:42", [42]);

    const provider = new ImapProvider(accountId);
    const result = await provider.setLabels(["uid:42"], ["Work", "UNREAD"], ["STARRED"]);
    expect(result).toBeUndefined();

    // Adding UNREAD → REMOVE \Seen.
    const seenRemoves = hoisted.state.current!.flagsRemoveCalls.filter((c) =>
      c.flags.includes("\\Seen"),
    );
    expect(seenRemoves).toHaveLength(1);
    expect(seenRemoves[0]?.uids).toEqual([42]);

    // Removing STARRED → REMOVE \Flagged.
    const flaggedRemoves = hoisted.state.current!.flagsRemoveCalls.filter((c) =>
      c.flags.includes("\\Flagged"),
    );
    expect(flaggedRemoves).toHaveLength(1);
    expect(flaggedRemoves[0]?.uids).toEqual([42]);

    // No flag-additions should have fired.
    expect(hoisted.state.current!.flagsAddCalls).toEqual([]);
    // No folder moves should have fired (TRASH not in add set; INBOX not in
    // remove set).
    expect(hoisted.state.current!.moveCalls).toEqual([]);
    // The "Work" user label produces NO IMAP call — silently dropped per spec
    // non-goal. The only IMAP mutations observed are the two flag removes.
    const totalImapMutations =
      hoisted.state.current!.flagsAddCalls.length +
      hoisted.state.current!.flagsRemoveCalls.length +
      hoisted.state.current!.moveCalls.length;
    expect(totalImapMutations).toBe(2);
  });
});
