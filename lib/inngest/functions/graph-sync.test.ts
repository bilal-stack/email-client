// @vitest-environment node
// Orchestration tests for the Graph sync inngest function. Writer mechanics
// are covered by `_write-delta.test.ts` — these tests only exercise the
// account-filter and the AuthError propagation contract.

import { randomUUID } from "node:crypto";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import type { MailboxSecret } from "@/lib/providers/auth";
import { AuthError } from "@/lib/providers/errors";
import { GraphProvider } from "@/lib/providers/graph";
import type { DeltaResult } from "@/lib/providers/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphSyncDelta } from "./graph-sync";

interface FakeStep {
  run: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function fakeStep(): FakeStep {
  return { run: (_name, fn) => fn() };
}

function invokeHandler(): Promise<unknown> {
  const handler = (
    graphSyncDelta as unknown as { fn: (ctx: { step: FakeStep }) => Promise<unknown> }
  ).fn;
  return handler({ step: fakeStep() });
}

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

async function createAccount(
  provider: "gmail" | "graph",
  syncCursor: string | null = null,
): Promise<{ accountId: string; userId: string }> {
  const user = await prisma.user.create({
    data: { email: `gs-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    kind: "oauth",
    accessToken: "AT",
    refreshToken: "RT",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "scope",
  };
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider,
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
      syncCursor,
    },
  });
  createdAccountIds.push(row.id);
  createdUserIds.push(user.id);
  return { accountId: row.id, userId: user.id };
}

// Scope `prisma.mailAccount.findMany` to a fixed set so concurrent test files
// don't bleed accounts into one another. Mirrors the pattern in gmail-sync.test.ts.
const findManyRestorers: Array<() => void> = [];
function scopeListAccounts(
  rows: Array<{ id: string; syncCursor: string | null; userId: string }>,
) {
  const delegate = prisma.mailAccount as unknown as Record<string, unknown>;
  const hadOwn = Object.hasOwn(delegate, "findMany");
  const originalDescriptor = hadOwn ? Object.getOwnPropertyDescriptor(delegate, "findMany") : null;
  Object.defineProperty(delegate, "findMany", {
    configurable: true,
    writable: true,
    value: async (_args: unknown) => rows,
  });
  findManyRestorers.push(() => {
    if (originalDescriptor) {
      Object.defineProperty(delegate, "findMany", originalDescriptor);
    } else {
      Reflect.deleteProperty(delegate, "findMany");
    }
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (findManyRestorers.length) findManyRestorers.pop()?.();
  if (createdAccountIds.length) {
    await prisma.mailAccount.deleteMany({ where: { id: { in: createdAccountIds } } });
    createdAccountIds.length = 0;
  }
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

describe("graphSyncDelta inngest function", () => {
  it("only calls GraphProvider.syncDelta for graph-backed accounts (gmail rows are skipped)", async () => {
    // Create one of each. The `where: { provider: "graph" }` filter on the
    // findMany call would normally exclude the gmail one; we stub findMany
    // to return ONLY the graph row to mirror what the filter produces. The
    // assertion is that GraphProvider.syncDelta is called exactly once with
    // the graph account id.
    const gmail = await createAccount("gmail", "GMAIL_CURSOR");
    const graph = await createAccount("graph", "GRAPH_CURSOR");

    // Scope to just the graph row — this is what `findMany({ where: { provider: "graph" }})`
    // would return at runtime.
    scopeListAccounts([
      { id: graph.accountId, syncCursor: "GRAPH_CURSOR", userId: graph.userId },
    ]);

    const syncSpy = vi
      .spyOn(GraphProvider.prototype, "syncDelta")
      .mockResolvedValue({
        newMessages: [],
        changedMessages: [],
        deletedIds: [],
        nextCursor: "NEXT",
      } satisfies DeltaResult);

    await invokeHandler();

    // Only the graph account was synced.
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith("GRAPH_CURSOR");

    // The gmail account row was NOT touched.
    const gm = await prisma.mailAccount.findUniqueOrThrow({ where: { id: gmail.accountId } });
    expect(gm.syncCursor).toBe("GMAIL_CURSOR");
    expect(gm.lastSyncedAt).toBeNull();

    // The graph account row HAS advanced.
    const gr = await prisma.mailAccount.findUniqueOrThrow({ where: { id: graph.accountId } });
    expect(gr.syncCursor).toBe("NEXT");
    expect(gr.lastSyncedAt).not.toBeNull();
  });

  it("swallows AuthError from syncDelta, leaves cursor untouched, and marks the account needs-reconnect", async () => {
    // Behaviour change (2026-05-20): the sync worker used to propagate
    // AuthError up to Inngest, which then retried the function on every
    // 1-minute cron tick — a permanently-revoked refresh token caused an
    // endless retry storm and log spam. The worker now catches the
    // non-transient AuthError, stamps `MailAccount.needsReconnectAt`, and
    // returns cleanly so the cron moves on. The UI surfaces the flag as
    // a "Reconnect" CTA in a later spec.
    const graph = await createAccount("graph", "STALE_DELTA_LINK");
    scopeListAccounts([
      { id: graph.accountId, syncCursor: "STALE_DELTA_LINK", userId: graph.userId },
    ]);

    vi.spyOn(GraphProvider.prototype, "syncDelta").mockRejectedValue(
      new AuthError("Sync delta expired — reconnect required: deltaToken not found"),
    );

    // No throw — the handler must resolve.
    await expect(invokeHandler()).resolves.toBeUndefined();

    const gr = await prisma.mailAccount.findUniqueOrThrow({ where: { id: graph.accountId } });
    // Cursor + lastSyncedAt MUST stay unchanged (no successful sync ran).
    expect(gr.syncCursor).toBe("STALE_DELTA_LINK");
    expect(gr.lastSyncedAt).toBeNull();
    // The reconnect flag IS stamped so the UI / next cron can react.
    expect(gr.needsReconnectAt).not.toBeNull();
  });

  it("does NOT mark needs-reconnect for a transient AuthError (e.g. token-refresh timeout)", async () => {
    // The `transient` flag on AuthError distinguishes "Google is being slow
    // today, try again next tick" from "user revoked us, nothing will fix
    // this without re-auth". Only the latter should stamp needsReconnectAt;
    // a transient hiccup must leave the row alone so the next cron tick
    // gets a fresh shot without surfacing a misleading reconnect CTA.
    const graph = await createAccount("graph", "GRAPH_CURSOR");
    scopeListAccounts([
      { id: graph.accountId, syncCursor: "GRAPH_CURSOR", userId: graph.userId },
    ]);

    vi.spyOn(GraphProvider.prototype, "syncDelta").mockRejectedValue(
      new AuthError("Microsoft token refresh timed out", { transient: true }),
    );

    await expect(invokeHandler()).resolves.toBeUndefined();

    const gr = await prisma.mailAccount.findUniqueOrThrow({ where: { id: graph.accountId } });
    expect(gr.syncCursor).toBe("GRAPH_CURSOR");
    expect(gr.lastSyncedAt).toBeNull();
    expect(gr.needsReconnectAt).toBeNull();
  });
});
