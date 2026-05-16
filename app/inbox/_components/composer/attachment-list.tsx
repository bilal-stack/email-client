"use client";

import { Button } from "@/components/ui/button";
import { useRef, useState } from "react";

interface AttachmentListProps {
  attachments: File[];
  onChange: (next: File[]) => void;
}

const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
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

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Client-side validation for fast feedback only. The Server Action re-runs
 * the canonical guard from `lib/compose/upload-guard.ts`.
 */
function clientValidate(
  existing: File[],
  incoming: File[],
): { ok: true } | { ok: false; error: string } {
  const all = [...existing, ...incoming];
  if (all.length > 20) return { ok: false, error: "Too many attachments (max 20)." };
  let total = 0;
  for (const f of all) {
    const ext = f.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
    if (EXT_DENY.has(ext)) {
      return { ok: false, error: `Attachment "${f.name}" has a blocked extension.` };
    }
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return { ok: false, error: "Total attachment size exceeds 25 MB." };
    }
  }
  return { ok: true };
}

export function AttachmentList({ attachments, onChange }: AttachmentListProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const incoming = Array.from(list);
    const check = clientValidate(attachments, incoming);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setError(null);
    onChange([...attachments, ...incoming]);
  }

  function removeAt(i: number) {
    const next = attachments.filter((_, idx) => idx !== i);
    onChange(next);
    setError(null);
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Attachments
        </span>
        <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          Add files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(e) => {
            onFiles(e.target.files);
            // Reset so selecting the same file again still fires onChange.
            e.target.value = "";
          }}
        />
      </div>
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((f, i) => (
            <li
              key={`${f.name}-${i}-${f.lastModified}`}
              className="inline-flex items-center gap-2 rounded-full border border-zinc-300 bg-white px-3 py-1 text-xs text-zinc-700"
            >
              <span className="max-w-[200px] truncate" title={f.name}>
                {f.name}
              </span>
              <span className="text-zinc-500">{formatBytes(f.size)}</span>
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100"
                aria-label={`Remove ${f.name}`}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-xs text-red-600">{error}</p> : null}
    </div>
  );
}
