// Canonical shapes the rest of the app consumes. Every IEmailProvider adapter
// normalizes provider-specific responses into these types. UI and AI code
// never branches on provider — it talks to this interface only.

export type ThreadId = string;
export type MessageId = string;

export interface CanonicalAddress {
  name?: string;
  email: string;
}

export interface CanonicalAttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface CanonicalMessage {
  id: MessageId;
  threadId: ThreadId;
  accountId: string;
  from: CanonicalAddress;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  bcc: CanonicalAddress[];
  subject: string;
  snippet: string;
  bodyHtml: string | null;
  bodyText: string | null;
  receivedAt: Date;
  isUnread: boolean;
  labels: string[];
  inReplyTo: MessageId | null;
  references: MessageId[];
  attachments: CanonicalAttachmentMeta[];
}

export interface CanonicalThread {
  id: ThreadId;
  accountId: string;
  subject: string;
  participants: CanonicalAddress[];
  lastMessageAt: Date;
  unreadCount: number;
  labels: string[];
  messageIds: MessageId[];
}

export interface SendAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

export interface SendDraft {
  to: CanonicalAddress[];
  cc?: CanonicalAddress[];
  bcc?: CanonicalAddress[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  inReplyTo?: MessageId;
  references?: MessageId[];
  attachments?: SendAttachment[];
}

export interface ListResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MessageChange {
  id: MessageId;
  isUnread?: boolean;
  labels?: string[];
}

export interface DeltaResult {
  newMessages: CanonicalMessage[];
  changedMessages: MessageChange[];
  deletedIds: MessageId[];
  nextCursor: string;
}

export interface ListThreadsOptions {
  cursor?: string;
  limit?: number;
  label?: string;
}

export interface IEmailProvider {
  listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>>;
  getThread(id: ThreadId): Promise<CanonicalThread>;
  sendMessage(draft: SendDraft): Promise<{ id: MessageId; threadId: ThreadId }>;
  reply(threadId: ThreadId, draft: SendDraft): Promise<{ id: MessageId }>;
  archive(ids: MessageId[]): Promise<void>;
  trash(ids: MessageId[]): Promise<void>;
  markRead(ids: MessageId[], read: boolean): Promise<void>;
  setLabels(ids: MessageId[], add: string[], remove: string[]): Promise<void>;
  search(query: string, opts?: { limit?: number }): Promise<ListResult<CanonicalThread>>;
  syncDelta(cursor: string | null): Promise<DeltaResult>;
}

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Not implemented: ${method}`);
    this.name = "NotImplementedError";
  }
}

export class NotImplementedProvider implements IEmailProvider {
  listThreads(): Promise<ListResult<CanonicalThread>> {
    throw new NotImplementedError("listThreads");
  }
  getThread(): Promise<CanonicalThread> {
    throw new NotImplementedError("getThread");
  }
  sendMessage(): Promise<{ id: MessageId; threadId: ThreadId }> {
    throw new NotImplementedError("sendMessage");
  }
  reply(): Promise<{ id: MessageId }> {
    throw new NotImplementedError("reply");
  }
  archive(): Promise<void> {
    throw new NotImplementedError("archive");
  }
  trash(): Promise<void> {
    throw new NotImplementedError("trash");
  }
  markRead(): Promise<void> {
    throw new NotImplementedError("markRead");
  }
  setLabels(): Promise<void> {
    throw new NotImplementedError("setLabels");
  }
  search(): Promise<ListResult<CanonicalThread>> {
    throw new NotImplementedError("search");
  }
  syncDelta(): Promise<DeltaResult> {
    throw new NotImplementedError("syncDelta");
  }
}
