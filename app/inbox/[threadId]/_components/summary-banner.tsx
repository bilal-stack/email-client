"use client";

// Per-thread AI summary banner. Mounted from `page.tsx` immediately below the
// existing ThreadView header. Drives the four-field summary UI via TanStack
// Query against the `summarizeThread` Server Action; opens the trust modal on
// the right-aligned icon button.
//
// SSE invalidation: the existing `<InboxEventsListener />` invalidates
// `["thread-summary", <threadId>]` for every threadId that arrived on an SSE
// event, so when new mail lands on this thread the banner refetches and the
// regenerated summary takes over.

import { ShowPromptModal } from "@/app/inbox/[threadId]/_components/show-prompt-modal";
import { summarizeThread } from "@/app/inbox/[threadId]/summary-actions";
import { useQuery } from "@tanstack/react-query";
import { Calendar, CheckCircle2, FileText, Mail } from "lucide-react";
import { useState } from "react";

interface SummaryBannerProps {
  threadId: string;
}

type Chip = {
  icon: typeof Mail;
  label: string;
  value: string;
  tone: "ask" | "decision" | "deadline";
};

const toneClasses: Record<Chip["tone"], string> = {
  ask: "bg-sky-50 text-sky-900 border-sky-200",
  decision: "bg-emerald-50 text-emerald-900 border-emerald-200",
  deadline: "bg-amber-50 text-amber-900 border-amber-200",
};

export function SummaryBanner({ threadId }: SummaryBannerProps) {
  const [modalOpen, setModalOpen] = useState(false);

  const query = useQuery({
    queryKey: ["thread-summary", threadId],
    queryFn: async () => {
      const r = await summarizeThread({ threadId });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    // The SSE invalidation drives refetch on new mail; otherwise the cached
    // summary is fresh until the user explicitly retries.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <div
        aria-busy="true"
        aria-label="Loading summary"
        className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 sm:px-6"
      >
        <div className="space-y-2">
          <div className="h-4 w-4/5 animate-pulse rounded bg-zinc-200" />
          <div className="h-3 w-2/5 animate-pulse rounded bg-zinc-200" />
        </div>
      </div>
    );
  }

  if (query.isError) {
    // Offline degrades the banner to a single muted line — retrying while
    // disconnected would just hammer the network and surface a confusing
    // error twice. The `online` event already triggers a refetch via the
    // standard window listener TanStack Query installs by default.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return (
        <div className="border-b border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500 sm:px-6">
          Summary unavailable offline
        </div>
      );
    }
    const message = query.error instanceof Error ? query.error.message : "Summary failed";
    return (
      <div
        role="alert"
        className="flex flex-col gap-2 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between sm:px-6"
      >
        <p className="leading-snug">{message}</p>
        <button
          type="button"
          onClick={() => query.refetch()}
          className="inline-flex h-10 items-center justify-center self-start rounded-md border border-amber-300 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100 sm:self-auto"
        >
          Retry
        </button>
      </div>
    );
  }

  const data = query.data;
  if (!data) return null;

  const chips: Chip[] = [];
  if (data.ask) chips.push({ icon: Mail, label: "Ask", value: data.ask, tone: "ask" });
  if (data.decision)
    chips.push({ icon: CheckCircle2, label: "Decision", value: data.decision, tone: "decision" });
  if (data.deadline)
    chips.push({ icon: Calendar, label: "Deadline", value: data.deadline, tone: "deadline" });

  return (
    <>
      <div className="flex flex-col gap-2 border-b border-zinc-200 bg-zinc-50 px-4 py-3 sm:flex-row sm:items-start sm:gap-3 sm:px-6">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-medium leading-snug text-zinc-900 sm:text-base">
            {data.tldr}
          </p>
          {chips.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <li
                  key={c.tone}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${toneClasses[c.tone]}`}
                >
                  <c.icon className="h-3 w-3" aria-hidden />
                  <span className="font-medium">{c.label}:</span>
                  <span className="max-w-[16rem] truncate">{c.value}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center self-end rounded-md text-zinc-600 hover:bg-zinc-200 sm:self-start"
          aria-label="Show me the prompt"
          title="Show me the prompt"
        >
          <FileText className="h-5 w-5" />
        </button>
      </div>
      <ShowPromptModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        promptVersion={data.promptVersion}
        userMessageJson={data.userMessageJson}
        model={data.model}
        usage={data.usage}
        generatedAt={data.generatedAt}
      />
    </>
  );
}
