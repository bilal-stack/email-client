"use client";

// Drafts folder list. Drafts are sourced from the `Draft` table, not from
// `Thread`/`Message`, so they don't fit the existing `ThreadList` row shape.
// This component is intentionally minimal — open routes to the existing
// compose route (which already knows how to hydrate a draft).
//
// Discard is one round-trip via the existing `discardDraft` Server Action;
// the row is then optimistically removed from the local cache. No SSE wiring
// — drafts only change as a result of explicit user action, so we don't
// need provider-side push.

import { discardDraft } from "@/app/inbox/compose/actions";
import { listDraftsAction } from "@/app/inbox/actions";
import { queryKeys } from "@/app/inbox/_lib/query-keys";
import type { DraftRow } from "@/lib/db/inbox-queries";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import Link from "next/link";

function formatTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function composeHrefFor(d: DraftRow): string {
  // New compose with no thread → /inbox/compose/new (the existing compose page
  // hydrates from the Draft table via getDraft). Reply/forward against an
  // existing thread → the thread's compose route, which does the same.
  if (d.threadId === null) return "/inbox/compose/new";
  switch (d.mode) {
    case "reply":
      return `/inbox/${d.threadId}/reply`;
    case "reply-all":
      return `/inbox/${d.threadId}/reply-all`;
    case "forward":
      return `/inbox/${d.threadId}/forward`;
    default:
      // `mode === "new"` against an existing thread is an undocumented state
      // (the schema technically permits it). Land on the thread view rather
      // than guessing a compose flavor.
      return `/inbox/${d.threadId}`;
  }
}

interface DraftListProps {
  accountId: string | null;
  initial: { drafts: DraftRow[] };
}

export function DraftList({ accountId, initial }: DraftListProps) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.drafts(accountId),
    queryFn: async () => {
      const res = await listDraftsAction({
        ...(accountId ? { accountId } : {}),
      });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    initialData: initial,
    refetchOnMount: false,
  });

  const discardMutation = useMutation({
    mutationFn: async (draftId: string) => {
      const r = await discardDraft({ draftId });
      if (!r.ok) throw new Error(r.error);
      return draftId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.drafts(accountId) });
    },
  });

  const drafts = query.data?.drafts ?? [];
  if (drafts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
        <p className="text-sm font-medium text-zinc-700">No drafts yet</p>
        <p className="max-w-sm text-xs text-zinc-500">
          Start a new email and we'll autosave it here as you type.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {drafts.map((d) => (
        <li key={d.id}>
          <div className="group flex min-h-[64px] items-start gap-3 bg-white px-4 py-3 transition-colors hover:bg-zinc-50">
            <Pencil className="mt-1 h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
            <Link href={composeHrefFor(d)} className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-medium text-zinc-900">
                  {d.toLine || "(no recipient yet)"}
                </span>
                <span className="shrink-0 text-xs text-zinc-500">
                  {formatTime(d.updatedAt)}
                </span>
              </div>
              <p className="truncate text-sm text-zinc-700">
                {d.subject || "(no subject)"}
              </p>
              {d.snippet ? (
                <p className="truncate text-xs text-zinc-500">{d.snippet}</p>
              ) : null}
            </Link>
            <button
              type="button"
              aria-label="Discard draft"
              title="Discard draft"
              onClick={() => discardMutation.mutate(d.id)}
              disabled={discardMutation.isPending}
              className="rounded p-1.5 text-zinc-500 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-700 focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-50"
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
