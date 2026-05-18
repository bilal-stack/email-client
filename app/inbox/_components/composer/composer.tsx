"use client";

import { AIDraftPanel } from "@/app/inbox/[threadId]/_components/ai-draft-panel";
import { type AccountOption, AccountPicker } from "@/app/inbox/_components/composer/account-picker";
import { AttachmentList } from "@/app/inbox/_components/composer/attachment-list";
import {
  ComposeActionBar,
  type SaveStatus,
} from "@/app/inbox/_components/composer/compose-action-bar";
import { RecipientsInput } from "@/app/inbox/_components/composer/recipients-input";
import { TipTapEditor } from "@/app/inbox/_components/composer/tiptap-editor";
import { discardDraft, sendDraft, upsertDraft } from "@/app/inbox/compose/actions";
import { queueDraft } from "@/lib/offline/draft-queue";
import type { CanonicalAddress } from "@/lib/providers/types";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

/**
 * Convert plain text (as returned by the AI-draft tool) to minimal HTML
 * suitable for TipTap. Paragraph per double-newline; <br/> per single
 * newline within a paragraph. Empty paragraphs collapse to nothing.
 */
function plainTextToHtml(text: string): string {
  return text
    .split(/\n\n+/)
    .map((para) => {
      const escaped = para
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      const withBreaks = escaped.replace(/\n/g, "<br/>");
      return withBreaks ? `<p>${withBreaks}</p>` : "";
    })
    .join("");
}

export type DraftMode = "new" | "reply" | "reply-all" | "forward";

interface ParentMessageContext {
  inReplyTo: string[];
  references: string[];
  forwardQuote?: string;
  prefilledTo?: CanonicalAddress[];
  prefilledCc?: CanonicalAddress[];
  prefilledSubject: string;
}

interface InitialDraft {
  id: string;
  to: CanonicalAddress[];
  cc: CanonicalAddress[];
  bcc: CanonicalAddress[];
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

export function Composer({
  mode,
  accountId: initialAccountId,
  accountOptions,
  threadId,
  parentMessage,
  initialDraft,
}: ComposerProps) {
  const router = useRouter();
  const subjectId = useId();

  const [accountId, setAccountId] = useState(initialAccountId);
  const [to, setTo] = useState<CanonicalAddress[]>(
    initialDraft?.to ?? parentMessage?.prefilledTo ?? [],
  );
  const [cc, setCc] = useState<CanonicalAddress[]>(
    initialDraft?.cc ?? parentMessage?.prefilledCc ?? [],
  );
  const [bcc, setBcc] = useState<CanonicalAddress[]>(initialDraft?.bcc ?? []);
  const [subject, setSubject] = useState(
    initialDraft?.subject ?? parentMessage?.prefilledSubject ?? "",
  );
  const [bodyHtml, setBodyHtml] = useState(
    initialDraft?.bodyHtml ?? parentMessage?.forwardQuote ?? "",
  );
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draftId, setDraftId] = useState<string | undefined>(initialDraft?.id);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Bumps every time the AI panel writes the body — forces TipTap to
  // re-mount with the new `initialContent` (the editor doesn't accept
  // an imperative setContent prop in this codebase).
  const [editorEpoch, setEditorEpoch] = useState(0);

  // Snapshot of bodyHtml at the moment of the most recent AI pick. We treat
  // the body as "manually edited" iff it differs from this snapshot AND is
  // non-empty. Initial value `null` means "no AI pick yet" — in that case any
  // typed content qualifies as manual.
  const [lastAIBodyHtml, setLastAIBodyHtml] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const firstRunRef = useRef(true);
  // Tracks the IDB-local id of the most recent queued offline autosave so
  // consecutive offline saves update the same row instead of accumulating
  // duplicates. Cleared when an online save succeeds.
  const queuedIdRef = useRef<string | null>(null);

  const inReplyTo = parentMessage?.inReplyTo ?? [];
  const references = parentMessage?.references ?? [];

  // Autosave: 2 s after the last state change. Attachments deliberately
  // excluded from the dependency array — they live in memory until send.
  // The stable refs (mode, threadId, parentMessage-derived inReplyTo /
  // references) don't need to be in the dep array; only fields the user can
  // mutate need to retrigger the debounce.
  // biome-ignore lint/correctness/useExhaustiveDependencies: attachments deliberately omitted; stable refs (mode/threadId/inReplyTo/references/draftId) intentionally not retriggers
  useEffect(() => {
    if (firstRunRef.current) {
      firstRunRef.current = false;
      return;
    }
    const t = setTimeout(async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;

      // Offline path: skip the Server Action and stash in IndexedDB. The
      // replay listener in the root layout drains the queue on the next
      // `online` event, after which the regular online autosave below
      // takes over authoritatively.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        try {
          const id = await queueDraft({
            id: queuedIdRef.current ?? undefined,
            accountId,
            threadId: threadId ?? null,
            mode,
            to,
            cc,
            bcc,
            subject,
            bodyHtml,
            inReplyTo,
            references,
          });
          queuedIdRef.current = id;
          setSaveStatus("queued-offline");
        } catch {
          setSaveStatus("error");
        } finally {
          inFlightRef.current = false;
        }
        return;
      }

      setSaveStatus("saving");
      const result = await upsertDraft({
        ...(draftId ? { draftId } : {}),
        accountId,
        threadId: threadId ?? null,
        mode,
        to,
        cc,
        bcc,
        subject,
        bodyHtml,
        inReplyTo,
        references,
      });
      inFlightRef.current = false;
      if (result.ok) {
        setDraftId(result.data.draftId);
        setSaveStatus("saved");
        // A successful online save makes the queued offline copy obsolete —
        // the replay listener removes the IDB entry separately. We just
        // forget our local reference.
        queuedIdRef.current = null;
      } else {
        setSaveStatus("error");
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [accountId, to, cc, bcc, subject, bodyHtml]);

  async function handleSend() {
    if (sending) return;
    setSending(true);
    setSendError(null);

    const fd = new FormData();
    if (draftId) fd.set("draftId", draftId);
    fd.set("accountId", accountId);
    fd.set("threadId", threadId ?? "");
    fd.set("mode", mode);
    fd.set("to", JSON.stringify(to));
    fd.set("cc", JSON.stringify(cc));
    fd.set("bcc", JSON.stringify(bcc));
    fd.set("subject", subject);
    fd.set("bodyHtml", bodyHtml);
    fd.set("inReplyTo", JSON.stringify(inReplyTo));
    fd.set("references", JSON.stringify(references));
    for (const f of attachments) fd.append("attachments", f);

    const result = await sendDraft(fd);
    setSending(false);
    if (!result.ok) {
      setSendError(result.error);
      return;
    }
    router.push(threadId ? `/inbox/${threadId}` : "/inbox");
    router.refresh();
  }

  async function handleDiscard() {
    if (draftId) {
      await discardDraft({ draftId });
    }
    router.push(threadId ? `/inbox/${threadId}` : "/inbox");
    router.refresh();
  }

  const canSend = to.length > 0 && !sending;
  const canDiscard = Boolean(draftId);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        <AccountPicker
          value={accountId}
          options={accountOptions}
          disabled={mode !== "new"}
          onChange={setAccountId}
        />
        <RecipientsInput label="To" value={to} onChange={setTo} />
        <RecipientsInput label="Cc" value={cc} onChange={setCc} />
        <RecipientsInput label="Bcc" value={bcc} onChange={setBcc} />
        <div className="flex flex-col gap-1">
          <label
            htmlFor={subjectId}
            className="text-xs font-medium uppercase tracking-wide text-zinc-500"
          >
            Subject
          </label>
          <input
            id={subjectId}
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-h-[44px] w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
        </div>
        {threadId && mode !== "new" ? (
          <AIDraftPanel
            threadId={threadId}
            mode={mode}
            accountId={accountId}
            hasUnsavedManualEdits={
              bodyHtml.trim().length > 0 && bodyHtml !== lastAIBodyHtml
            }
            onPick={(text) => {
              const html = plainTextToHtml(text);
              setBodyHtml(html);
              setLastAIBodyHtml(html);
              setEditorEpoch((n) => n + 1);
            }}
          />
        ) : null}
        <TipTapEditor
          key={editorEpoch}
          initialContent={bodyHtml}
          onUpdate={setBodyHtml}
        />
        <AttachmentList attachments={attachments} onChange={setAttachments} />
        {sendError ? (
          <p
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          >
            {sendError}
          </p>
        ) : null}
      </div>
      <ComposeActionBar
        saveStatus={saveStatus}
        sending={sending}
        canSend={canSend}
        canDiscard={canDiscard}
        onSend={handleSend}
        onDiscard={handleDiscard}
      />
    </div>
  );
}
