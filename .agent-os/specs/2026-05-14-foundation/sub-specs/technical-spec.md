# Technical Spec — Foundation

## Encryption util (`lib/auth/crypto.ts`)
```ts
import { createCipheriv, createDecipheriv, createSecretKey, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM standard

function key() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) throw new Error("ENCRYPTION_KEY must be 32 bytes hex");
  return createSecretKey(Buffer.from(hex, "hex"));
}

export function encrypt(plain: string) {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

export function decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```
- Throws on auth-tag mismatch (built-in to GCM).
- Different IVs produce different ciphertext for the same plaintext.

## Provider interface (`lib/providers/types.ts`)
```ts
export type ThreadId = string;
export type MessageId = string;

export interface CanonicalAddress { name?: string; email: string }

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
  attachments: Array<{ id: string; filename: string; mimeType: string; size: number }>;
}

export interface CanonicalThread {
  id: ThreadId;
  accountId: string;
  subject: string;
  participants: CanonicalAddress[];
  lastMessageAt: Date;
  unreadCount: number;
  labels: string[];
  messageIds: MessageId[]; // ordered oldest → newest
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
  attachments?: Array<{ filename: string; mimeType: string; content: Buffer }>;
}

export interface ListResult<T> { items: T[]; nextCursor: string | null }
export interface DeltaResult {
  newMessages: CanonicalMessage[];
  changedMessages: Array<{ id: MessageId; isUnread?: boolean; labels?: string[] }>;
  deletedIds: MessageId[];
  nextCursor: string;
}

export interface IEmailProvider {
  listThreads(opts: { cursor?: string; limit?: number; label?: string }): Promise<ListResult<CanonicalThread>>;
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

export class NotImplementedError extends Error { constructor(method: string) { super(`Not implemented: ${method}`); } }

export class NotImplementedProvider implements IEmailProvider {
  listThreads() { throw new NotImplementedError("listThreads"); return null as never; }
  // ... (all methods throw)
}
```

## Auth.js config (`lib/auth/index.ts`)
- Providers: `Google` (scopes: `openid email profile https://www.googleapis.com/auth/gmail.modify`), `AzureAD` (scopes: `openid email profile offline_access Mail.ReadWrite Mail.Send User.Read`), `Credentials` (stub returning null).
- Adapter: `PrismaAdapter(prisma)`.
- Session strategy: `database`.
- `signIn` callback: when a Google/Azure account is linked, look up the OAuth tokens on the `Account` row Auth.js just wrote, then upsert a `MailAccount` row with encrypted `accessToken` / `refreshToken` / `expiresAt`.
- `session` callback: attach `userId` to the returned session.

## Inngest setup
- `lib/inngest/client.ts`:
  ```ts
  import { Inngest } from "inngest";
  export const inngest = new Inngest({ id: "email-client" });
  ```
- `app/api/inngest/route.ts`:
  ```ts
  import { serve } from "inngest/next";
  import { inngest } from "@/lib/inngest/client";
  export const { GET, POST, PUT } = serve({ client: inngest, functions: [] });
  ```
- Dev script: `inngest:dev` runs `npx inngest-cli@latest dev -u http://localhost:3000/api/inngest`.

## Middleware (`middleware.ts`)
```ts
export { auth as middleware } from "@/lib/auth";
export const config = { matcher: ["/(mail)/:path*"] };
```
Auth.js v5 ships a middleware export that handles redirect-to-signin for unauthenticated requests.

## Environment variables
See `CLAUDE.md` for the full template. No Upstash variables (decided 2026-05-14).
