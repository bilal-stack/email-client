// Microsoft Graph provider adapter. Implements `IEmailProvider` against the
// official `@microsoft/microsoft-graph-client` SDK. Every method funnels its
// work through `getMailboxSecret` (centralized token refresh) and `mapError`
// (canonical error taxonomy).
//
// Conventions enforced here:
//   - Adapters NEVER refresh tokens inline (architectural rule #7). The
//     Graph SDK *can* refresh on its own; we deliberately wire it with a
//     static-token shim so refresh stays in `lib/providers/auth.ts`.
//   - Adapters NEVER throw provider-specific errors — every catch maps via
//     `mapError(e)` from `./error-mapping`.
//   - Thread id = Graph `conversationId` verbatim. Message id = Graph API
//     id verbatim.
//   - Synthetic labels (`INBOX`/`SENT`/`DRAFT`/`TRASH`/`UNREAD`) are
//     synthesized from `parentFolderId` + `isRead` on read; on write,
//     mutations on those tokens become folder-moves or `isRead` PATCH.
//     User labels round-trip through Graph **categories**.

import { Client } from "@microsoft/microsoft-graph-client";
import { type OAuthMailboxSecret, getMailboxSecret } from "@/lib/providers/auth";
import { mapError } from "@/lib/providers/error-mapping";
import type {
  CanonicalAddress,
  CanonicalAttachmentMeta,
  CanonicalMessage,
  CanonicalThread,
  DeltaResult,
  IEmailProvider,
  ListResult,
  ListThreadsOptions,
  MessageId,
  SendDraft,
  ThreadId,
} from "./types";

// ─── Constants ────────────────────────────────────────────────────────────

const LIST_FIELDS =
  "id,conversationId,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,categories,parentFolderId,hasAttachments,bodyPreview";

const THREAD_FIELDS = `${LIST_FIELDS},body,internetMessageHeaders`;

// Well-known Graph mail folder names (case-sensitive in the URL path).
const WELL_KNOWN_FOLDERS = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "archive",
] as const;
type WellKnownFolder = (typeof WELL_KNOWN_FOLDERS)[number];

// Folder → synthetic label. Folders not in this map produce NO synthetic label
// (they are custom user folders; the user's category list still flows through).
const FOLDER_TO_SYNTHETIC: Record<WellKnownFolder, string | null> = {
  inbox: "INBOX",
  sentitems: "SENT",
  drafts: "DRAFT",
  deleteditems: "TRASH",
  archive: null, // absence of "INBOX" is the archive signal
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function graphClient(secret: OAuthMailboxSecret): Client {
  // The auth provider here is a static-token shim — we already refreshed via
  // getMailboxSecret. The MS SDK won't refresh on its own with this shape.
  return Client.init({
    authProvider: (done) => done(null, secret.accessToken),
  });
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      // biome-ignore lint/style/noNonNullAssertion: bounded by cursor
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── Address / header parsing ─────────────────────────────────────────────

interface GraphEmailAddress {
  name?: string;
  address?: string;
}
interface GraphRecipient {
  emailAddress?: GraphEmailAddress;
}

function parseRecipient(r: GraphRecipient | undefined): CanonicalAddress | null {
  const ea = r?.emailAddress;
  if (!ea?.address) return null;
  if (ea.name) return { name: ea.name, email: ea.address };
  return { email: ea.address };
}

function parseRecipients(list: GraphRecipient[] | undefined): CanonicalAddress[] {
  if (!list) return [];
  const out: CanonicalAddress[] = [];
  for (const r of list) {
    const parsed = parseRecipient(r);
    if (parsed) out.push(parsed);
  }
  return out;
}

interface GraphInternetHeader {
  name?: string;
  value?: string;
}

function extractInternetHeader(
  headers: GraphInternetHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

function parseMessageIdList(header: string): string[] {
  if (!header) return [];
  return header
    .split(/\s+/)
    .map((s) => s.trim().replace(/^<(.*)>$/, "$1"))
    .filter(Boolean);
}

function escapeSearchTerm(query: string): string {
  // Escape backslashes first, then double-quotes — the SDK wraps the value
  // in double-quotes for $search.
  return query.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ─── Outgoing message body ────────────────────────────────────────────────

function toRecipient(addr: CanonicalAddress): { emailAddress: { name?: string; address: string } } {
  return { emailAddress: { name: addr.name, address: addr.email } };
}

function buildGraphMessage(draft: SendDraft) {
  return {
    subject: draft.subject,
    body: { contentType: "HTML", content: draft.bodyHtml },
    toRecipients: draft.to.map(toRecipient),
    ccRecipients: (draft.cc ?? []).map(toRecipient),
    bccRecipients: (draft.bcc ?? []).map(toRecipient),
    attachments: (draft.attachments ?? []).map((a) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.mimeType,
      contentBytes: a.content.toString("base64"),
    })),
  };
}

// ─── Skiptoken extraction ─────────────────────────────────────────────────

function extractSkipToken(nextLink: string | undefined): string | null {
  if (!nextLink) return null;
  try {
    const url = new URL(nextLink);
    return url.searchParams.get("$skiptoken");
  } catch {
    return null;
  }
}

// ─── Graph message shape ──────────────────────────────────────────────────

interface GraphMessage {
  id?: string;
  conversationId?: string;
  subject?: string;
  bodyPreview?: string;
  from?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  isRead?: boolean;
  categories?: string[];
  parentFolderId?: string;
  hasAttachments?: boolean;
  body?: { contentType?: string; content?: string };
  internetMessageHeaders?: GraphInternetHeader[];
}

interface GraphDeltaEntry extends GraphMessage {
  "@removed"?: { reason?: string };
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export class GraphProvider implements IEmailProvider {
  /**
   * Lazy cache of well-known-folder-name → folder id. Populated on first use
   * per method call site that needs it. Lives on the instance (instance is
   * short-lived per request, so the cache is effectively per-call).
   */
  private folderIdCache: Map<WellKnownFolder, string> = new Map();

  constructor(private readonly accountId: string) {}

  // ─── Normalization ──────────────────────────────────────────────────────

  /**
   * Translate a Graph `parentFolderId` (opaque id) into the matching synthetic
   * label, or `null` if the folder is not one of the well-known ones we map.
   * Uses the folderIdCache populated by `loadFolderIds`.
   */
  private folderIdToSynthetic(parentFolderId: string | undefined): string | null {
    if (!parentFolderId) return null;
    for (const [name, id] of this.folderIdCache.entries()) {
      if (id === parentFolderId) return FOLDER_TO_SYNTHETIC[name];
    }
    return null;
  }

  /**
   * Populate `folderIdCache` for all well-known folders we care about, if
   * not already loaded. One `GET /me/mailFolders/{name}` per missing entry.
   */
  private async loadFolderIds(client: Client): Promise<void> {
    for (const name of WELL_KNOWN_FOLDERS) {
      if (this.folderIdCache.has(name)) continue;
      try {
        const folder = await client.api(`/me/mailFolders/${name}`).select("id").get();
        if (folder?.id) this.folderIdCache.set(name, folder.id as string);
      } catch {
        // A missing well-known folder (e.g. some tenants disable archive) is
        // not fatal — the synthetic-label mapping for it just stays absent.
      }
    }
  }

  private normalizeMessage(msg: GraphMessage): CanonicalMessage {
    const labelSet = new Set<string>();
    // Synthetic-folder label
    const synthetic = this.folderIdToSynthetic(msg.parentFolderId);
    if (synthetic) labelSet.add(synthetic);
    // UNREAD synthetic
    if (msg.isRead === false) labelSet.add("UNREAD");
    // Categories (user labels)
    for (const c of msg.categories ?? []) labelSet.add(c);

    const inReplyToHeader = extractInternetHeader(msg.internetMessageHeaders, "In-Reply-To");
    const referencesHeader = extractInternetHeader(msg.internetMessageHeaders, "References");

    const bodyContentType = msg.body?.contentType?.toLowerCase();
    const bodyContent = msg.body?.content ?? null;
    let bodyHtml: string | null = null;
    let bodyText: string | null = null;
    if (bodyContent !== null) {
      if (bodyContentType === "html") bodyHtml = bodyContent;
      else if (bodyContentType === "text") bodyText = bodyContent;
    }

    const fromAddr = parseRecipient(msg.from) ?? { email: "" };

    return {
      id: msg.id ?? "",
      threadId: msg.conversationId ?? "",
      accountId: this.accountId,
      from: fromAddr,
      to: parseRecipients(msg.toRecipients),
      cc: parseRecipients(msg.ccRecipients),
      bcc: parseRecipients(msg.bccRecipients),
      subject: msg.subject ?? "",
      snippet: msg.bodyPreview ?? "",
      bodyHtml,
      bodyText,
      receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(0),
      isUnread: msg.isRead === false,
      labels: [...labelSet],
      inReplyTo: parseMessageIdList(inReplyToHeader)[0] ?? null,
      references: parseMessageIdList(referencesHeader),
      attachments: [],
    };
  }

  private groupByConversation(messages: GraphMessage[]): CanonicalThread[] {
    const byConvo = new Map<string, CanonicalMessage[]>();
    for (const m of messages) {
      const canonical = this.normalizeMessage(m);
      if (!canonical.threadId) continue;
      const list = byConvo.get(canonical.threadId);
      if (list) list.push(canonical);
      else byConvo.set(canonical.threadId, [canonical]);
    }
    const threads: CanonicalThread[] = [];
    for (const [convId, msgs] of byConvo.entries()) {
      msgs.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
      threads.push(this.buildThread(convId, msgs));
    }
    return threads;
  }

  private buildThread(conversationId: string, messages: CanonicalMessage[]): CanonicalThread {
    const last = messages[messages.length - 1];
    const participantsMap = new Map<string, CanonicalAddress>();
    const labelsSet = new Set<string>();
    let unreadCount = 0;
    for (const m of messages) {
      for (const a of [m.from, ...m.to, ...m.cc, ...m.bcc]) {
        if (a.email && !participantsMap.has(a.email)) participantsMap.set(a.email, a);
      }
      for (const l of m.labels) labelsSet.add(l);
      if (m.isUnread) unreadCount++;
    }
    return {
      id: conversationId,
      accountId: this.accountId,
      subject: messages[0]?.subject ?? "",
      snippet: last?.snippet ?? messages[0]?.snippet ?? "",
      participants: [...participantsMap.values()],
      lastMessageAt: last?.receivedAt ?? new Date(0),
      unreadCount,
      labels: [...labelsSet],
      messageIds: messages.map((m) => m.id),
    };
  }

  private async fetchAttachmentMeta(
    client: Client,
    messageId: string,
  ): Promise<CanonicalAttachmentMeta[]> {
    const res = await client
      .api(`/me/messages/${messageId}/attachments`)
      .select("id,name,contentType,size")
      .get();
    const items = (res?.value ?? []) as Array<{
      id?: string;
      name?: string;
      contentType?: string;
      size?: number;
    }>;
    return items
      .filter((a) => a.id && a.name)
      .map((a) => ({
        id: a.id as string,
        filename: a.name as string,
        mimeType: a.contentType ?? "application/octet-stream",
        size: a.size ?? 0,
      }));
  }

  // ─── IEmailProvider methods ─────────────────────────────────────────────

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await this.loadFolderIds(client);

      let req = client
        .api("/me/mailFolders/inbox/messages")
        .top(opts.limit ?? 50)
        .orderby("receivedDateTime desc")
        .select(LIST_FIELDS);
      if (opts.cursor) req = req.skipToken(opts.cursor);

      const res = await req.get();
      const messages = (res?.value ?? []) as GraphMessage[];
      const threads = this.groupByConversation(messages);
      const nextCursor = extractSkipToken(res?.["@odata.nextLink"] as string | undefined);
      return { items: threads, nextCursor };
    } catch (e) {
      throw mapError(e);
    }
  }

  async getThread(id: ThreadId): Promise<CanonicalThread> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await this.loadFolderIds(client);

      // Single round-trip: filter by conversationId across the mailbox.
      const res = await client
        .api("/me/messages")
        .filter(`conversationId eq '${id}'`)
        .orderby("receivedDateTime asc")
        .top(100)
        .select(THREAD_FIELDS)
        .get();
      const messages = (res?.value ?? []) as GraphMessage[];
      const canonicalMsgs = messages.map((m) => this.normalizeMessage(m));
      canonicalMsgs.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
      return this.buildThread(id, canonicalMsgs);
    } catch (e) {
      throw mapError(e);
    }
  }

  async sendMessage(draft: SendDraft): Promise<{ id: MessageId; threadId: ThreadId }> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await client.api("/me/sendMail").post({
        message: buildGraphMessage(draft),
        saveToSentItems: true,
      });
      // /sendMail is fire-and-forget and does NOT return the message id. To
      // satisfy the IEmailProvider contract we follow up with a top-1 read of
      // Sent Items ordered by sentDateTime desc. TOCTOU window if two sends
      // race within the same second — acceptable for MVP (flagged in the
      // technical spec).
      const sent = await client
        .api("/me/mailFolders/sentitems/messages")
        .top(1)
        .orderby("sentDateTime desc")
        .select("id,conversationId")
        .get();
      const top = (sent?.value ?? [])[0] as GraphMessage | undefined;
      return { id: top?.id ?? "", threadId: top?.conversationId ?? "" };
    } catch (e) {
      throw mapError(e);
    }
  }

  async reply(_threadId: ThreadId, draft: SendDraft): Promise<{ id: MessageId }> {
    if (!draft.inReplyTo) {
      throw mapError(new Error("reply requires draft.inReplyTo to be set"));
    }
    let draftId: string | null = null;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);

      // Step 1: createReply produces a draft in Drafts folder. Sets conversation,
      // In-Reply-To, References, and base recipients automatically.
      const createdDraft = await client
        .api(`/me/messages/${draft.inReplyTo}/createReply`)
        .post({});
      const id = (createdDraft as { id?: string })?.id;
      if (!id) throw new Error("createReply returned no draft id");
      draftId = id;

      // Step 2: PATCH the draft with our body and any caller-supplied recipient
      // overrides. createReply pre-populates to/from; we overwrite if provided.
      const patch: Record<string, unknown> = {
        body: { contentType: "HTML", content: draft.bodyHtml },
      };
      if (draft.to.length > 0) patch.toRecipients = draft.to.map(toRecipient);
      if (draft.cc?.length) patch.ccRecipients = draft.cc.map(toRecipient);
      if (draft.bcc?.length) patch.bccRecipients = draft.bcc.map(toRecipient);
      await client.api(`/me/messages/${draftId}`).patch(patch);

      // Step 3: send.
      await client.api(`/me/messages/${draftId}/send`).post({});

      return { id: draftId };
    } catch (e) {
      // Best-effort cleanup of an orphaned draft on intermediate failure.
      if (draftId) {
        try {
          const secret = await getMailboxSecret(this.accountId);
          if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
          const client = graphClient(secret);
          await client.api(`/me/messages/${draftId}`).delete();
        } catch {
          // Ignore — orphaned draft surfaces in user's Drafts folder; harmless.
        }
      }
      throw mapError(e);
    }
  }

  async archive(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await mapConcurrent(ids, 10, async (id) => {
        await client.api(`/me/messages/${id}/move`).post({ destinationId: "archive" });
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async trash(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await mapConcurrent(ids, 10, async (id) => {
        await client.api(`/me/messages/${id}/move`).post({ destinationId: "deleteditems" });
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async markRead(ids: MessageId[], read: boolean): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      // Graph's $batch ceiling is 20 requests; loop in chunks.
      for (const group of chunk(ids, 20)) {
        const requests = group.map((id, i) => ({
          id: String(i + 1),
          method: "PATCH",
          url: `/me/messages/${id}`,
          headers: { "Content-Type": "application/json" },
          body: { isRead: read },
        }));
        await client.api("/$batch").post({ requests });
      }
    } catch (e) {
      throw mapError(e);
    }
  }

  async setLabels(ids: MessageId[], add: string[], remove: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await this.loadFolderIds(client);

      // Classify add/remove sets into synthetic-label operations vs category
      // operations. Synthetic labels translate to folder-move or isRead PATCH;
      // categories flow through the message's `categories` array.
      const addSet = new Set(add);
      const removeSet = new Set(remove);

      // Synthetic-label-driven folder move:
      //   remove INBOX → archive  ;  add INBOX → inbox
      //   add TRASH    → deleteditems ;  remove TRASH → inbox
      // (SENT / DRAFT adds are no-ops per spec.)
      let folderMoveTarget: WellKnownFolder | null = null;
      if (addSet.has("TRASH")) folderMoveTarget = "deleteditems";
      else if (removeSet.has("INBOX")) folderMoveTarget = "archive";
      else if (addSet.has("INBOX")) folderMoveTarget = "inbox";
      else if (removeSet.has("TRASH")) folderMoveTarget = "inbox";

      // UNREAD-driven isRead PATCH:
      //   add UNREAD    → isRead: false
      //   remove UNREAD → isRead: true
      let isReadTarget: boolean | undefined;
      if (addSet.has("UNREAD")) isReadTarget = false;
      else if (removeSet.has("UNREAD")) isReadTarget = true;

      // Strip synthetic tokens before computing category diffs.
      const SYNTH = new Set(["INBOX", "SENT", "DRAFT", "TRASH", "UNREAD"]);
      const categoryAdds = add.filter((l) => !SYNTH.has(l));
      const categoryRemoves = remove.filter((l) => !SYNTH.has(l));

      await mapConcurrent(ids, 10, async (id) => {
        // Read current categories (and folder, in case the move requires
        // knowing whether the message is already there — but Graph's /move
        // is idempotent, so we PATCH categories unconditionally if there's
        // a diff and call /move unconditionally if we have a target).
        const current = (await client
          .api(`/me/messages/${id}`)
          .select("categories,parentFolderId,isRead")
          .get()) as { categories?: string[]; isRead?: boolean };

        const nextCategories = (() => {
          if (categoryAdds.length === 0 && categoryRemoves.length === 0) return null;
          const set = new Set(current.categories ?? []);
          for (const c of categoryAdds) set.add(c);
          for (const c of categoryRemoves) set.delete(c);
          return [...set];
        })();

        const patch: Record<string, unknown> = {};
        if (nextCategories) patch.categories = nextCategories;
        if (isReadTarget !== undefined && current.isRead !== isReadTarget) {
          patch.isRead = isReadTarget;
        }
        if (Object.keys(patch).length > 0) {
          await client.api(`/me/messages/${id}`).patch(patch);
        }
        if (folderMoveTarget) {
          await client
            .api(`/me/messages/${id}/move`)
            .post({ destinationId: folderMoveTarget });
        }
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async search(query: string, opts?: { limit?: number }): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await this.loadFolderIds(client);
      const top = opts?.limit ?? 50;
      const res = await client
        .api("/me/messages")
        .header("ConsistencyLevel", "eventual")
        .search(`"${escapeSearchTerm(query)}"`)
        .top(top)
        .select(LIST_FIELDS)
        .get();
      const messages = (res?.value ?? []) as GraphMessage[];
      const threads = this.groupByConversation(messages);
      // $search does not surface a stable @odata.nextLink — single page only.
      return { items: threads, nextCursor: null };
    } catch (e) {
      throw mapError(e);
    }
  }

  async syncDelta(cursor: string | null): Promise<DeltaResult> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Graph account");
      const client = graphClient(secret);
      await this.loadFolderIds(client);

      // Cold start: drain to a deltaLink without normalizing anything.
      if (!cursor) {
        let nextUrl = "/me/mailFolders/inbox/messages/delta?$top=1";
        while (true) {
          const page = await client.api(nextUrl).get();
          const deltaLink = page?.["@odata.deltaLink"] as string | undefined;
          if (deltaLink) {
            return {
              newMessages: [],
              changedMessages: [],
              deletedIds: [],
              nextCursor: deltaLink,
            };
          }
          const nl = page?.["@odata.nextLink"] as string | undefined;
          if (!nl) throw new Error("Graph delta returned neither nextLink nor deltaLink");
          nextUrl = nl;
        }
      }

      // Incremental: follow the saved deltaLink. `cursor` IS the full URL.
      const collected: GraphDeltaEntry[] = [];
      const deletedIds: MessageId[] = [];
      let nextUrl: string = cursor;
      let finalDeltaLink: string | null = null;

      while (true) {
        const page = await client.api(nextUrl).get();
        for (const entry of (page?.value ?? []) as GraphDeltaEntry[]) {
          if (entry["@removed"]) {
            if (entry.id) deletedIds.push(entry.id);
          } else {
            collected.push(entry);
          }
        }
        const deltaLink = page?.["@odata.deltaLink"] as string | undefined;
        if (deltaLink) {
          finalDeltaLink = deltaLink;
          break;
        }
        const nl = page?.["@odata.nextLink"] as string | undefined;
        if (!nl) throw new Error("Graph delta returned neither nextLink nor deltaLink");
        nextUrl = nl;
      }

      const newMessages = collected.map((entry) => this.normalizeMessage(entry));

      // Attachment metadata fanout for `hasAttachments: true` messages only.
      const withAttachmentsIdx: number[] = [];
      for (let i = 0; i < collected.length; i++) {
        if (collected[i]?.hasAttachments) withAttachmentsIdx.push(i);
      }
      await mapConcurrent(withAttachmentsIdx, 10, async (i) => {
        const msg = newMessages[i];
        if (!msg) return;
        msg.attachments = await this.fetchAttachmentMeta(client, msg.id);
      });

      return {
        newMessages,
        changedMessages: [],
        deletedIds,
        nextCursor: finalDeltaLink ?? "",
      };
    } catch (e) {
      throw mapError(e);
    }
  }
}
