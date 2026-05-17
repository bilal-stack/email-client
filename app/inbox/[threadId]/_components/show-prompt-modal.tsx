"use client";

// "Show me the prompt" trust modal. Renders the exact system prompt, user
// payload, model name, and token usage that produced a stored AISummary row.
//
// IMPORTANT: this is a client component. It must never import
// `@anthropic-ai/sdk` or any module that does. Prompt lookup goes through
// `lib/ai/prompts/summary-registry` — a client-safe mirror that re-exports
// plain constants from `summary.ts` (zod-only, no SDK).
//
// `components/ui/` doesn't ship a Dialog primitive in this codebase, so we
// roll a small fixed-overlay modal with backdrop click + Escape + explicit
// close button. Tap targets honor the 44px floor.

import { Button } from "@/components/ui/button";
import { getSummaryPromptForVersion } from "@/lib/ai/prompts/summary-registry";
import { Check, Copy, X } from "lucide-react";
import { useEffect, useState } from "react";

interface ShowPromptModalProps {
  open: boolean;
  onClose: () => void;
  promptVersion: string;
  userMessageJson: string;
  model: string;
  usage: unknown;
  generatedAt: Date;
}

function formatGeneratedAt(d: Date): string {
  // Best effort — Date prop may arrive as a string after JSON round-trip via
  // a Server Action. Normalize first.
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "(unknown)";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function asUsageRecord(u: unknown): Record<string, number | undefined> {
  if (u && typeof u === "object") return u as Record<string, number | undefined>;
  return {};
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard can fail (permissions, http context). Silent — the user
          // can still select + copy manually.
        }
      }}
      className="inline-flex h-9 items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function ShowPromptModal({
  open,
  onClose,
  promptVersion,
  userMessageJson,
  model,
  usage,
  generatedAt,
}: ShowPromptModalProps) {
  // Escape to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Body scroll lock while the modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const entry = getSummaryPromptForVersion(promptVersion);
  const usageRec = asUsageRecord(usage);
  const userPayloadPretty = prettyJson(userMessageJson);
  const toolPretty = entry ? JSON.stringify(entry.tool, null, 2) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Summary prompt details"
    >
      <div
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop swallows clicks; Escape handled at window level.
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[95vh] w-full flex-col overflow-hidden rounded-t-xl bg-white shadow-xl sm:rounded-xl lg:max-w-2xl"
      >
        <header className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 sm:px-6">
          <h2 className="text-base font-semibold text-zinc-900">
            How this summary was generated
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-10 w-10 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4 sm:px-6">
          {/* 1. Model & timing */}
          <section>
            <h3 className="mb-2 text-sm font-semibold text-zinc-900">Model &amp; timing</h3>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-zinc-500">Model</dt>
              <dd className="font-mono text-zinc-900">{model}</dd>
              <dt className="text-zinc-500">Generated</dt>
              <dd className="text-zinc-900">{formatGeneratedAt(generatedAt)}</dd>
              <dt className="text-zinc-500">Prompt version</dt>
              <dd className="font-mono text-zinc-900">{promptVersion}</dd>
              <dt className="text-zinc-500">Input tokens</dt>
              <dd className="font-mono text-zinc-900">{usageRec.input_tokens ?? "—"}</dd>
              <dt className="text-zinc-500">Output tokens</dt>
              <dd className="font-mono text-zinc-900">{usageRec.output_tokens ?? "—"}</dd>
              {usageRec.cache_creation_input_tokens !== undefined ? (
                <>
                  <dt className="text-zinc-500">Cache creation tokens</dt>
                  <dd className="font-mono text-zinc-900">
                    {usageRec.cache_creation_input_tokens}
                  </dd>
                </>
              ) : null}
              {usageRec.cache_read_input_tokens !== undefined ? (
                <>
                  <dt className="text-zinc-500">Cache read tokens</dt>
                  <dd className="font-mono text-zinc-900">
                    {usageRec.cache_read_input_tokens}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          {/* 2. System prompt */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900">System prompt</h3>
              {entry ? <CopyButton text={entry.text} /> : null}
            </div>
            {entry ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800">
                {entry.text}
              </pre>
            ) : (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                Unknown prompt version <span className="font-mono">{promptVersion}</span>.
                The prompt text for this version is no longer registered in code.
              </p>
            )}
          </section>

          {/* 3. User payload */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900">User payload</h3>
              <CopyButton text={userPayloadPretty} />
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800">
              {userPayloadPretty}
            </pre>
          </section>

          {/* 4. Tool schema */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-zinc-900">Tool schema</h3>
              {toolPretty ? <CopyButton text={toolPretty} /> : null}
            </div>
            {toolPretty ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-800">
                {toolPretty}
              </pre>
            ) : (
              <p className="text-xs text-zinc-500">No tool schema available for this prompt version.</p>
            )}
          </section>
        </div>

        <footer className="border-t border-zinc-200 px-4 py-3 sm:px-6">
          <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
}
