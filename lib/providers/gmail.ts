// Gmail provider adapter. Implements `IEmailProvider` against the official
// `googleapis` SDK. Every method funnels its work through `getMailboxSecret`
// (centralized token refresh) and `mapError` (canonical error taxonomy).
//
// Conventions enforced here:
//   - Adapters NEVER refresh tokens inline (architectural rule #7).
//   - Adapters NEVER throw provider-specific errors — every catch maps via
//     `mapError(e)` from `./error-mapping`.
//   - Pagination uses Gmail's `pageToken` mapped onto our canonical
//     `nextCursor`.
//   - `messages.get` calls during sync are bounded at concurrency 10
//     (spec calls out Gmail's 250 qu/s quota; this keeps us well under).

import { type MailboxSecret, getMailboxSecret } from "@/lib/providers/auth";
import { mapError } from "@/lib/providers/error-mapping";
import { type gmail_v1, google } from "googleapis";
import type {
  CanonicalAddress,
  CanonicalAttachmentMeta,
  CanonicalMessage,
  CanonicalThread,
  DeltaResult,
  IEmailProvider,
  ListResult,
  ListThreadsOptions,
  MessageChange,
  MessageId,
  SendDraft,
  ThreadId,
} from "./types";

// ─── Helpers ──────────────────────────────────────────────────────────────

function gmailClient(secret: MailboxSecret): gmail_v1.Gmail {
  // `googleapis` *can* refresh on its own if you set both access and refresh
  // tokens on the OAuth2 client — we intentionally do not. Token refresh is
  // centralized in `lib/providers/auth.ts` (architectural rule #7).
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  );
  oauth2.setCredentials({ access_token: secret.accessToken });
  return google.gmail({ version: "v1", auth: oauth2 });
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

function base64UrlDecode(input: string): string {
  // Gmail returns base64url-encoded part bodies. Buffer handles base64url
  // directly in Node 20+.
  return Buffer.from(input, "base64url").toString("utf8");
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

// ─── Header parsing ───────────────────────────────────────────────────────

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  if (!headers) return "";
  const lower = name.toLowerCase();
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === lower) return h.value ?? "";
  }
  return "";
}

/**
 * Minimal RFC 5322 address-list parser. Handles the three common shapes:
 *   - `bare@example.com`
 *   - `Name <addr@example.com>`
 *   - `"Quoted Name" <addr@example.com>`
 * Returns `[]` for empty / unparseable input rather than throwing.
 *
 * Not exhaustive (no group syntax, no comment handling), but every header
 * Gmail emits is well-formed enough for this to work.
 */
function parseAddressList(header: string): CanonicalAddress[] {
  if (!header) return [];
  const out: CanonicalAddress[] = [];
  // Split on top-level commas (don't split inside quotes or angle brackets).
  const parts: string[] = [];
  let depthAngle = 0;
  let inQuotes = false;
  let buf = "";
  for (const ch of header) {
    if (ch === "\\") {
      buf += ch;
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch === "<") depthAngle++;
    else if (!inQuotes && ch === ">") depthAngle = Math.max(0, depthAngle - 1);
    if (!inQuotes && depthAngle === 0 && ch === ",") {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  for (const raw of parts) {
    if (!raw) continue;
    const angleStart = raw.lastIndexOf("<");
    const angleEnd = raw.lastIndexOf(">");
    if (angleStart !== -1 && angleEnd > angleStart) {
      const email = raw.slice(angleStart + 1, angleEnd).trim();
      const name = raw
        .slice(0, angleStart)
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim();
      if (email) out.push(name ? { name, email } : { email });
    } else if (raw.includes("@")) {
      out.push({ email: raw.trim() });
    }
  }
  return out;
}

function parseMessageIdList(header: string): string[] {
  if (!header) return [];
  // RFC 5322 message-ids are bracketed: `<id@host>`. Split on whitespace,
  // strip brackets.
  return header
    .split(/\s+/)
    .map((s) => s.trim().replace(/^<(.*)>$/, "$1"))
    .filter(Boolean);
}

// ─── Body / attachment extraction ─────────────────────────────────────────

interface ExtractedBodies {
  bodyHtml: string | null;
  bodyText: string | null;
}

function extractBodies(payload: gmail_v1.Schema$MessagePart | undefined): ExtractedBodies {
  let bodyHtml: string | null = null;
  let bodyText: string | null = null;

  function walk(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    const mime = part.mimeType ?? "";
    const data = part.body?.data;
    if (data) {
      if (mime === "text/html" && bodyHtml === null) {
        bodyHtml = base64UrlDecode(data);
      } else if (mime === "text/plain" && bodyText === null) {
        bodyText = base64UrlDecode(data);
      }
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  return { bodyHtml, bodyText };
}

function extractAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
): CanonicalAttachmentMeta[] {
  const out: CanonicalAttachmentMeta[] = [];

  function walk(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return;
    const attachmentId = part.body?.attachmentId;
    const filename = part.filename;
    if (attachmentId && filename) {
      out.push({
        id: attachmentId,
        filename,
        mimeType: part.mimeType ?? "application/octet-stream",
        size: part.body?.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  }
  walk(payload);

  return out;
}

// ─── Normalization ────────────────────────────────────────────────────────

function normalizeMessage(msg: gmail_v1.Schema$Message, accountId: string): CanonicalMessage {
  const headers = msg.payload?.headers ?? [];
  const fromList = parseAddressList(getHeader(headers, "From"));
  const subject = getHeader(headers, "Subject");
  const inReplyTo = parseMessageIdList(getHeader(headers, "In-Reply-To"))[0] ?? null;
  const references = parseMessageIdList(getHeader(headers, "References"));
  const { bodyHtml, bodyText } = extractBodies(msg.payload);
  const labels = msg.labelIds ?? [];

  return {
    id: msg.id ?? "",
    threadId: msg.threadId ?? "",
    accountId,
    from: fromList[0] ?? { email: "" },
    to: parseAddressList(getHeader(headers, "To")),
    cc: parseAddressList(getHeader(headers, "Cc")),
    bcc: parseAddressList(getHeader(headers, "Bcc")),
    subject,
    snippet: msg.snippet ?? "",
    bodyHtml,
    bodyText,
    receivedAt: new Date(Number(msg.internalDate ?? 0)),
    isUnread: labels.includes("UNREAD"),
    labels,
    inReplyTo,
    references,
    attachments: extractAttachments(msg.payload),
  };
}

function normalizeThread(thread: gmail_v1.Schema$Thread, accountId: string): CanonicalThread {
  const messages = (thread.messages ?? []).map((m) => normalizeMessage(m, accountId));
  const lastMessage = messages[messages.length - 1];
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
    id: thread.id ?? "",
    accountId,
    subject: messages[0]?.subject ?? "",
    snippet: lastMessage?.snippet ?? messages[0]?.snippet ?? "",
    participants: [...participantsMap.values()],
    lastMessageAt: lastMessage?.receivedAt ?? new Date(0),
    unreadCount,
    labels: [...labelsSet],
    messageIds: messages.map((m) => m.id),
  };
}

/**
 * Light-weight CanonicalThread shape for `threads.list` results, which only
 * return `(id, snippet, historyId)` — no payloads. We populate just enough
 * fields to satisfy `ListResult<CanonicalThread>`; the UI calls `getThread`
 * for the full picture. `subject` is left empty (we don't have it from the
 * list call); UI renders snippet when subject is empty.
 */
function normalizeThreadSummary(
  thread: gmail_v1.Schema$Thread,
  accountId: string,
): CanonicalThread {
  return {
    id: thread.id ?? "",
    accountId,
    subject: "",
    snippet: thread.snippet ?? "",
    participants: [],
    lastMessageAt: new Date(0),
    unreadCount: 0,
    labels: [],
    messageIds: [],
  };
}

// ─── Send / reply RFC 2822 builder ────────────────────────────────────────

function formatAddress(addr: CanonicalAddress): string {
  if (addr.name) return `"${addr.name.replace(/"/g, '\\"')}" <${addr.email}>`;
  return addr.email;
}

function buildRfc2822(draft: SendDraft, opts?: { threadHeaders?: boolean }): string {
  const lines: string[] = [];
  lines.push(`To: ${draft.to.map(formatAddress).join(", ")}`);
  if (draft.cc?.length) lines.push(`Cc: ${draft.cc.map(formatAddress).join(", ")}`);
  if (draft.bcc?.length) lines.push(`Bcc: ${draft.bcc.map(formatAddress).join(", ")}`);
  lines.push(`Subject: ${draft.subject}`);
  if (opts?.threadHeaders && draft.inReplyTo) {
    lines.push(`In-Reply-To: <${draft.inReplyTo}>`);
  }
  if (opts?.threadHeaders && draft.references?.length) {
    lines.push(`References: ${draft.references.map((r) => `<${r}>`).join(" ")}`);
  }
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/html; charset="UTF-8"');
  lines.push("");
  lines.push(draft.bodyHtml);
  return lines.join("\r\n");
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export class GmailProvider implements IEmailProvider {
  constructor(private readonly accountId: string) {}

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      const res = await gmail.users.threads.list({
        userId: "me",
        pageToken: opts.cursor,
        maxResults: opts.limit ?? 50,
        labelIds: opts.label ? [opts.label] : undefined,
      });
      const items = (res.data.threads ?? []).map((t) => normalizeThreadSummary(t, this.accountId));
      return { items, nextCursor: res.data.nextPageToken ?? null };
    } catch (e) {
      throw mapError(e);
    }
  }

  async getThread(id: ThreadId): Promise<CanonicalThread> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      const res = await gmail.users.threads.get({
        userId: "me",
        id,
        format: "full",
      });
      return normalizeThread(res.data, this.accountId);
    } catch (e) {
      throw mapError(e);
    }
  }

  async sendMessage(draft: SendDraft): Promise<{ id: MessageId; threadId: ThreadId }> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      const raw = base64UrlEncode(buildRfc2822(draft));
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });
      return { id: res.data.id ?? "", threadId: res.data.threadId ?? "" };
    } catch (e) {
      throw mapError(e);
    }
  }

  async reply(threadId: ThreadId, draft: SendDraft): Promise<{ id: MessageId }> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      const raw = base64UrlEncode(buildRfc2822(draft, { threadHeaders: true }));
      const res = await gmail.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });
      return { id: res.data.id ?? "" };
    } catch (e) {
      throw mapError(e);
    }
  }

  async archive(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids, removeLabelIds: ["INBOX"] },
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async trash(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      // No batch endpoint for trash — bounded Promise.all.
      await mapConcurrent(ids, 10, (id) =>
        gmail.users.messages.trash({ userId: "me", id }).then(() => undefined),
      );
    } catch (e) {
      throw mapError(e);
    }
  }

  async markRead(ids: MessageId[], read: boolean): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: read ? { ids, removeLabelIds: ["UNREAD"] } : { ids, addLabelIds: ["UNREAD"] },
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async setLabels(ids: MessageId[], add: string[], remove: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: {
          ids,
          addLabelIds: add.length ? add : undefined,
          removeLabelIds: remove.length ? remove : undefined,
        },
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async search(query: string, opts?: { limit?: number }): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);
      const res = await gmail.users.threads.list({
        userId: "me",
        q: query,
        maxResults: opts?.limit ?? 50,
      });
      const items = (res.data.threads ?? []).map((t) => normalizeThreadSummary(t, this.accountId));
      return { items, nextCursor: res.data.nextPageToken ?? null };
    } catch (e) {
      throw mapError(e);
    }
  }

  async syncDelta(cursor: string | null): Promise<DeltaResult> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      const gmail = gmailClient(secret);

      // Cold start: no cursor → fetch the current historyId from the profile
      // and return an empty delta. Full-mailbox seed is out of scope here
      // (deferred — see `spec.md` non-goals).
      if (!cursor) {
        const profile = await gmail.users.getProfile({ userId: "me" });
        return {
          newMessages: [],
          changedMessages: [],
          deletedIds: [],
          nextCursor: String(profile.data.historyId ?? ""),
        };
      }

      const newMessageIds = new Set<string>();
      const deletedIds = new Set<string>();
      const changed = new Map<string, MessageChange>();
      let pageToken: string | undefined;
      // `historyId` is an unsigned int64 in protocol terms; compare via BigInt
      // to be safe on long-lived mailboxes.
      let maxHistoryId = cursor;

      do {
        const res = await gmail.users.history.list({
          userId: "me",
          startHistoryId: cursor,
          historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
          pageToken,
        });

        for (const h of res.data.history ?? []) {
          if (h.id) {
            try {
              if (BigInt(h.id) > BigInt(maxHistoryId)) maxHistoryId = h.id;
            } catch {
              // Non-numeric historyId — ignore.
            }
          }
          for (const a of h.messagesAdded ?? []) {
            if (a.message?.id) newMessageIds.add(a.message.id);
          }
          for (const d of h.messagesDeleted ?? []) {
            if (d.message?.id) deletedIds.add(d.message.id);
          }
          for (const l of h.labelsAdded ?? []) {
            const id = l.message?.id;
            if (!id) continue;
            const existing = changed.get(id) ?? { id, labels: [] };
            const added = l.labelIds ?? [];
            existing.labels = Array.from(new Set([...(existing.labels ?? []), ...added]));
            if (added.includes("UNREAD")) existing.isUnread = true;
            changed.set(id, existing);
          }
          for (const l of h.labelsRemoved ?? []) {
            const id = l.message?.id;
            if (!id) continue;
            const existing = changed.get(id) ?? { id, labels: [] };
            const removed = l.labelIds ?? [];
            existing.labels = (existing.labels ?? []).filter((lb) => !removed.includes(lb));
            if (removed.includes("UNREAD")) existing.isUnread = false;
            changed.set(id, existing);
          }
        }

        pageToken = res.data.nextPageToken ?? undefined;
        if (res.data.historyId) {
          try {
            if (BigInt(res.data.historyId) > BigInt(maxHistoryId)) {
              maxHistoryId = res.data.historyId;
            }
          } catch {
            // ignore
          }
        }
      } while (pageToken);

      // IDs that were both added and deleted in the same window are net-deleted.
      for (const id of deletedIds) newMessageIds.delete(id);

      const newMessages = await mapConcurrent([...newMessageIds], 10, async (id) => {
        const res = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "full",
        });
        return normalizeMessage(res.data, this.accountId);
      });

      return {
        newMessages,
        changedMessages: [...changed.values()],
        deletedIds: [...deletedIds],
        nextCursor: maxHistoryId,
      };
    } catch (e) {
      throw mapError(e);
    }
  }
}
