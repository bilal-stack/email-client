// @vitest-environment node
// `googleapis`'s gaxios HTTP client isn't reliably intercepted by MSW under
// the jsdom env. Node env keeps Node's native http/https stack in place so
// the msw/node interceptor patches work.
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
import { GmailProvider } from "./gmail";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

// Default to a JSON-shaped record so callers can hand it straight to
// `HttpResponse.json()` without an extra cast. Concrete fixtures can narrow with
// an explicit generic, e.g. `loadFixture<MyShape>(name)`.
async function loadFixture<T extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
): Promise<T> {
  return JSON.parse(
    await readFile(resolve(process.cwd(), "tests", "fixtures", "gmail", name), "utf8"),
  ) as T;
}

async function createAccount(): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `gmail-${randomUUID()}@example.com` },
  });
  const secret: MailboxSecret = {
    kind: "oauth",
    accessToken: "ya29.VALID",
    refreshToken: "1//RT",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: "https://www.googleapis.com/auth/gmail.modify",
  };
  const sealed = encrypt(JSON.stringify(secret));
  const row = await prisma.mailAccount.create({
    data: {
      userId: user.id,
      provider: "gmail",
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

const createdAccountIds: string[] = [];
const createdUserIds: string[] = [];

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

describe("GmailProvider.listThreads", () => {
  it("returns normalized threads and maps nextPageToken to nextCursor", async () => {
    const fx = await loadFixture("threads.list.basic.json");
    server.use(http.get(`${GMAIL}/threads`, () => HttpResponse.json(fx)));

    const provider = new GmailProvider(await createAccount());
    const result = await provider.listThreads({ limit: 50 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.id).toBe("t-aaa1");
    expect(result.nextCursor).toBe("PAGE2_TOKEN");
  });

  it("passes cursor through as pageToken on the outgoing call", async () => {
    let observedPageToken: string | null = null;
    server.use(
      http.get(`${GMAIL}/threads`, ({ request }) => {
        observedPageToken = new URL(request.url).searchParams.get("pageToken");
        return HttpResponse.json({ threads: [], resultSizeEstimate: 0 });
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.listThreads({ cursor: "PAGE2_TOKEN" });
    expect(observedPageToken).toBe("PAGE2_TOKEN");
  });

  it("passes label through as labelIds on the outgoing call", async () => {
    let observedLabels: string[] = [];
    server.use(
      http.get(`${GMAIL}/threads`, ({ request }) => {
        observedLabels = new URL(request.url).searchParams.getAll("labelIds");
        return HttpResponse.json({ threads: [], resultSizeEstimate: 0 });
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.listThreads({ label: "INBOX" });
    expect(observedLabels).toEqual(["INBOX"]);
  });

  it("forces AuthError when the API replies 401 (spot-checks the error-mapping wiring)", async () => {
    const err = await loadFixture("errors.401.json");
    server.use(http.get(`${GMAIL}/threads`, () => HttpResponse.json(err, { status: 401 })));

    const provider = new GmailProvider(await createAccount());
    await expect(provider.listThreads({})).rejects.toBeInstanceOf(AuthError);
  });
});

describe("GmailProvider.getThread", () => {
  it("normalizes a three-message thread with bodies, headers, and attachments", async () => {
    const fx = await loadFixture("threads.get.full.json");
    server.use(http.get(`${GMAIL}/threads/t-aaa1`, () => HttpResponse.json(fx)));

    const provider = new GmailProvider(await createAccount());
    const thread = await provider.getThread("t-aaa1");

    expect(thread.id).toBe("t-aaa1");
    expect(thread.subject).toBe("Welcome to the project");
    expect(thread.messageIds).toEqual(["m-001", "m-002", "m-003"]);
    expect(thread.unreadCount).toBe(1);
    expect(thread.participants.map((p) => p.email)).toEqual(
      expect.arrayContaining([
        "alice@example.com",
        "bob@example.com",
        "carol@example.com",
        "dan@example.com",
      ]),
    );
  });

  it("collects labels from all messages and computes unread/labels at thread level", async () => {
    const fx = await loadFixture("threads.get.full.json");
    server.use(http.get(`${GMAIL}/threads/t-aaa1`, () => HttpResponse.json(fx)));

    const provider = new GmailProvider(await createAccount());
    const thread = await provider.getThread("t-aaa1");

    expect(thread.labels).toEqual(expect.arrayContaining(["INBOX", "UNREAD"]));
    expect(thread.unreadCount).toBe(1);
  });
});

describe("GmailProvider.sendMessage", () => {
  it("builds RFC 2822 raw, base64url-encoded, and returns id/threadId from the API", async () => {
    let observedRaw: string | undefined;
    const sendResp = await loadFixture("messages.send.ok.json");
    server.use(
      http.post(`${GMAIL}/messages/send`, async ({ request }) => {
        const body = (await request.json()) as { raw: string; threadId?: string };
        observedRaw = Buffer.from(body.raw, "base64url").toString("utf8");
        return HttpResponse.json(sendResp);
      }),
    );

    const provider = new GmailProvider(await createAccount());
    const result = await provider.sendMessage({
      to: [{ name: "Recipient", email: "rcpt@example.com" }],
      subject: "Hi there",
      bodyHtml: "<p>Body</p>",
    });

    expect(result).toEqual({ id: "m-sent-1", threadId: "t-sent-thread" });
    expect(observedRaw).toContain('To: "Recipient" <rcpt@example.com>');
    expect(observedRaw).toContain("Subject: Hi there");
    expect(observedRaw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(observedRaw).toContain("<p>Body</p>");
  });
});

describe("GmailProvider.reply", () => {
  it("sets threadId on the call and emits In-Reply-To + References headers", async () => {
    let observedRaw: string | undefined;
    let observedThreadId: string | undefined;
    server.use(
      http.post(`${GMAIL}/messages/send`, async ({ request }) => {
        const body = (await request.json()) as { raw: string; threadId?: string };
        observedRaw = Buffer.from(body.raw, "base64url").toString("utf8");
        observedThreadId = body.threadId;
        return HttpResponse.json({ id: "m-reply", threadId: "t-x" });
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.reply("t-x", {
      to: [{ email: "rcpt@example.com" }],
      subject: "Re: Hi",
      bodyHtml: "<p>r</p>",
      inReplyTo: "parent@example.com",
      references: ["root@example.com", "parent@example.com"],
    });

    expect(observedThreadId).toBe("t-x");
    expect(observedRaw).toContain("In-Reply-To: <parent@example.com>");
    expect(observedRaw).toContain("References: <root@example.com> <parent@example.com>");
  });
});

describe("GmailProvider.archive", () => {
  it("calls batchModify once with removeLabelIds: [INBOX] and the given ids", async () => {
    let observedBody: { ids?: string[]; removeLabelIds?: string[] } | undefined;
    let callCount = 0;
    server.use(
      http.post(`${GMAIL}/messages/batchModify`, async ({ request }) => {
        callCount++;
        observedBody = (await request.json()) as { ids?: string[]; removeLabelIds?: string[] };
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.archive(["m-1", "m-2"]);

    expect(callCount).toBe(1);
    expect(observedBody?.ids).toEqual(["m-1", "m-2"]);
    expect(observedBody?.removeLabelIds).toEqual(["INBOX"]);
  });
});

describe("GmailProvider.trash", () => {
  it("issues one trash call per id (bounded concurrency)", async () => {
    const trashed: string[] = [];
    server.use(
      http.post(`${GMAIL}/messages/:id/trash`, ({ params }) => {
        trashed.push(params.id as string);
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.trash(["m-1", "m-2"]);

    expect(trashed.sort()).toEqual(["m-1", "m-2"]);
  });
});

describe("GmailProvider.markRead", () => {
  it("when read=true, removes UNREAD via batchModify", async () => {
    let observed: { ids?: string[]; removeLabelIds?: string[]; addLabelIds?: string[] } | undefined;
    server.use(
      http.post(`${GMAIL}/messages/batchModify`, async ({ request }) => {
        observed = (await request.json()) as typeof observed;
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.markRead(["m-1"], true);
    expect(observed?.removeLabelIds).toEqual(["UNREAD"]);
    expect(observed?.addLabelIds).toBeUndefined();
  });

  it("when read=false, adds UNREAD via batchModify", async () => {
    let observed: { ids?: string[]; removeLabelIds?: string[]; addLabelIds?: string[] } | undefined;
    server.use(
      http.post(`${GMAIL}/messages/batchModify`, async ({ request }) => {
        observed = (await request.json()) as typeof observed;
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.markRead(["m-1"], false);
    expect(observed?.addLabelIds).toEqual(["UNREAD"]);
    expect(observed?.removeLabelIds).toBeUndefined();
  });
});

describe("GmailProvider.setLabels", () => {
  it("mirrors add / remove arrays onto the outgoing payload", async () => {
    let observed: { addLabelIds?: string[]; removeLabelIds?: string[] } | undefined;
    server.use(
      http.post(`${GMAIL}/messages/batchModify`, async ({ request }) => {
        observed = (await request.json()) as typeof observed;
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.setLabels(["m-1"], ["LBL_A"], ["LBL_B"]);
    expect(observed?.addLabelIds).toEqual(["LBL_A"]);
    expect(observed?.removeLabelIds).toEqual(["LBL_B"]);
  });
});

describe("GmailProvider.search", () => {
  it("passes the query string verbatim to the q parameter", async () => {
    let observedQ: string | null = null;
    server.use(
      http.get(`${GMAIL}/threads`, ({ request }) => {
        observedQ = new URL(request.url).searchParams.get("q");
        return HttpResponse.json({ threads: [], resultSizeEstimate: 0 });
      }),
    );

    const provider = new GmailProvider(await createAccount());
    await provider.search("from:foo has:attachment");
    expect(observedQ).toBe("from:foo has:attachment");
  });
});

describe("GmailProvider.syncDelta", () => {
  it("cold start: null cursor → getProfile().historyId becomes nextCursor", async () => {
    const profile = await loadFixture<{ historyId: string }>("getProfile.json");
    server.use(http.get(`${GMAIL}/profile`, () => HttpResponse.json(profile)));

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta(null);

    expect(delta.nextCursor).toBe(profile.historyId);
    expect(delta.newMessages).toEqual([]);
    expect(delta.changedMessages).toEqual([]);
    expect(delta.deletedIds).toEqual([]);
  });

  it("added events: fetches messages.get for each id, returns normalized newMessages", async () => {
    const history = await loadFixture("history.list.added.json");
    const msg = await loadFixture("messages.get.full.json");
    server.use(
      http.get(`${GMAIL}/history`, () => HttpResponse.json(history)),
      http.get(`${GMAIL}/messages/:id`, () => HttpResponse.json(msg)),
    );

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("12340");

    expect(delta.newMessages).toHaveLength(1);
    expect(delta.newMessages[0]?.id).toBe("m-new-1");
    expect(delta.nextCursor).toBe("12350");
  });

  it("deleted events: populates deletedIds, never fetches messages.get for those ids", async () => {
    const history = await loadFixture("history.list.deleted.json");
    let messageGetCalls = 0;
    server.use(
      http.get(`${GMAIL}/history`, () => HttpResponse.json(history)),
      http.get(`${GMAIL}/messages/:id`, () => {
        messageGetCalls++;
        return HttpResponse.json({});
      }),
    );

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("12340");
    expect(delta.deletedIds).toEqual(["m-deleted-1"]);
    expect(delta.newMessages).toEqual([]);
    expect(messageGetCalls).toBe(0);
  });

  it("added then deleted in the same window: id ends up only in deletedIds", async () => {
    const history = {
      history: [
        {
          id: "12345",
          messagesAdded: [{ message: { id: "m-both", threadId: "t-both", labelIds: ["INBOX"] } }],
        },
        {
          id: "12346",
          messagesDeleted: [{ message: { id: "m-both", threadId: "t-both" } }],
        },
      ],
      historyId: "12346",
    };
    server.use(http.get(`${GMAIL}/history`, () => HttpResponse.json(history)));

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("12340");
    expect(delta.deletedIds).toEqual(["m-both"]);
    expect(delta.newMessages).toEqual([]);
  });

  it("label add/remove events: changedMessages reflects toggled isUnread", async () => {
    const history = await loadFixture("history.list.labels.json");
    server.use(http.get(`${GMAIL}/history`, () => HttpResponse.json(history)));

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("12340");

    const byId = new Map(delta.changedMessages.map((c) => [c.id, c]));
    expect(byId.get("m-label-1")?.isUnread).toBe(true);
    expect(byId.get("m-label-2")?.isUnread).toBe(false);
  });

  it("paginated history: walks nextPageToken, final nextCursor is the max across pages", async () => {
    const page1 = await loadFixture("history.list.paginated.page1.json");
    const page2 = await loadFixture("history.list.paginated.page2.json");
    const msg = await loadFixture("messages.get.full.json");

    let historyCalls = 0;
    server.use(
      http.get(`${GMAIL}/history`, ({ request }) => {
        historyCalls++;
        const url = new URL(request.url);
        const pageToken = url.searchParams.get("pageToken");
        return HttpResponse.json(pageToken ? page2 : page1);
      }),
      http.get(`${GMAIL}/messages/:id`, () => HttpResponse.json(msg)),
    );

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("10000");

    expect(historyCalls).toBe(2);
    expect(delta.nextCursor).toBe("20050");
  });

  it("expired history: 404 with historyId not found → AuthError with reconnect message", async () => {
    const err = await loadFixture("history.list.expired.json");
    server.use(http.get(`${GMAIL}/history`, () => HttpResponse.json(err, { status: 404 })));

    const provider = new GmailProvider(await createAccount());
    await expect(provider.syncDelta("12340")).rejects.toMatchObject({
      name: "AuthError",
      message: expect.stringContaining("Sync history expired — reconnect required"),
    });
  });

  it("concurrency cap: with 25 added ids, observes at most 10 in-flight messages.get", async () => {
    const ids = Array.from({ length: 25 }, (_, i) => `m-concur-${i}`);
    const history = {
      history: ids.map((id, i) => ({
        id: String(30000 + i),
        messagesAdded: [{ message: { id, threadId: `t-${id}`, labelIds: ["INBOX"] } }],
      })),
      historyId: String(30000 + ids.length - 1),
    };
    const msgTemplate = await loadFixture<Record<string, unknown>>("messages.get.full.json");

    let inFlight = 0;
    let peak = 0;
    server.use(
      http.get(`${GMAIL}/history`, () => HttpResponse.json(history)),
      http.get(`${GMAIL}/messages/:id`, async ({ params }) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        // Yield to the event loop so concurrent workers actually overlap.
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return HttpResponse.json({ ...msgTemplate, id: params.id, threadId: `t-${params.id}` });
      }),
    );

    const provider = new GmailProvider(await createAccount());
    const delta = await provider.syncDelta("29999");

    expect(delta.newMessages).toHaveLength(25);
    expect(peak).toBeLessThanOrEqual(10);
  });
});
