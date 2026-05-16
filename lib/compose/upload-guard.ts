// Attachment validation. Enforces total-size cap, file-count cap, and a MIME
// + extension deny list. Browsers sometimes report a benign MIME for a script
// (e.g. `application/octet-stream` for `.bat`), so we also check the
// extension regardless of MIME. Returns `SendAttachment[]` ready for the
// canonical `SendDraft`.

import type { SendAttachment } from "@/lib/providers/types";

const MAX_TOTAL_BYTES = 25 * 1024 * 1024; // 25 MB — matches Gmail's send cap
const MAX_FILE_COUNT = 20;

const MIME_DENY = new Set([
  // Executables
  "application/x-msdownload",
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
  "application/javascript",
  "text/javascript",
  // Archives commonly used to bypass simple denylists — keep `.zip` allowed
  // since legitimate use is common, but block known-script-bearing variants:
  "application/x-msdos-windows",
]);

const EXT_DENY = new Set([
  ".exe",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".pif",
  ".js",
  ".jse",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".msi",
  ".msp",
  ".ps1",
  ".sh",
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
