# Technical Spec — Compose, Reply, Forward

## TipTap setup

Editor mounts inside `app/inbox/_components/composer/tiptap-editor.tsx` (`"use client"`). The extension list is **deliberately small** — no image extension, no syntax highlighting, no tables — so the outbound HTML is predictable.

```ts
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";

const editor = useEditor({
  extensions: [
    StarterKit,
    Link.configure({ openOnClick: false, autolink: true, linkOnPaste: true }),
    Placeholder.configure({ placeholder: "Write your message…" }),
  ],
  content: initialContent,
  // ProseMirror hydrates lazily — see risk #5 in spec.md
  immediatelyRender: false,
  onUpdate: ({ editor }) => onUpdate(editor.getHTML()),
});
```

New deps the `ui-builder` adds via `npm install`:

```
@tiptap/react
@tiptap/starter-kit
@tiptap/extension-link
@tiptap/extension-placeholder
```

## Composer component shape

```ts
// app/inbox/_components/composer/composer.tsx
"use client";

export type DraftMode = "new" | "reply" | "reply-all" | "forward";

interface AccountOption {
  id: string;
  emailAddress: string;
  displayName: string | null;
}

interface ParentMessageContext {
  providerMessageId: string;
  providerThreadId: string;
  inReplyTo: string[];      // built by buildReplyHeaders
  references: string[];     // built by buildReplyHeaders
  forwardQuote?: string;    // built by buildForwardQuote (forward mode only)
  prefilledTo?: string;
  prefilledCc?: string;
  prefilledSubject: string;
}

interface InitialDraft {
  id: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyHtml: string;
}

interface ComposerProps {
  mode: DraftMode;
  accountId: string;
  accountOptions: AccountOption[];
  threadId?: string;
  parentMessage?: ParentMessageContext;
  initialDraft: InitialDraft | null;
}
```

The composer owns local state for `to`, `cc`, `bcc`, `subject`, `bodyHtml`, `attachments` (`File[]`), `draftId`, and `saveStatus`. Initial state hydrates from `initialDraft` when present, otherwise from `parentMessage` prefills, otherwise empty.

## Server Action signatures

All in `app/inbox/compose/actions.ts`. Each starts with `"use server"`.

```ts
import { z } from "zod";

const addressSchema = z.object({ name: z.string().optional(), email: z.string().email() });
const draftModeSchema = z.enum(["new", "reply", "reply-all", "forward"]);

// upsertDraft — autosave path, plain JSON
const upsertDraftInput = z.object({
  draftId: z.string().cuid().optional(),
  accountId: z.string().cuid(),
  threadId: z.string().cuid().nullable(),
  mode: draftModeSchema,
  to: z.array(addressSchema),
  cc: z.array(addressSchema),
  bcc: z.array(addressSchema),
  subject: z.string().max(998),     // RFC 5322 line-length-ish
  bodyHtml: z.string().max(2_000_000),  // 2 MB sanity cap
  inReplyTo: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
});
export async function upsertDraft(
  input: z.infer<typeof upsertDraftInput>,
): Promise<{ ok: true; data: { draftId: string; updatedAt: Date } } | { ok: false; error: string }>;

// discardDraft — delete by id
const discardDraftInput = z.object({ draftId: z.string().cuid() });
export async function discardDraft(
  input: z.infer<typeof discardDraftInput>,
): Promise<{ ok: true } | { ok: false; error: string }>;

// getDraft — load by slot
const getDraftInput = z.object({
  threadId: z.string().cuid().nullable(),
  mode: draftModeSchema,
});
export async function getDraft(
  input: z.infer<typeof getDraftInput>,
): Promise<{ ok: true; data: DraftDTO | null } | { ok: false; error: string }>;

// sendDraft — FormData (attachments ride along as File[])
//   - hidden inputs carry JSON-encoded strings for the structured fields
//   - <input type="file" name="attachments" multiple /> carries the bytes
export async function sendDraft(
  formData: FormData,
): Promise<
  | { ok: true; data: { providerMessageId: string; providerThreadId: string } }
  | { ok: false; error: string }
>;
```

`DraftDTO`:
```ts
interface DraftDTO {
  id: string;
  accountId: string;
  threadId: string | null;
  mode: DraftMode;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  bcc: CanonicalAddress[];
  subject: string;
  bodyHtml: string;
  inReplyTo: string[];
  references: string[];
  updatedAt: Date;
}
```

## `sendDraft` execution order

1. `session = await auth()` → reject `Unauthorized` if no `user.id`.
2. Parse `formData`:
   - Structured fields are JSON-string values (`formData.get("to") as string`); JSON.parse + Zod-validate against an internal `sendDraftFormSchema`.
   - `attachments` is `formData.getAll("attachments") as File[]`.
3. Run `sanitizeEmailHtml(bodyHtml)` (defense-in-depth on TipTap output).
4. Run `validateAttachments(files)` → `{ ok: false }` short-circuits.
5. Look up `MailAccount` by `accountId` `WHERE userId = session.user.id`. Reject if not owned.
6. If `threadId` present, look up `Thread` ownership AND `providerThreadId` for the reply path. Reject if not owned.
7. Build the `SendDraft`:
   ```ts
   const draft: SendDraft = {
     to, cc, bcc, subject,
     bodyHtml: sanitizedHtml,
     inReplyTo: parsed.inReplyTo?.[parsed.inReplyTo.length - 1],  // single id per IEmailProvider contract
     references: parsed.references,
     attachments,
   };
   ```
8. Resolve the provider via `getProviderForAccount(accountId)`.
9. Dispatch:
   - `mode === "new"` → `provider.sendMessage(draft)`
   - else → `provider.reply(thread.providerThreadId, draft)`
10. On resolve: `deleteDraftForUser(userId, draftId)` if `draftId` was passed; return `{ ok: true, data: { providerMessageId, providerThreadId } }`.
11. On throw: `e instanceof ProviderError` → return its `e.message` (already canonicalized); otherwise return a generic `"Failed to send. Try again."`. **Draft row is NOT deleted on send failure** — preserves the user's work.

## Reply header builder (`lib/compose/headers.ts`)

```ts
import type { CanonicalAddress } from "@/lib/providers/types";

export interface ParentForHeaders {
  providerMessageId: string;
  inReplyTo: string | null;
  references: string[];
}

export function buildReplyHeaders(
  parent: ParentForHeaders,
): { inReplyTo: string; references: string[] } {
  // RFC 5322 §3.6.4: References = parent's References + parent's Message-ID.
  // If parent had no References, fall back to its In-Reply-To then its own Message-ID.
  const prior =
    parent.references.length > 0
      ? parent.references
      : parent.inReplyTo
        ? [parent.inReplyTo]
        : [];
  return {
    inReplyTo: parent.providerMessageId,
    references: [...prior, parent.providerMessageId],
  };
}

const RE_PREFIX = /^\s*re\s*:\s*/i;
const FWD_PREFIX = /^\s*(fwd?|forward)\s*:\s*/i;

export function prefixReplySubject(subject: string): string {
  const cleaned = subject.replace(RE_PREFIX, "").trim();
  return cleaned.length > 0 ? `Re: ${cleaned}` : "Re:";
}

export function prefixForwardSubject(subject: string): string {
  const cleaned = subject.replace(FWD_PREFIX, "").trim();
  return cleaned.length > 0 ? `Fwd: ${cleaned}` : "Fwd:";
}

export interface ParentForForward {
  from: CanonicalAddress;
  receivedAt: Date;
  subject: string;
  to: CanonicalAddress[];
  bodyHtml: string | null;
  bodyText: string | null;
}

export function buildForwardQuote(parent: ParentForForward): string {
  const fromLabel = parent.from.name
    ? `${escapeHtml(parent.from.name)} &lt;${escapeHtml(parent.from.email)}&gt;`
    : escapeHtml(parent.from.email);
  const toLabel = parent.to
    .map((a) => (a.name ? `${escapeHtml(a.name)} &lt;${escapeHtml(a.email)}&gt;` : escapeHtml(a.email)))
    .join(", ");
  const date = parent.receivedAt.toUTCString();
  const subject = escapeHtml(parent.subject || "(no subject)");
  const body = parent.bodyHtml ?? `<pre>${escapeHtml(parent.bodyText ?? "")}</pre>`;

  return [
    `<br><br>`,
    `<div style="border-left:2px solid #999;padding-left:1em;margin-top:1em;">`,
    `<p style="margin:0 0 .5em 0;font-size:.875em;color:#555;">`,
    `---------- Forwarded message ----------<br>`,
    `<strong>From:</strong> ${fromLabel}<br>`,
    `<strong>Date:</strong> ${date}<br>`,
    `<strong>Subject:</strong> ${subject}<br>`,
    `<strong>To:</strong> ${toLabel}`,
    `</p>`,
    body,
    `</div>`,
  ].join("");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
```

## Reply-all address filtering

In the reply-all page loader:

```ts
const ownAddress = thread.account.emailAddress.toLowerCase();
const allRecipients = [parent.from, ...parent.to];
const cc = parent.cc;

const filteredTo = dedupeByEmail(allRecipients).filter(
  (a) => a.email.toLowerCase() !== ownAddress,
);
const filteredCc = dedupeByEmail(cc).filter(
  (a) => a.email.toLowerCase() !== ownAddress,
);
```

`dedupeByEmail` keeps the first occurrence of each email (case-insensitive). The user's own address is filtered from both lists — they don't need to reply to themselves.

## Upload guard (`lib/compose/upload-guard.ts`)

```ts
import type { SendAttachment } from "@/lib/providers/types";

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;  // 25 MB — matches Gmail's send cap
const MAX_FILE_COUNT = 20;

const MIME_DENY = new Set([
  // Executables
  "application/x-msdownload",       // .exe / .dll
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-mach-binary",
  "application/vnd.microsoft.portable-executable",
  // Scripts
  "application/x-sh",
  "application/x-csh",
  "application/x-bat",
  "application/x-msi",
  "application/x-ms-installer",
  "application/javascript",          // strip outbound JS payloads
  "text/javascript",
  // Archives commonly used to bypass simple denylists — keep `.zip` allowed
  // since legitimate use is common, but block known-script-bearing variants:
  "application/x-msdos-windows",
]);

// File extensions to deny regardless of MIME (some browsers lie about MIME)
const EXT_DENY = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".pif",
  ".js", ".jse", ".vbs", ".vbe", ".wsf", ".wsh",
  ".msi", ".msp", ".ps1", ".sh",
]);

export async function validateAttachments(
  files: File[],
): Promise<{ ok: true; attachments: SendAttachment[] } | { ok: false; error: string }> {
  if (files.length === 0) return { ok: true, attachments: [] };
  if (files.length > MAX_FILE_COUNT) {
    return { ok: false, error: `Too many attachments (max ${MAX_FILE_COUNT}).` };
  }

  let total = 0;
  const out: SendAttachment[] = [];
  for (const f of files) {
    if (MIME_DENY.has(f.type)) {
      return { ok: false, error: `Attachment "${f.name}" has a blocked file type.` };
    }
    const ext = f.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (EXT_DENY.has(ext)) {
      return { ok: false, error: `Attachment "${f.name}" has a blocked extension.` };
    }
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return {
        ok: false,
        error: `Total attachment size exceeds 25 MB (Gmail's send limit).`,
      };
    }
    const buf = Buffer.from(await f.arrayBuffer());
    out.push({
      filename: f.name,
      mimeType: f.type || "application/octet-stream",
      content: buf,
    });
  }
  return { ok: true, attachments: out };
}
```

## Draft DB helpers (`lib/compose/draft-queries.ts`)

```ts
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export interface DraftSlot {
  threadId: string | null;
  mode: "new" | "reply" | "reply-all" | "forward";
}

export async function getDraftForUser(userId: string, slot: DraftSlot) {
  return prisma.draft.findUnique({
    where: { userId_threadId_mode: { userId, threadId: slot.threadId, mode: slot.mode } },
  });
}

export async function getDraftByIdForUser(userId: string, id: string) {
  return prisma.draft.findFirst({ where: { id, userId } });
}

export interface UpsertDraftInput {
  draftId?: string;
  accountId: string;
  threadId: string | null;
  mode: DraftSlot["mode"];
  to: unknown;        // CanonicalAddress[] — Json
  cc: unknown;
  bcc: unknown;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string[];
  references?: string[];
}

export async function upsertDraftForUser(userId: string, input: UpsertDraftInput) {
  return prisma.draft.upsert({
    where: { userId_threadId_mode: { userId, threadId: input.threadId, mode: input.mode } },
    create: {
      userId,
      accountId: input.accountId,
      threadId: input.threadId,
      mode: input.mode,
      to: input.to as Prisma.InputJsonValue,
      cc: input.cc as Prisma.InputJsonValue,
      bcc: input.bcc as Prisma.InputJsonValue,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      inReplyTo: (input.inReplyTo ?? []) as unknown as Prisma.InputJsonValue,
      references: (input.references ?? []) as unknown as Prisma.InputJsonValue,
    },
    update: {
      accountId: input.accountId,
      to: input.to as Prisma.InputJsonValue,
      cc: input.cc as Prisma.InputJsonValue,
      bcc: input.bcc as Prisma.InputJsonValue,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      inReplyTo: (input.inReplyTo ?? []) as unknown as Prisma.InputJsonValue,
      references: (input.references ?? []) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function deleteDraftForUser(userId: string, id: string) {
  // Filter by id AND userId — never delete someone else's draft.
  return prisma.draft.deleteMany({ where: { id, userId } });
}
```

## Composer auto-save loop

```tsx
// Inside composer.tsx
const [saveStatus, setSaveStatus] = useState<"idle"|"saving"|"saved"|"error">("idle");
const lastInputAtRef = useRef<number>(0);
const inFlightRef = useRef<boolean>(false);

useEffect(() => {
  lastInputAtRef.current = Date.now();
  const t = setTimeout(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaveStatus("saving");
    const result = await upsertDraft({
      draftId, accountId, threadId, mode,
      to: parsed.to, cc: parsed.cc, bcc: parsed.bcc,
      subject, bodyHtml, inReplyTo, references,
    });
    inFlightRef.current = false;
    if (result.ok) {
      setDraftId(result.data.draftId);
      setSaveStatus("saved");
    } else {
      setSaveStatus("error");
    }
  }, 2000);
  return () => clearTimeout(t);
}, [to, cc, bcc, subject, bodyHtml, /* attachments are NOT autosaved */]);
```

Notes:
- **Attachments are NOT autosaved.** They live in browser memory until Send. Re-attach if the tab is closed before send. (Documented in spec.md non-goals if surfaces.)
- The dependency array deliberately excludes `attachments` so the timer doesn't reset for file selection.
- `saveStatus === "error"` surfaces a small inline message but does not block send.

## Defense-in-depth outbound HTML sanitization

In `sendDraft`:

```ts
import { sanitizeEmailHtml } from "@/lib/email-html/sanitize";

const sanitizedHtml = await sanitizeEmailHtml(parsed.bodyHtml);
```

The TipTap extension set we lock cannot emit `<script>` or `on*` attributes, but a future TipTap upgrade could silently broaden the output. Running `sanitizeEmailHtml` once on the way out keeps the outbound surface aligned with the inbound rendering pipeline (which we already trust). The runtime cost is small — sanitize-html on a typical email body is < 10 ms.

## Provider-agnostic guarantee — enforced by structure

- `app/inbox/compose/**` — imports only from `@/lib/compose/*`, `@/lib/providers/types`, `@/lib/auth`, and shadcn UI. **Never** imports `googleapis`, `@microsoft/microsoft-graph-client`, or `imapflow`.
- `app/inbox/[threadId]/(reply|reply-all|forward)/**` — same scope.
- The Server Action selects a provider via `getProviderForAccount(accountId)` which returns `IEmailProvider`; no branching on `provider === "gmail"`.
- The `security-reviewer` agent grep-checks for `import.*googleapis`, `import.*microsoft-graph`, `import.*imapflow` in the compose tree and rejects on hits.
