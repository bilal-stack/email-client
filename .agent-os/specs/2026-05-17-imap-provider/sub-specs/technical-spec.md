# Technical Spec — IMAP Provider

## SDK choice
`imapflow` for read / sync / flag operations, `nodemailer` for SMTP send. Both locked by `tech-stack.md`. `mailparser` (a `nodemailer` companion) parses raw MIME for body extraction; it's already pulled in transitively by nodemailer.

```ts
import { ImapFlow } from "imapflow";
import { createTransport } from "nodemailer";
import { simpleParser } from "mailparser";
```

## `MailboxSecret` discriminated union

```ts
// lib/providers/auth.ts
export type MailboxSecret = OAuthMailboxSecret | ImapMailboxSecret;

export interface OAuthMailboxSecret {
  kind: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

export interface ImapMailboxSecret {
  kind: "imap";
  password: string;
  imapHost: string;
  imapPort?: number;       // defaults to 993
  smtpHost: string;
  smtpPort?: number;       // defaults to 465
}
```

Backward compat in `getMailboxSecret` after `JSON.parse`:

```ts
const raw = JSON.parse(plaintext) as Partial<MailboxSecret> & Record<string, unknown>;
const secret: MailboxSecret =
  "kind" in raw && raw.kind
    ? (raw as MailboxSecret)
    : ({ kind: "oauth", ...raw } as OAuthMailboxSecret);
```

The OAuth switch arms continue to work on `secret` after narrowing. The `case "imap":` returns `secret` directly — no refresh.

## Credentials `authorize`

```ts
import { z } from "zod";
import { ImapFlow } from "imapflow";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
import { assertHostAllowed } from "@/lib/auth/imap-host-guard";

const ImapCredentialsSchema = z.object({
  emailAddress: z.string().email(),
  password: z.string().min(1).max(1024),
  imapHost: z.string().min(1).max(253),
  smtpHost: z.string().min(1).max(253),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
});

Credentials({
  id: "imap",
  name: "IMAP",
  credentials: { /* the existing form fields */ },
  async authorize(raw) {
    const parsed = ImapCredentialsSchema.safeParse(raw);
    if (!parsed.success) return null;
    const c = parsed.data;
    try {
      await assertHostAllowed(c.imapHost, c.imapPort);
      await assertHostAllowed(c.smtpHost, c.smtpPort);
    } catch (e) {
      console.warn("[auth.imap] host rejected", { name: (e as Error)?.name });
      return null;
    }
    const client = new ImapFlow({
      host: c.imapHost,
      port: c.imapPort,
      secure: true,
      auth: { user: c.emailAddress, pass: c.password },
      logger: false,
    });
    try {
      await client.connect();
      await client.noop();
      await client.logout();
    } catch (e) {
      console.warn("[auth.imap] connection rejected", { name: (e as Error)?.name });
      return null;
    }
    const existing = await prisma.user.findUnique({ where: { email: c.emailAddress } });
    const user = existing ?? (await prisma.user.create({ data: { email: c.emailAddress } }));
    const blob = JSON.stringify({
      kind: "imap",
      password: c.password,
      imapHost: c.imapHost,
      imapPort: c.imapPort,
      smtpHost: c.smtpHost,
      smtpPort: c.smtpPort,
    } satisfies ImapMailboxSecret);
    const sealed = encrypt(blob);
    await prisma.mailAccount.upsert({
      where: {
        userId_provider_emailAddress: {
          userId: user.id,
          provider: "imap",
          emailAddress: c.emailAddress,
        },
      },
      create: {
        userId: user.id,
        provider: "imap",
        emailAddress: c.emailAddress,
        encryptedSecret: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
      },
      update: {
        encryptedSecret: sealed.ciphertext,
        secretIv: sealed.iv,
        secretTag: sealed.tag,
      },
    });
    return { id: user.id, email: c.emailAddress };
  },
}),
```

Notes:
- The IMAP+SMTP connection check is the gating step — wrong credentials, bad host, or no-TLS server all fail here without leaking detail.
- The User row is created on demand. Matches the OAuth signin-callback's pattern (`handleSignIn` does the same thing).
- The MailAccount upsert uses the existing `(userId, provider, emailAddress)` unique key from `schema.prisma`.

## IMAP host SSRF guard

```ts
// lib/auth/imap-host-guard.ts
import { promises as dns } from "node:dns";
import net from "node:net";

const PROD = process.env.NODE_ENV === "production";
const ALLOW_DEV_LOOPBACK = !PROD;

const PRIVATE_V4 = [
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^127\./,
];

function isPrivateV4(ip: string): boolean {
  return PRIVATE_V4.some((re) => re.test(ip));
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (lower.startsWith("fe80:")) return true; // link-local
  return false;
}

export async function assertHostAllowed(host: string, port: number): Promise<void> {
  if (!host || host.length > 253) throw new Error("IMAP host not allowed");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("IMAP host not allowed");

  // Literal IP path
  if (net.isIP(host)) {
    if (ALLOW_DEV_LOOPBACK && (host === "127.0.0.1" || host === "::1")) return;
    if (net.isIPv4(host) && isPrivateV4(host))
      throw new Error("IMAP host not allowed", { cause: "private v4 literal" });
    if (net.isIPv6(host) && isPrivateV6(host))
      throw new Error("IMAP host not allowed", { cause: "private v6 literal" });
    return;
  }

  if (ALLOW_DEV_LOOPBACK && host === "localhost") return;

  // Hostname — resolve and check every record
  let addrs: dns.LookupAddress[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error("IMAP host not allowed", { cause: e });
  }
  for (const a of addrs) {
    if (a.family === 4 && isPrivateV4(a.address))
      throw new Error("IMAP host not allowed", { cause: `resolves to ${a.address}` });
    if (a.family === 6 && isPrivateV6(a.address))
      throw new Error("IMAP host not allowed", { cause: `resolves to ${a.address}` });
  }
}
```

Defense-in-depth: `ImapProvider`'s connect path also calls `assertHostAllowed` before opening the socket, in case the stored host is tampered with after sign-in. Same call, same rules.

## IMAP error mapping (additions to `error-mapping.ts`)

```ts
interface ImapflowLikeError {
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseStatus?: "NO" | "BAD" | "OK" | "BYE" | "PREAUTH";
  response?: string; // raw response text from the server
  code?: string;     // node net codes: ECONNREFUSED, EHOSTUNREACH, ETIMEDOUT, ETLS
  message?: string;
}

// Add to the top of mapError, before the gaxios/Graph paths:
if (looksLikeImapflowError(e)) {
  const ie = e as ImapflowLikeError;
  if (
    ie.authenticationFailed === true ||
    (ie.responseStatus === "NO" && /auth(entication)?|credentials|invalid/i.test(ie.response ?? ""))
  ) {
    return new AuthError("Invalid IMAP credentials — please re-check your app-password", { cause });
  }
  if (ie.responseStatus === "BAD") {
    return new UnknownProviderError("IMAP protocol error", { cause });
  }
  if (typeof ie.code === "string" && /ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ENETUNREACH|ETLS/.test(ie.code)) {
    return new TransientError("IMAP connection failed", { cause });
  }
}
```

`looksLikeImapflowError(e)` returns `true` for any error object with a `responseStatus` or `authenticationFailed` property — heuristic, but the property name is distinctive enough to avoid collisions with Gmail/Graph error shapes.

## Adapter skeleton

```ts
// lib/providers/imap.ts
export class ImapProvider implements IEmailProvider {
  constructor(private readonly accountId: string) {}

  private async openClient(): Promise<{ client: ImapFlow; secret: ImapMailboxSecret }> {
    const secret = await getMailboxSecret(this.accountId);
    if (secret.kind !== "imap") throw new Error("Expected IMAP secret on an IMAP account");
    await assertHostAllowed(secret.imapHost, secret.imapPort ?? 993);
    const client = new ImapFlow({
      host: secret.imapHost,
      port: secret.imapPort ?? 993,
      secure: true,
      auth: { user: /* email */ "", pass: secret.password },
      logger: false,
    });
    await client.connect();
    return { client, secret };
  }

  async listThreads(opts: ListThreadsOptions): Promise<ListResult<CanonicalThread>> {
    const { client } = await this.openClient();
    try {
      // … see "Sync via UID range" + thread grouping in sub-specs/technical-spec.md
    } catch (e) {
      throw mapError(e);
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  }
  // … etc for each method
}
```

The `openClient` helper centralizes the auth narrowing + SSRF re-check + connection. Every method's `finally` block logs out the client (best-effort — a failed logout doesn't change the user-visible outcome).

## Folder discovery

```ts
const FOLDER_FALLBACKS = {
  sent: ["Sent", "Sent Items", "Sent Mail"],
  trash: ["Trash", "Deleted", "Deleted Items"],
  drafts: ["Drafts", "Draft"],
  archive: ["Archive", "Archives", "All Mail"],
};

async function resolveSpecialFolders(client: ImapFlow): Promise<Record<string, string>> {
  const tree = await client.listTree();
  const folders: Record<string, string> = {};
  for (const node of walk(tree)) {
    if (node.specialUse === "\\Sent") folders.sent = node.path;
    if (node.specialUse === "\\Trash") folders.trash = node.path;
    if (node.specialUse === "\\Drafts") folders.drafts = node.path;
    if (node.specialUse === "\\Archive") folders.archive = node.path;
  }
  for (const [key, names] of Object.entries(FOLDER_FALLBACKS)) {
    if (folders[key]) continue;
    for (const candidate of names) {
      if (existsInTree(tree, candidate)) {
        folders[key] = candidate;
        break;
      }
    }
  }
  return folders;
}
```

Yahoo and AOL both advertise `\Sent`, `\Trash`, `\Drafts`. Yahoo advertises `\Archive`. AOL doesn't; the fallback to literal `"Archive"` handles it.

## Threading reconstruction

```ts
async function resolveThreadId(
  messageId: string,
  inReplyTo: string | null,
  references: string[],
  accountId: string,
  tx: Prisma.TransactionClient,
): Promise<string> {
  const refIds = [...(inReplyTo ? [inReplyTo] : []), ...references];
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
```

Called by the sync writer inside `writeDelta` for each new message. The writer already runs inside a transaction; passing the `tx` keeps the lookup consistent.

`providerMessageId` for IMAP = the RFC 5322 `Message-ID` header value with brackets stripped. This is also what the `In-Reply-To` / `References` headers point to, so the lookup is a direct equality match.

## Method ↔ IMAP/SMTP operations

| Method | IMAP/SMTP op | Notes |
|---|---|---|
| `listThreads(opts)` | `mailboxOpen("INBOX")` + `fetch(<uid range>, { envelope, source, flags, internalDate, bodyStructure })` | UID range derived from `opts.cursor`. Group by reconstructed `threadId`. |
| `getThread(id)` | `fetch` the seed message by Message-ID, then walk header chain via per-message `fetch` calls | Cap at 50 messages defensive against loops. |
| `sendMessage(draft)` | `nodemailer` SMTP transport → `sendMail` + APPEND to Sent folder | Returns `{ id: <Message-ID hash>, threadId }`. |
| `reply(threadId, draft)` | Same as `sendMessage` but pre-populates `In-Reply-To` / `References` | Caller passes those in `draft`. |
| `archive(ids)` | `messageMove(uids, archiveFolder, { uid: true })` | Folder resolved via SPECIAL-USE / fallback. |
| `trash(ids)` | `messageMove(uids, trashFolder, { uid: true })` | Same. |
| `markRead(ids, read)` | `messageFlagsAdd(uids, ["\\Seen"], { uid: true })` or `messageFlagsRemove` | Toggles `\Seen`. |
| `setLabels(ids, add, remove)` | System-label translation only | User labels silently dropped. Mapping table in tasks.md. |
| `search(query, opts)` | `search({ from, subject, body, all })` parsed from query | Operator parsing: `from:foo` → `{ from: "foo" }`, otherwise `{ body: query }`. |
| `syncDelta(cursor)` | `mailboxOpen` + UID-range `fetch` | UIDVALIDITY mismatch → AuthError. |

UIDs are passed with `{ uid: true }` on every imapflow call to avoid the sequence-number footgun.

## Adapter ↔ DB ids

IMAP `Message.providerMessageId` = RFC 5322 Message-ID (brackets stripped). IMAP `Thread.providerThreadId` = the same Message-ID for thread roots, inherited for replies.

The IMAP UID itself is NOT stored in any visible column — it's an implementation detail of the sync cursor. (A future spec that adds CONDSTORE / QRESYNC may persist UIDs to enable cheap delta-by-modseq; out of scope here.)

## Env vars
No new env vars. `imapHost` / `smtpHost` / `password` live encrypted in the existing `MailAccount` row.

## Out of scope (recap)
IMAP IDLE, initial full-mailbox seed, user-label round-trip, CONDSTORE/QRESYNC, multi-folder sync (only Inbox is polled), bounce / DSN handling.
