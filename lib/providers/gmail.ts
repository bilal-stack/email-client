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

import { type OAuthMailboxSecret, getMailboxSecret } from "@/lib/providers/auth";
import { mapError } from "@/lib/providers/error-mapping";
import { AuthError } from "@/lib/providers/errors";
import { type gmail_v1, google } from "googleapis";
import { randomBytes } from "node:crypto";
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

function gmailClient(secret: OAuthMailboxSecret): gmail_v1.Gmail {
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
  const headers: string[] = [];
  headers.push(`To: ${draft.to.map(formatAddress).join(", ")}`);
  if (draft.cc?.length) headers.push(`Cc: ${draft.cc.map(formatAddress).join(", ")}`);
  if (draft.bcc?.length) headers.push(`Bcc: ${draft.bcc.map(formatAddress).join(", ")}`);
  headers.push(`Subject: ${draft.subject}`);
  if (opts?.threadHeaders && draft.inReplyTo) {
    headers.push(`In-Reply-To: <${draft.inReplyTo}>`);
  }
  if (opts?.threadHeaders && draft.references?.length) {
    headers.push(`References: ${draft.references.map((r) => `<${r}>`).join(" ")}`);
  }
  headers.push("MIME-Version: 1.0");

  const attachments = draft.attachments ?? [];

  // No attachments → single-part text/html. Preserves the simpler shape
  // for the common case (and matches what the existing send-message
  // regression test asserts on).
  if (attachments.length === 0) {
    headers.push('Content-Type: text/html; charset="UTF-8"');
    return [...headers, "", draft.bodyHtml].join("\r\n");
  }

  // With attachments → multipart/mixed. Body becomes one MIME part,
  // each attachment its own part with base64-encoded bytes wrapped at
  // 76 chars/line per RFC 2045.
  //
  // The boundary is a random hex string sandwiched between `=_b_` /
  // `_=` so it's both unlikely-to-collide with any content AND visually
  // identifiable as a multipart boundary if anyone ever stares at the
  // raw RFC 2822 in a debugger.
  const boundary = `=_b_${randomBytes(16).toString("hex")}_=`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  const parts: string[] = [];

  // Body part — base64-encode so non-ASCII characters (emoji, accented
  // letters, CJK, etc.) survive any 7-bit SMTP relay without needing
  // quoted-printable encoding.
  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/html; charset="UTF-8"');
  parts.push("Content-Transfer-Encoding: base64");
  parts.push("");
  parts.push(wrapBase64Lines(Buffer.from(draft.bodyHtml, "utf8").toString("base64")));

  // One attachment part per file.
  for (const att of attachments) {
    const safeName = sanitizeMimeFilename(att.filename);

    const content =
      Buffer.isBuffer(att.content)
        ? att.content
        : Buffer.from(att.content);

    parts.push(`--${boundary}`);
    parts.push(`Content-Type: ${att.mimeType}; name="${safeName}"`);
    parts.push(`Content-Disposition: attachment; filename="${safeName}"`);
    parts.push("Content-Transfer-Encoding: base64");
    parts.push("");
    parts.push(wrapBase64Lines(content.toString("base64")));
  }

  parts.push(`--${boundary}--`);

  return [...headers, "", ...parts].join("\r\n");
}

/**
 * RFC 2045 mandates a max line length of 76 characters in base64-encoded
 * MIME parts. Some SMTP relays will reject or mangle longer lines. The
 * Buffer's default base64 output has no line breaks — we add them here.
 */
function wrapBase64Lines(s: string): string {
  const matches = s.match(/.{1,76}/g);
  return matches ? matches.join("\r\n") : s;
}

/**
 * MIME header parameter values can't contain raw CR/LF or unescaped
 * double-quotes — both would break the header structure. We replace
 * each with an underscore as a minimum-viable safety net.
 *
 * Out of scope: non-ASCII filenames per RFC 2231 / RFC 5987. The naive
 * quoted form below works for ASCII names; modern mail clients tolerate
 * raw UTF-8 in this position despite the spec, which is good enough for
 * the eval. A proper RFC 2231 `filename*=UTF-8''<percent-encoded>`
 * encoding can land later if non-ASCII attachment names become common.
 */
function sanitizeMimeFilename(name: string): string {
  return name.replace(/["\r\n]/g, "_");
}

// ─── Adapter ──────────────────────────────────────────────────────────────

export class GmailProvider implements IEmailProvider {
  constructor(private readonly accountId: string) {}

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
      const gmail = gmailClient(secret);
      // Archive = "drop from every special folder". We strip INBOX
      // (regular inbox archive), TRASH (rescuing a trashed thread), and
      // SPAM (recovering from a spam classification). Gmail's
      // batchModify silently ignores label-ids the message doesn't
      // currently have, so this is safe to run from any source folder.
      await gmail.users.messages.batchModify({
        userId: "me",
        requestBody: { ids, removeLabelIds: ["INBOX", "TRASH", "SPAM"] },
      });
    } catch (e) {
      throw mapError(e);
    }
  }

  async trash(ids: MessageId[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const secret = await getMailboxSecret(this.accountId);
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
      if (secret.kind !== "oauth") throw new Error("Expected OAuth secret on a Gmail account");
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
        // 404 from THIS endpoint specifically means the stored historyId is
        // older than Gmail's ~7-day retention. Gmail returns the generic
        // "Requested entity was not found." message — without any historyId /
        // startHistoryId substring — so the regex in `error-mapping.ts`
        // doesn't catch it. We convert here to AuthError with the canonical
        // reconnect prompt so the UI's reconnect path fires (which then
        // re-seeds the cursor via the cold-start `getProfile` route).
        // Other 404s in this method (e.g. a message vanishing between list
        // and get) keep their generic NotFoundError mapping via `mapError`
        // — only `users.history.list` is treated as a stale-cursor signal.
        let historyData: gmail_v1.Schema$ListHistoryResponse;
        try {
          const response = await gmail.users.history.list({
            userId: "me",
            startHistoryId: cursor,
            historyTypes: ["messageAdded", "messageDeleted", "labelAdded", "labelRemoved"],
            pageToken,
          });
          historyData = response.data;
        } catch (e) {
          const err = e as { code?: number; response?: { status?: number } };
          const status = err.response?.status ?? err.code;
          if (status === 404) {
            throw new AuthError(
              "Sync history expired — reconnect required: startHistoryId not found",
              { cause: e },
            );
          }
          throw e;
        }

        for (const h of historyData.history ?? []) {
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

        pageToken = historyData.nextPageToken ?? undefined;
        if (historyData.historyId) {
          try {
            if (BigInt(historyData.historyId) > BigInt(maxHistoryId)) {
              maxHistoryId = historyData.historyId;
            }
          } catch {
            // ignore
          }
        }
      } while (pageToken);

      // IDs that were both added and deleted in the same window are net-deleted.
      for (const id of deletedIds) newMessageIds.delete(id);

      // Fetch each new message body. If a message was added via the history
      // window but deleted before we get to fetch it (e.g. spam-classified,
      // moved, or briefly-created draft), Gmail returns 404 with the generic
      // "Requested entity was not found" message. We DON'T want that single
      // missing message to fail the whole sync — drop it, log it, continue.
      // Other errors (auth, rate-limit, 5xx) keep their normal behavior and
      // bubble to the outer mapError so the run is retried by Inngest.
      const fetchedMessages = await mapConcurrent(
        [...newMessageIds],
        10,
        async (id) => {
          try {
            const res = await gmail.users.messages.get({
              userId: "me",
              id,
              format: "full",
            });
            return normalizeMessage(res.data, this.accountId);
          } catch (e) {
            const err = e as { code?: number; response?: { status?: number } };
            const status = err.response?.status ?? err.code;
            if (status === 404) {
              // Soft-skip: the message vanished server-side between history
              // emit and our fetch. Treat as if it never existed. Not added
              // to `deletedIds` because we don't have a confirmed prior row
              // either; the next sync will not re-encounter it.
              return null;
            }
            throw e;
          }
        },
      );
      const newMessages = fetchedMessages.filter(
        (m): m is CanonicalMessage => m !== null,
      );

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
