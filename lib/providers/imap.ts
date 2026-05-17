// IMAP provider adapter. Implements `IEmailProvider` against the `imapflow`
// library for read / sync / flag operations and `nodemailer` for SMTP send.
// Every method opens a fresh `imapflow` client, does its work, and logs out
// in a `finally` block — there is no long-lived connection pool. Per-method
// connect overhead is ~80–150ms against Yahoo/AOL, acceptable for an MVP.
//
// Conventions enforced here (per `provider-adapter-template`):
//   - Adapters NEVER refresh tokens inline. IMAP secrets don't expire, but
//     we still funnel through `getMailboxSecret` for shape consistency.
//   - Adapters NEVER throw provider-specific errors — every catch maps via
//     `mapError(e)` from `./error-mapping` (which has an `imapflow`-flavored
//     branch that sanitizes auth-failure messages — no host/username leak).
//   - Thread id = RFC 5322 `Message-ID` of the thread root (brackets stripped),
//     inherited via the `In-Reply-To` / `References` chain. See
//     `resolveThreadId` for the lookup-then-mint algorithm.
//   - Sync cursor = `<UIDVALIDITY>:<HIGHEST_UID>`. UIDVALIDITY drift throws
//     `AuthError("Mailbox state reset — reconnect required")` (host NOT echoed).

import { assertHostAllowed } from "@/lib/auth/imap-host-guard";
import { prisma } from "@/lib/db";
import { type ImapMailboxSecret, getMailboxSecret } from "@/lib/providers/auth";
import { AuthError } from "@/lib/providers/errors";
import { mapError } from "@/lib/providers/error-mapping";
import type { Prisma } from "@prisma/client";
import {
  type FetchMessageObject,
  ImapFlow,
  type ListTreeResponse,
  type MailboxObject,
  type MessageAddressObject,
  type SearchObject,
} from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
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

const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 465;
const THREAD_MESSAGE_CAP = 50;

// Fallback folder names when the server does not advertise SPECIAL-USE flags
// (Yahoo / AOL both do; this covers the edge case).
const FOLDER_FALLBACKS: Record<"sent" | "trash" | "drafts" | "archive", string[]> = {
  sent: ["Sent", "Sent Items", "Sent Mail"],
  trash: ["Trash", "Deleted", "Deleted Items"],
  drafts: ["Drafts", "Draft"],
  archive: ["Archive", "Archives", "All Mail"],
};

// ─── Helpers ──────────────────────────────────────────────────────────────

function stripBrackets(messageId: string): string {
  return messageId.replace(/^<(.*)>$/, "$1").trim();
}

function parseMessageIdList(header: string | string[] | undefined): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(" ") : header;
  return raw
    .split(/\s+/)
    .map((s) => stripBrackets(s))
    .filter(Boolean);
}

function addressFromImap(a: MessageAddressObject | undefined): CanonicalAddress | null {
  if (!a?.address) return null;
  if (a.name) return { name: a.name, email: a.address };
  return { email: a.address };
}

function addressListFromImap(
  list: MessageAddressObject[] | undefined,
): CanonicalAddress[] {
  if (!list) return [];
  const out: CanonicalAddress[] = [];
  for (const a of list) {
    const parsed = addressFromImap(a);
    if (parsed) out.push(parsed);
  }
  return out;
}

function formatAddress(addr: CanonicalAddress): string {
  if (addr.name) return `"${addr.name.replace(/"/g, '\\"')}" <${addr.email}>`;
  return addr.email;
}

// Walk every node in a `listTree` response (depth-first).
function* walkTree(tree: ListTreeResponse): Generator<ListTreeResponse> {
  yield tree;
  for (const child of tree.folders ?? []) {
    yield* walkTree(child);
  }
}

function existsInTree(tree: ListTreeResponse, path: string): boolean {
  for (const node of walkTree(tree)) {
    if (node.path === path) return true;
  }
  return false;
}

interface SpecialFolders {
  sent: string | null;
  trash: string | null;
  drafts: string | null;
  archive: string | null;
}

async function resolveSpecialFolders(client: ImapFlow): Promise<SpecialFolders> {
  const tree = await client.listTree();
  const folders: SpecialFolders = { sent: null, trash: null, drafts: null, archive: null };
  for (const node of walkTree(tree)) {
    if (!node.path) continue;
    switch (node.specialUse) {
      case "\\Sent":
        folders.sent = node.path;
        break;
      case "\\Trash":
        folders.trash = node.path;
        break;
      case "\\Drafts":
        folders.drafts = node.path;
        break;
      case "\\Archive":
        folders.archive = node.path;
        break;
    }
  }
  for (const [key, candidates] of Object.entries(FOLDER_FALLBACKS) as Array<
    [keyof SpecialFolders, string[]]
  >) {
    if (folders[key]) continue;
    for (const candidate of candidates) {
      if (existsInTree(tree, candidate)) {
        folders[key] = candidate;
        break;
      }
    }
  }
  return folders;
}

// Synthesize the system-label set for a message from its current folder +
// flags. Mirrors the graph-provider table — INBOX/SENT/DRAFT/TRASH plus
// UNREAD (from `\Seen` absence) and STARRED (from `\Flagged` presence).
function synthesizeLabels(
  folderPath: string,
  specialFolders: SpecialFolders,
  flags: Set<string> | undefined,
): string[] {
  const out: string[] = [];
  if (folderPath.toUpperCase() === "INBOX") out.push("INBOX");
  else if (specialFolders.sent && folderPath === specialFolders.sent) out.push("SENT");
  else if (specialFolders.drafts && folderPath === specialFolders.drafts) out.push("DRAFT");
  else if (specialFolders.trash && folderPath === specialFolders.trash) out.push("TRASH");
  if (!flags || !flags.has("\\Seen")) out.push("UNREAD");
  if (flags?.has("\\Flagged")) out.push("STARRED");
  return out;
}

// ─── Threading reconstruction ─────────────────────────────────────────────

/**
 * Given a new IMAP message's id + parent refs, look up any matching
 * `Message.providerMessageId` already in the DB (within the transaction).
 * Return that message's `providerThreadId` if found; otherwise mint
 * `messageId` itself as the new `providerThreadId`.
 *
 * Called by the sync writer inside `writeDelta` for each new message; the
 * `tx` argument keeps the lookup consistent.
 */
export async function resolveThreadId(
  messageId: string,
  inReplyTo: string | null,
  references: string[],
  accountId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const refIds = [...(inReplyTo ? [inReplyTo] : []), ...references].filter(Boolean);
  if (refIds.length > 0) {
    const match = await tx.message.findFirst({
      where: { accountId, providerMessageId: { in: refIds } },
      select: { providerThreadId: true },
    });
    if (match) return match.providerThreadId;
  }
  // No parent in our DB → mint our own thread id from this message's Message-ID.
  return messageId;
}

// ─── Normalization ────────────────────────────────────────────────────────

interface NormalizedMessage extends CanonicalMessage {
  /** IMAP UID — internal, used only by the sync cursor; not on the canonical shape. */
  _uid?: number;
}

async function normalizeFetchedMessage(
  msg: FetchMessageObject,
  folderPath: string,
  specialFolders: SpecialFolders,
  accountId: string,
): Promise<NormalizedMessage> {
  const env = msg.envelope ?? {};
  const messageId = stripBrackets(env.messageId ?? "");
  const inReplyTo = env.inReplyTo ? stripBrackets(env.inReplyTo) : null;
  const fromList = addressListFromImap(env.from);
  const labels = synthesizeLabels(folderPath, specialFolders, msg.flags);

  // Parse raw source for body + attachments. `simpleParser` handles MIME
  // walking — quoted-printable, base64, multipart/alternative, etc. We trust
  // mailparser for the parsing per spec ("don't reinvent").
  let bodyHtml: string | null = null;
  let bodyText: string | null = null;
  let attachments: CanonicalAttachmentMeta[] = [];
  let references: string[] = [];
  if (msg.source) {
    try {
      const parsed = await simpleParser(msg.source);
      bodyHtml = typeof parsed.html === "string" ? parsed.html : null;
      bodyText = typeof parsed.text === "string" ? parsed.text : null;
      attachments = parsed.attachments
        .filter((a) => a.filename)
        .map((a, i) => ({
          // `bodyStructure` part path would be the most natural id (technical
          // spec mentions imapflow's BODYSTRUCTURE part path like "2.1") but
          // mailparser surfaces only an index-by-order. Use that — stable
          // within a single message, and we re-parse on demand for bytes.
          id: a.cid ?? String(i + 1),
          filename: a.filename as string,
          mimeType: a.contentType ?? "application/octet-stream",
          size: a.size ?? 0,
        }));
      const refsHeader = parsed.headers.get("references");
      if (typeof refsHeader === "string") {
        references = parseMessageIdList(refsHeader);
      }
    } catch {
      // If mailparser chokes on a malformed message we still surface envelope
      // metadata — body + attachments stay null/[].
    }
  }

  // Snippet: prefer text body's first ~200 chars (matches Gmail's snippet
  // length roughly). UI fallback handles empty snippets.
  const snippet =
    bodyText?.replace(/\s+/g, " ").trim().slice(0, 200) ??
    bodyHtml?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) ??
    "";

  return {
    id: messageId,
    threadId: messageId, // overridden by resolveThreadId during writeback
    accountId,
    from: fromList[0] ?? { email: "" },
    to: addressListFromImap(env.to),
    cc: addressListFromImap(env.cc),
    bcc: addressListFromImap(env.bcc),
    subject: env.subject ?? "",
    snippet,
    bodyHtml,
    bodyText,
    receivedAt: env.date ?? (msg.internalDate ? new Date(msg.internalDate) : new Date(0)),
    isUnread: !msg.flags?.has("\\Seen"),
    labels,
    inReplyTo,
    references,
    attachments,
    _uid: msg.uid,
  };
}

function buildThreadFromMessages(
  threadId: string,
  messages: CanonicalMessage[],
  accountId: string,
): CanonicalThread {
  messages.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
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
    id: threadId,
    accountId,
    subject: messages[0]?.subject ?? "",
    snippet: last?.snippet ?? messages[0]?.snippet ?? "",
    participants: [...participantsMap.values()],
    lastMessageAt: last?.receivedAt ?? new Date(0),
    unreadCount,
    labels: [...labelsSet],
    messageIds: messages.map((m) => m.id),
  };
}

// ─── Cursor ───────────────────────────────────────────────────────────────

interface ParsedCursor {
  uidValidity: bigint;
  uid: number;
}

function parseCursor(cursor: string | null): ParsedCursor | null {
  if (!cursor) return null;
  const idx = cursor.indexOf(":");
  if (idx < 0) return null;
  const v = cursor.slice(0, idx);
  const u = cursor.slice(idx + 1);
  try {
    return { uidValidity: BigInt(v), uid: Number(u) };
  } catch {
    return null;
  }
}

function formatCursor(uidValidity: bigint | number, uid: number): string {
  return `${uidValidity.toString()}:${uid}`;
}

// ─── MIME assembly for send/reply ─────────────────────────────────────────

function buildOutgoingMessage(
  draft: SendDraft,
  from: CanonicalAddress,
): {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
} {
  return {
    from: formatAddress(from),
    to: draft.to.map(formatAddress),
    cc: (draft.cc ?? []).map(formatAddress),
    bcc: (draft.bcc ?? []).map(formatAddress),
    subject: draft.subject,
    html: draft.bodyHtml,
    text: draft.bodyText,
    inReplyTo: draft.inReplyTo ? `<${draft.inReplyTo}>` : undefined,
    references: draft.references?.length
      ? draft.references.map((r) => `<${r}>`).join(" ")
      : undefined,
    attachments: draft.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.mimeType,
    })),
  };
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export class ImapProvider implements IEmailProvider {
  constructor(private readonly accountId: string) {}

  /**
   * Open a fresh imapflow client. Pulls the IMAP secret via the centralized
   * helper, narrows on the discriminated-union kind, re-checks the host
   * against the SSRF guard (defense-in-depth — the stored host could be
   * tampered with after sign-in), and connects with TLS required.
   *
   * Also resolves the account's email address from `MailAccount` so we can
   * use it as the SMTP `From` and the IMAP login user.
   */
  private async openClient(): Promise<{
    client: ImapFlow;
    secret: ImapMailboxSecret;
    emailAddress: string;
  }> {
    const secret = await getMailboxSecret(this.accountId);
    if (secret.kind !== "imap") {
      throw new Error("Expected IMAP secret on an IMAP account");
    }
    const port = secret.imapPort ?? DEFAULT_IMAP_PORT;
    await assertHostAllowed(secret.imapHost, port);
    const row = await prisma.mailAccount.findUniqueOrThrow({
      where: { id: this.accountId },
      select: { emailAddress: true },
    });
    const client = new ImapFlow({
      host: secret.imapHost,
      port,
      secure: true,
      auth: { user: row.emailAddress, pass: secret.password },
      logger: false,
    });
    await client.connect();
    return { client, secret, emailAddress: row.emailAddress };
  }

  private async withClient<T>(
    fn: (ctx: {
      client: ImapFlow;
      secret: ImapMailboxSecret;
      emailAddress: string;
    }) => Promise<T>,
  ): Promise<T> {
    const ctx = await this.openClient();
    try {
      return await fn(ctx);
    } catch (e) {
      throw mapError(e);
    } finally {
      try {
        await ctx.client.logout();
      } catch {
        /* ignore */
      }
    }
  }

  // ── IEmailProvider ────────────────────────────────────────────────────

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    return this.withClient(async ({ client }) => {
      const mailbox = (await client.mailboxOpen("INBOX")) as MailboxObject;
      const specialFolders = await resolveSpecialFolders(client);
      const limit = opts.limit ?? 50;

      // Cursor encodes an upper-bound UID for pagination. First page: from
      // mailbox.uidNext-1 going down. Subsequent pages: from `opts.cursor - 1`.
      const parsedCursor = parseCursor(opts.cursor ?? null);
      const upper = parsedCursor ? parsedCursor.uid : (mailbox.uidNext ?? 1) - 1;
      if (upper <= 0) return { items: [], nextCursor: null };

      const lower = Math.max(1, upper - limit + 1);
      const range = `${lower}:${upper}`;

      const fetched: NormalizedMessage[] = [];
      for await (const msg of client.fetch(
        range,
        { envelope: true, source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        const canonical = await normalizeFetchedMessage(
          msg,
          "INBOX",
          specialFolders,
          this.accountId,
        );
        fetched.push(canonical);
      }

      // Group by reconstructed thread (in-memory only — we don't write to DB
      // here). Use the same lookup-then-mint algorithm but scoped to this
      // batch: build a Message-ID → threadId map as we go.
      const messageIdToThreadId = new Map<string, string>();
      for (const m of fetched) {
        const refIds = [...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references];
        let threadId: string | undefined;
        for (const refId of refIds) {
          if (messageIdToThreadId.has(refId)) {
            threadId = messageIdToThreadId.get(refId);
            break;
          }
        }
        if (!threadId) threadId = m.id; // mint own
        messageIdToThreadId.set(m.id, threadId);
        m.threadId = threadId;
      }

      // Aggregate into threads.
      const byThread = new Map<string, CanonicalMessage[]>();
      for (const m of fetched) {
        const arr = byThread.get(m.threadId);
        if (arr) arr.push(m);
        else byThread.set(m.threadId, [m]);
      }
      const threads: CanonicalThread[] = [];
      for (const [tid, msgs] of byThread.entries()) {
        threads.push(buildThreadFromMessages(tid, msgs, this.accountId));
      }
      threads.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());

      const nextCursor =
        lower > 1 ? formatCursor(mailbox.uidValidity, lower - 1) : null;
      return { items: threads, nextCursor };
    });
  }

  async getThread(id: ThreadId): Promise<CanonicalThread> {
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const specialFolders = await resolveSpecialFolders(client);

      // Locate the seed message by Message-ID (HEADER search).
      const seedUids = (await client.search({ header: { "message-id": id } }, { uid: true })) || [];
      if (!seedUids || seedUids.length === 0) {
        // Empty — return a placeholder thread shape rather than throwing;
        // the UI handles empty threads gracefully (matches Gmail's
        // get-thread-for-deleted-id behavior).
        return buildThreadFromMessages(id, [], this.accountId);
      }

      const collected: NormalizedMessage[] = [];
      const seenMessageIds = new Set<string>();
      const toFetchByMessageId = new Set<string>([id]);

      // BFS up the parent chain via In-Reply-To / References. Cap at
      // THREAD_MESSAGE_CAP to defend against pathological loops.
      while (toFetchByMessageId.size > 0 && collected.length < THREAD_MESSAGE_CAP) {
        const batch = [...toFetchByMessageId];
        toFetchByMessageId.clear();
        for (const mid of batch) {
          if (seenMessageIds.has(mid)) continue;
          const uids = await client.search({ header: { "message-id": mid } }, { uid: true });
          if (!uids || uids.length === 0) {
            seenMessageIds.add(mid);
            continue;
          }
          for await (const msg of client.fetch(
            uids,
            { envelope: true, source: true, flags: true, internalDate: true },
            { uid: true },
          )) {
            const canonical = await normalizeFetchedMessage(
              msg,
              "INBOX",
              specialFolders,
              this.accountId,
            );
            seenMessageIds.add(canonical.id);
            collected.push(canonical);
            if (collected.length >= THREAD_MESSAGE_CAP) break;
            // Walk parents — but don't re-queue already-seen ids.
            const parents = [...(canonical.inReplyTo ? [canonical.inReplyTo] : []), ...canonical.references];
            for (const p of parents) {
              if (p && !seenMessageIds.has(p)) toFetchByMessageId.add(p);
            }
          }
        }
      }

      // Assign every collected message to the seed's id as the thread root.
      for (const m of collected) m.threadId = id;
      return buildThreadFromMessages(id, collected, this.accountId);
    });
  }

  async sendMessage(draft: SendDraft): Promise<{ id: MessageId; threadId: ThreadId }> {
    return this.withClient(async ({ secret, emailAddress, client }) => {
      const smtpPort = secret.smtpPort ?? DEFAULT_SMTP_PORT;
      await assertHostAllowed(secret.smtpHost, smtpPort);
      const transport = createTransport({
        host: secret.smtpHost,
        port: smtpPort,
        // 465 = implicit TLS; for other ports require STARTTLS.
        secure: smtpPort === 465,
        requireTLS: smtpPort !== 465,
        auth: { user: emailAddress, pass: secret.password },
      });
      const info = await transport.sendMail(
        buildOutgoingMessage(draft, { email: emailAddress }),
      );
      const messageId = stripBrackets(
        (info as { messageId?: string }).messageId ?? "",
      );

      // APPEND raw message to Sent so it surfaces in the user's sent items.
      try {
        const specialFolders = await resolveSpecialFolders(client);
        const sentFolder = specialFolders.sent ?? "Sent";
        const raw = (info as { message?: Buffer | string }).message;
        if (raw) {
          await client.append(sentFolder, raw as Buffer | string, ["\\Seen"]);
        }
      } catch {
        // Best-effort — failing to APPEND doesn't invalidate the send.
      }

      return { id: messageId, threadId: messageId };
    });
  }

  async reply(threadId: ThreadId, draft: SendDraft): Promise<{ id: MessageId }> {
    // reply differs from sendMessage only in that thread headers are
    // pre-populated by the caller (`draft.inReplyTo` / `draft.references`).
    // The MIME builder picks them up unconditionally.
    const { id } = await this.sendMessage(draft);
    // threadId arg is informational — we don't need to look it up server-side
    // because the In-Reply-To/References headers do the linkage. (Mirrors
    // the spec's mapping table: "Same as sendMessage but pre-populates
    // In-Reply-To and References".)
    void threadId;
    return { id };
  }

  async archive(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const specialFolders = await resolveSpecialFolders(client);
      const archive = specialFolders.archive ?? "Archive";
      const uids = await this.resolveUidsByMessageIds(client, ids);
      if (uids.length === 0) return;
      await client.messageMove(uids, archive, { uid: true });
    });
  }

  async trash(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const specialFolders = await resolveSpecialFolders(client);
      const trash = specialFolders.trash ?? "Trash";
      const uids = await this.resolveUidsByMessageIds(client, ids);
      if (uids.length === 0) return;
      await client.messageMove(uids, trash, { uid: true });
    });
  }

  async markRead(ids: MessageId[], read: boolean): Promise<void> {
    if (ids.length === 0) return;
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const uids = await this.resolveUidsByMessageIds(client, ids);
      if (uids.length === 0) return;
      if (read) {
        await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      } else {
        await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      }
    });
  }

  async setLabels(ids: MessageId[], add: string[], remove: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const specialFolders = await resolveSpecialFolders(client);
      const uids = await this.resolveUidsByMessageIds(client, ids);
      if (uids.length === 0) return;

      const addSet = new Set(add);
      const removeSet = new Set(remove);

      // UNREAD ↔ \Seen flag.
      if (addSet.has("UNREAD")) {
        await client.messageFlagsRemove(uids, ["\\Seen"], { uid: true });
      } else if (removeSet.has("UNREAD")) {
        await client.messageFlagsAdd(uids, ["\\Seen"], { uid: true });
      }
      // STARRED ↔ \Flagged flag.
      if (addSet.has("STARRED")) {
        await client.messageFlagsAdd(uids, ["\\Flagged"], { uid: true });
      } else if (removeSet.has("STARRED")) {
        await client.messageFlagsRemove(uids, ["\\Flagged"], { uid: true });
      }
      // Folder moves: TRASH add → Trash, INBOX remove → Archive.
      if (addSet.has("TRASH")) {
        await client.messageMove(uids, specialFolders.trash ?? "Trash", { uid: true });
      } else if (removeSet.has("INBOX")) {
        await client.messageMove(uids, specialFolders.archive ?? "Archive", { uid: true });
      }
      // Any other (user) label → silently dropped per non-goal. The method
      // still resolves successfully; the UI's optimistic local mutation
      // persists the label in our DB.
    });
  }

  async search(query: string, opts?: { limit?: number }): Promise<ListResult<CanonicalThread>> {
    return this.withClient(async ({ client }) => {
      await client.mailboxOpen("INBOX");
      const specialFolders = await resolveSpecialFolders(client);
      const limit = opts?.limit ?? 50;

      // Operator parsing: `from:foo` → SearchObject.from; otherwise body match.
      let searchObj: SearchObject;
      const fromMatch = /^from:(\S+)\s*$/i.exec(query.trim());
      if (fromMatch?.[1]) searchObj = { from: fromMatch[1] };
      else searchObj = { body: query };

      const uids = (await client.search(searchObj, { uid: true })) || [];
      if (!uids || uids.length === 0) return { items: [], nextCursor: null };

      // Take the most recent `limit` UIDs (UIDs are monotonically increasing).
      const capped = uids.slice(-limit);
      const fetched: NormalizedMessage[] = [];
      for await (const msg of client.fetch(
        capped,
        { envelope: true, source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        const canonical = await normalizeFetchedMessage(
          msg,
          "INBOX",
          specialFolders,
          this.accountId,
        );
        fetched.push(canonical);
      }

      // Same in-batch threading as listThreads.
      const messageIdToThreadId = new Map<string, string>();
      for (const m of fetched) {
        const refIds = [...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references];
        let threadId: string | undefined;
        for (const refId of refIds) {
          if (messageIdToThreadId.has(refId)) {
            threadId = messageIdToThreadId.get(refId);
            break;
          }
        }
        if (!threadId) threadId = m.id;
        messageIdToThreadId.set(m.id, threadId);
        m.threadId = threadId;
      }
      const byThread = new Map<string, CanonicalMessage[]>();
      for (const m of fetched) {
        const arr = byThread.get(m.threadId);
        if (arr) arr.push(m);
        else byThread.set(m.threadId, [m]);
      }
      const threads: CanonicalThread[] = [];
      for (const [tid, msgs] of byThread.entries()) {
        threads.push(buildThreadFromMessages(tid, msgs, this.accountId));
      }
      threads.sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime());

      // Single-page search — same posture as graph-provider's $search.
      return { items: threads, nextCursor: null };
    });
  }

  async syncDelta(cursor: string | null): Promise<DeltaResult> {
    return this.withClient(async ({ client }) => {
      const mailbox = (await client.mailboxOpen("INBOX")) as MailboxObject;
      const specialFolders = await resolveSpecialFolders(client);
      const parsed = parseCursor(cursor);
      const currentValidity = mailbox.uidValidity;

      // UIDVALIDITY drift → reconnect required. No host echoed.
      if (parsed && parsed.uidValidity !== currentValidity) {
        throw new AuthError("Mailbox state reset — reconnect required");
      }

      // Cold start: record `<UIDVALIDITY>:<uidNext - 1>` and return empty.
      if (!parsed) {
        const seed = (mailbox.uidNext ?? 1) - 1;
        return {
          newMessages: [],
          changedMessages: [],
          deletedIds: [],
          nextCursor: formatCursor(currentValidity, Math.max(0, seed)),
        };
      }

      const fromUid = parsed.uid + 1;
      const range = `${fromUid}:*`;
      const newMessages: NormalizedMessage[] = [];
      let maxUid = parsed.uid;
      for await (const msg of client.fetch(
        range,
        { envelope: true, source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        // imapflow returns `from:*` with at least one match even when there
        // are no new messages — that single match is the highest existing
        // UID. Guard by comparing to our cursor.
        if (msg.uid <= parsed.uid) continue;
        const canonical = await normalizeFetchedMessage(
          msg,
          "INBOX",
          specialFolders,
          this.accountId,
        );
        newMessages.push(canonical);
        if (msg.uid > maxUid) maxUid = msg.uid;
      }

      return {
        newMessages,
        // UID-range polling doesn't see flag changes or deletions on
        // already-known UIDs. Documented MVP gap (spec non-goals).
        changedMessages: [],
        deletedIds: [],
        nextCursor: formatCursor(currentValidity, maxUid),
      };
    });
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  /**
   * Convert provider message ids (RFC 5322 Message-IDs) into IMAP UIDs in
   * the currently-open mailbox. Issues one HEADER search per id; IMAP doesn't
   * support batched header lookups across distinct values. Bounded by the
   * caller's per-action selection — typically < 20 ids — so the chatter is
   * acceptable for an MVP.
   */
  private async resolveUidsByMessageIds(
    client: ImapFlow,
    messageIds: string[],
  ): Promise<number[]> {
    const out: number[] = [];
    for (const mid of messageIds) {
      const uids = await client.search({ header: { "message-id": mid } }, { uid: true });
      if (uids && uids.length > 0) out.push(...uids);
    }
    return out;
  }
}
