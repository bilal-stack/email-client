// @vitest-environment node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../tests/setup/msw";
import type { MailboxSecret } from "./auth";
import { AuthError } from "./errors";
import { GraphProvider } from "./graph";

const GRAPH = "https://graph.microsoft.com/v1.0";

async function loadFixture<T = Record<string, unknown>>(name: string): Promise<T> {
  return JSON.parse(
    await readFile(resolve(process.cwd(), "tests", "fixtures", "graph", name), "utf8"),
  ) as T;
}

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

async function createAccount(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `graph-sd-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    accessToken: "EwA-TEST",
    refreshToken: "MCRT-TEST",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "scope",
  };
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "graph",
      emailAddress: `mb-${randomUUID()}@example.com`,
      encryptedSecret: sealed.ciphertext,
      secretIv: sealed.iv,
      secretTag: sealed.tag,
    },
  });
  createdAccountIds.push(row.id);
  createdUserIds.push(user.id);
  return row.id;
}

function folderHandlers() {
  const ids: Record<string, string> = {
    inbox: "FOLDER_INBOX",
    sentitems: "FOLDER_SENT",
    drafts: "FOLDER_DRAFTS",
    deleteditems: "FOLDER_TRASH",
    archive: "FOLDER_ARCHIVE",
  };
  return Object.entries(ids).map(([name, id]) =>
    http.get(`${GRAPH}/me/mailFolders/${name}`, () =>
      HttpResponse.json({ id, displayName: name }),
    ),
  );
}

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

describe("GraphProvider.syncDelta", () => {
  it("cold start (null cursor) drains pages and returns empty messages + deltaLink as nextCursor", async () => {
    const page1 = await loadFixture<{ "@odata.nextLink": string }>(
      "messages.delta.coldStart.page1.json",
    );
    const page2 = await loadFixture<{ "@odata.deltaLink": string }>(
      "messages.delta.coldStart.page2.json",
    );
    let calls = 0;
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, ({ request }) => {
        calls++;
        const url = new URL(request.url);
        const tok = url.searchParams.get("$skiptoken");
        return HttpResponse.json(tok === "COLD_PAGE_2" ? page2 : page1);
      }),
    );

    const provider = new GraphProvider(await createAccount());
    const delta = await provider.syncDelta(null);

    expect(calls).toBe(2);
    expect(delta.newMessages).toEqual([]);
    expect(delta.changedMessages).toEqual([]);
    expect(delta.deletedIds).toEqual([]);
    expect(delta.nextCursor).toBe(page2["@odata.deltaLink"]);
  });

  it("incremental delta: non-removed entries become newMessages, @removed entries become deletedIds", async () => {
    const fx = await loadFixture("messages.delta.incremental.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, () => HttpResponse.json(fx)),
      // Attachment fanout (one of the two messages has hasAttachments: true).
      http.get(`${GRAPH}/me/messages/m-delta-new-1/attachments`, () =>
        HttpResponse.json({ value: [] }),
      ),
    );

    const provider = new GraphProvider(await createAccount());
    const delta = await provider.syncDelta(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=START",
    );

    expect(delta.newMessages.map((m) => m.id).sort()).toEqual([
      "m-delta-new-1",
      "m-delta-new-2",
    ]);
    expect(delta.deletedIds).toEqual(["m-delta-removed-1"]);
    expect(delta.changedMessages).toEqual([]);
    expect(delta.nextCursor).toContain("$deltatoken=NEXT_DELTA");
  });

  it("attachment fanout: messages with hasAttachments: true get /attachments fetched; others do NOT", async () => {
    const fx = await loadFixture("messages.delta.incremental.json");
    const attachments = await loadFixture("attachments.list.json");
    const fetchedFor: string[] = [];
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, () => HttpResponse.json(fx)),
      http.get(`${GRAPH}/me/messages/:id/attachments`, ({ params }) => {
        fetchedFor.push(params.id as string);
        return HttpResponse.json(attachments);
      }),
    );

    const provider = new GraphProvider(await createAccount());
    const delta = await provider.syncDelta(
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=X",
    );

    // Only the message with hasAttachments=true should have triggered a fetch.
    expect(fetchedFor).toEqual(["m-delta-new-1"]);
    const m1 = delta.newMessages.find((m) => m.id === "m-delta-new-1");
    const m2 = delta.newMessages.find((m) => m.id === "m-delta-new-2");
    expect(m1?.attachments).toHaveLength(2);
    expect(m2?.attachments).toEqual([]);
  });

  it("expired deltaLink: 410 with deltaToken-related message throws AuthError", async () => {
    const errBody = await loadFixture("errors.410.deltaLink.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages/delta`, () =>
        HttpResponse.json(errBody, { status: 410 }),
      ),
    );

    const provider = new GraphProvider(await createAccount());
    await expect(
      provider.syncDelta(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=STALE",
      ),
    ).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("Sync delta expired — reconnect required"),
    });
  });
});
