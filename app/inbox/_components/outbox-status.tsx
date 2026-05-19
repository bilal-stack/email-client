"use client";

// Lightweight outbox surface. Mounted once in the inbox layout header.
// Shows nothing when there's no in-flight work; expands into a pill +
// dropdown panel as soon as the user has a queued, sending, or failed
// SendTask. The query that drives it is invalidated by the existing
// `InboxEventsListener` whenever a `send-task-*` SSE event arrives, so
// transitions (queued → sending → completed/failed) reflect within a
// frame of the SSE push.

import {
  discardSendTask,
  listPendingSendTasks,
  retrySendTask,
  type OutboxTaskDTO,
} from "@/app/inbox/compose/actions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Send, X } from "lucide-react";
import { useState } from "react";

export const OUTBOX_QUERY_KEY = ["outbox", "pending"] as const;

function describe(task: OutboxTaskDTO): string {
  return task.subject || "(no subject)";
}

export function OutboxStatus() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  // Poll a slow safety-net interval (15s) so the badge eventually self-
  // heals if an SSE invalidation gets dropped (e.g. the user just opened
  // a second tab and TanStack hasn't propagated yet). The SSE listener
  // drives the fast path.
  const query = useQuery({
    queryKey: OUTBOX_QUERY_KEY,
    queryFn: async () => {
      const r = await listPendingSendTasks();
      if (!r.ok) throw new Error(r.error);
      return r.data;
    },
    refetchInterval: 15_000,
    // Failed-state rows shouldn't disappear when the user leaves the
    // page — the row carries the recovery affordances. Stale rows still
    // refetch on next mount.
    staleTime: 5_000,
  });

  const retryMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const r = await retrySendTask({ taskId });
      if (!r.ok) throw new Error(r.error);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OUTBOX_QUERY_KEY }),
  });
  const discardMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const r = await discardSendTask({ taskId });
      if (!r.ok) throw new Error(r.error);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: OUTBOX_QUERY_KEY }),
  });

  const tasks = query.data?.tasks ?? [];
  if (tasks.length === 0) return null;

  // Pick the most attention-worthy status for the chip: failed > sending > queued.
  const anyFailed = tasks.some((t) => t.status === "failed");
  const anySending = tasks.some((t) => t.status === "sending");
  const failedCount = tasks.filter((t) => t.status === "failed").length;
  const inFlightCount = tasks.filter(
    (t) => t.status === "queued" || t.status === "sending",
  ).length;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={
          anyFailed
            ? `${failedCount} message${failedCount === 1 ? "" : "s"} failed to send`
            : `${inFlightCount} message${inFlightCount === 1 ? "" : "s"} sending`
        }
        className={
          anyFailed
            ? "inline-flex h-9 items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-700 hover:bg-red-100"
            : "inline-flex h-9 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
        }
      >
        {anyFailed ? (
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        ) : anySending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Send className="h-3.5 w-3.5" aria-hidden />
        )}
        <span>
          {anyFailed
            ? `Send failed (${failedCount})`
            : anySending
              ? "Sending…"
              : `${inFlightCount} queued`}
        </span>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Outbox"
          className="absolute right-0 top-10 z-50 w-80 overflow-hidden rounded-md border border-zinc-200 bg-white shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Outbox
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close outbox"
              className="rounded p-1 text-zinc-500 hover:bg-zinc-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <ul className="max-h-72 divide-y divide-zinc-100 overflow-y-auto">
            {tasks.map((t) => (
              <li key={t.id} className="px-3 py-2">
                <div className="flex items-start gap-2">
                  {t.status === "failed" ? (
                    <AlertTriangle
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600"
                      aria-hidden
                    />
                  ) : (
                    <Loader2
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-zinc-500"
                      aria-hidden
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-zinc-900">
                      {describe(t)}
                    </p>
                    {t.status === "failed" && t.error ? (
                      <p className="mt-0.5 text-xs text-red-700">{t.error}</p>
                    ) : (
                      <p className="mt-0.5 text-xs text-zinc-500">
                        {t.status === "sending" ? "Sending now…" : "Waiting to send…"}
                      </p>
                    )}
                  </div>
                </div>
                {t.status === "failed" ? (
                  <div className="mt-2 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => discardMutation.mutate(t.id)}
                      disabled={discardMutation.isPending}
                      className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
                    >
                      Discard
                    </button>
                    <button
                      type="button"
                      onClick={() => retryMutation.mutate(t.id)}
                      disabled={retryMutation.isPending}
                      className="rounded-md bg-zinc-900 px-2 py-1 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
