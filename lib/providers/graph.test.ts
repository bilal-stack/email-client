// @vitest-environment node
// @microsoft/microsoft-graph-client uses fetch under the hood; the Node env
// keeps Node's native fetch in place so msw/node interception works cleanly.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { server } from "../../tests/setup/msw";
import type { MailboxSecret } from "./auth";
import { AuthError, TransientError } from "./errors";
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
    data: { email: `graph-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    accessToken: "EwA-TEST",
    refreshToken: "MCRT-TEST",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "https://graph.microsoft.com/.default",
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

// Standard set of well-known folder handlers used by every test (loadFolderIds
// fires on most adapter entry points). Returns minimal { id } envelopes.
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

describe("GraphProvider.listThreads", () => {
  it("returns normalized threads grouped by conversationId and extracts $skiptoken from @odata.nextLink", async () => {
    const fx = await loadFixture("messages.list.basic.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/mailFolders/inbox/messages`, () => HttpResponse.json(fx)),
    );

    const provider = new GraphProvider(await createAccount());
    const result = await provider.listThreads({ limit: 50 });

    // Two conversations: conv-A (single) and conv-B (three messages).
    expect(result.items).toHaveLength(2);
    const byId = new Map(result.items.map((t) => [t.id, t]));
    expect(byId.get("conv-B")?.messageIds).toEqual(["m-conv-b-1", "m-conv-b-2", "m-conv-b-3"]);
    // $skiptoken extracted from @odata.nextLink URL parse — guards the URL helper.
    expect(result.nextCursor).toBe("NEXT_SKIP_TOKEN");
  });
});

describe("GraphProvider.getThread", () => {
  it("synthesizes INBOX + UNREAD labels for an unread inbox message, merges user categories, dedupes", async () => {
    // First message: unread + inbox → expect INBOX, UNREAD synthetic labels.
    // Second message: read + inbox + category "Work" → expect INBOX + "Work".
    const fx = await loadFixture("messages.thread.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/messages`, () => HttpResponse.json(fx)),
    );

    const provider = new GraphProvider(await createAccount());
    const thread = await provider.getThread("conv-T");

    expect(thread.id).toBe("conv-T");
    // Union of per-message labels, deduped, includes the synthetic + user labels.
    expect(thread.labels).toEqual(expect.arrayContaining(["INBOX", "UNREAD", "Work"]));
    // No duplicates on the thread (Set semantics in `buildThread`).
    expect(new Set(thread.labels).size).toBe(thread.labels.length);
    expect(thread.unreadCount).toBe(1);
    expect(thread.messageIds).toEqual(["m-thread-1", "m-thread-2"]);
  });
});

describe("GraphProvider.setLabels", () => {
  it("adding a user label patches categories with the merged list", async () => {
    let observedPatch: { categories?: string[]; isRead?: boolean } | undefined;
    const current = await loadFixture("messages.byMessageId.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/messages/m-setlabels-1`, () => HttpResponse.json(current)),
      http.patch(`${GRAPH}/me/messages/m-setlabels-1`, async ({ request }) => {
        observedPatch = (await request.json()) as typeof observedPatch;
        return HttpResponse.json({});
      }),
    );

    const provider = new GraphProvider(await createAccount());
    await provider.setLabels(["m-setlabels-1"], ["Work"], []);

    expect(observedPatch?.categories).toEqual(expect.arrayContaining(["Existing", "Work"]));
    expect(observedPatch?.isRead).toBeUndefined();
  });

  it("removing INBOX triggers a move to archive AND no isRead PATCH", async () => {
    let movedTo: string | undefined;
    let patchHits = 0;
    const current = await loadFixture("messages.byMessageId.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/messages/m-setlabels-1`, () => HttpResponse.json(current)),
      http.patch(`${GRAPH}/me/messages/m-setlabels-1`, () => {
        patchHits++;
        return HttpResponse.json({});
      }),
      http.post(`${GRAPH}/me/messages/m-setlabels-1/move`, async ({ request }) => {
        movedTo = ((await request.json()) as { destinationId?: string }).destinationId;
        return HttpResponse.json({ id: "m-setlabels-1" });
      }),
    );

    const provider = new GraphProvider(await createAccount());
    await provider.setLabels(["m-setlabels-1"], [], ["INBOX"]);

    // Graph accepts well-known folder names directly as `destinationId`;
    // we pass `"archive"` verbatim rather than the resolved folder id.
    expect(movedTo).toBe("archive");
    // No category diff → no PATCH should be issued.
    expect(patchHits).toBe(0);
  });

  it("toggling UNREAD patches isRead and skips folder move", async () => {
    let observedPatch: { categories?: string[]; isRead?: boolean } | undefined;
    let moveHits = 0;
    const current = await loadFixture("messages.byMessageId.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/messages/m-setlabels-1`, () => HttpResponse.json(current)),
      http.patch(`${GRAPH}/me/messages/m-setlabels-1`, async ({ request }) => {
        observedPatch = (await request.json()) as typeof observedPatch;
        return HttpResponse.json({});
      }),
      http.post(`${GRAPH}/me/messages/m-setlabels-1/move`, () => {
        moveHits++;
        return HttpResponse.json({});
      }),
    );

    const provider = new GraphProvider(await createAccount());
    await provider.setLabels(["m-setlabels-1"], ["UNREAD"], []);

    expect(observedPatch?.isRead).toBe(false);
    expect(observedPatch?.categories).toBeUndefined();
    expect(moveHits).toBe(0);
  });
});

describe("GraphProvider.reply", () => {
  it("issues createReply → PATCH → send in order on the happy path", async () => {
    const calls: string[] = [];
    const createReply = await loadFixture("createReply.json");
    server.use(
      ...folderHandlers(),
      http.post(`${GRAPH}/me/messages/m-parent/createReply`, () => {
        calls.push("createReply");
        return HttpResponse.json(createReply);
      }),
      http.patch(`${GRAPH}/me/messages/draft-reply-1`, () => {
        calls.push("patch");
        return HttpResponse.json({});
      }),
      http.post(`${GRAPH}/me/messages/draft-reply-1/send`, () => {
        calls.push("send");
        return HttpResponse.json({});
      }),
    );

    const provider = new GraphProvider(await createAccount());
    const result = await provider.reply("conv-original", {
      to: [{ email: "alice@example.com" }],
      subject: "Re: Hi",
      bodyHtml: "<p>reply</p>",
      inReplyTo: "m-parent",
    });

    expect(calls).toEqual(["createReply", "patch", "send"]);
    expect(result.id).toBe("draft-reply-1");
  });

  it("on PATCH failure, observes a best-effort DELETE of the draft AND throws TransientError", async () => {
    let deleteHit = false;
    const createReply = await loadFixture("createReply.json");
    server.use(
      ...folderHandlers(),
      http.post(`${GRAPH}/me/messages/m-parent/createReply`, () =>
        HttpResponse.json(createReply),
      ),
      // PATCH fails with 500 → triggers rollback path.
      http.patch(`${GRAPH}/me/messages/draft-reply-1`, () =>
        HttpResponse.json({ error: { message: "boom" } }, { status: 500 }),
      ),
      http.delete(`${GRAPH}/me/messages/draft-reply-1`, () => {
        deleteHit = true;
        return HttpResponse.json({});
      }),
      // /send must not be called when PATCH fails — but register a handler so
      // an unintended call surfaces as a clear MSW assertion rather than a
      // confusing "unhandled request" error.
      http.post(`${GRAPH}/me/messages/draft-reply-1/send`, () => {
        throw new Error("/send should not be called when PATCH fails");
      }),
    );

    const provider = new GraphProvider(await createAccount());
    await expect(
      provider.reply("conv-original", {
        to: [{ email: "alice@example.com" }],
        subject: "Re: Hi",
        bodyHtml: "<p>x</p>",
        inReplyTo: "m-parent",
      }),
    ).rejects.toBeInstanceOf(TransientError);
    expect(deleteHit).toBe(true);
  });
});

describe("GraphProvider.sendMessage", () => {
  it("returns { id, threadId } from the follow-up sentitems read on the happy path", async () => {
    let sendMailCalled = false;
    server.use(
      ...folderHandlers(),
      http.post(`${GRAPH}/me/sendMail`, () => {
        sendMailCalled = true;
        return new HttpResponse(null, { status: 202 });
      }),
      http.get(`${GRAPH}/me/mailFolders/sentitems/messages`, () =>
        HttpResponse.json({
          value: [{ id: "m-sent-x", conversationId: "conv-sent-x" }],
        }),
      ),
    );

    const provider = new GraphProvider(await createAccount());
    const result = await provider.sendMessage({
      to: [{ email: "rcpt@example.com" }],
      subject: "Hi",
      bodyHtml: "<p>Body</p>",
    });

    expect(sendMailCalled).toBe(true);
    expect(result).toEqual({ id: "m-sent-x", threadId: "conv-sent-x" });
  });
});

describe("GraphProvider.search", () => {
  it("sends ConsistencyLevel: eventual and escapes embedded quotes in the query", async () => {
    let observedConsistency: string | null = null;
    let observedSearch: string | null = null;
    const fx = await loadFixture("search.results.json");
    server.use(
      ...folderHandlers(),
      http.get(`${GRAPH}/me/messages`, ({ request }) => {
        observedConsistency = request.headers.get("ConsistencyLevel");
        observedSearch = new URL(request.url).searchParams.get("$search");
        return HttpResponse.json(fx);
      }),
    );

    const provider = new GraphProvider(await createAccount());
    // The user supplied a quote — must come out escaped (\") in the
    // outgoing `$search` value, otherwise Graph rejects the query.
    await provider.search('say "hi"');

    expect(observedConsistency).toBe("eventual");
    expect(observedSearch).toBe('"say \\"hi\\""');
  });
});
