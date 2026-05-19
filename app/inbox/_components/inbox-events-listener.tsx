"use client";

import { OUTBOX_QUERY_KEY } from "@/app/inbox/_components/outbox-status";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// SSE event payload from `/api/inbox/events`. Mirrors `InboxSseEvent` in
// `lib/realtime/inbox-events.ts` — a discriminated union over the `type` tag.
// We parse defensively — a malformed frame must not throw out of the
// EventSource handler.
type ParsedEvent =
  | { type: "inbox-sync"; threadIds: string[] }
  | { type: "priority-updated"; threadId: string; scoredMessageIds: string[] }
  | { type: "send-task-completed"; taskId: string; threadId: string }
  | { type: "send-task-failed"; taskId: string; error: string }
  | { type: "unknown" };

function parseEvent(raw: unknown): ParsedEvent {
  if (!raw || typeof raw !== "object") return { type: "unknown" };
  const obj = raw as Record<string, unknown>;
  if (obj.type === "inbox-sync") {
    const tids = Array.isArray(obj.threadIds)
      ? (obj.threadIds as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    return { type: "inbox-sync", threadIds: tids };
  }
  if (obj.type === "priority-updated") {
    const threadId = typeof obj.threadId === "string" ? obj.threadId : "";
    const ids = Array.isArray(obj.scoredMessageIds)
      ? (obj.scoredMessageIds as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : [];
    if (!threadId) return { type: "unknown" };
    return { type: "priority-updated", threadId, scoredMessageIds: ids };
  }
  if (obj.type === "send-task-completed") {
    const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
    const threadId = typeof obj.threadId === "string" ? obj.threadId : "";
    if (!taskId || !threadId) return { type: "unknown" };
    return { type: "send-task-completed", taskId, threadId };
  }
  if (obj.type === "send-task-failed") {
    const taskId = typeof obj.taskId === "string" ? obj.taskId : "";
    const error = typeof obj.error === "string" ? obj.error : "Send failed.";
    if (!taskId) return { type: "unknown" };
    return { type: "send-task-failed", taskId, error };
  }
  // Legacy/unwrapped frame (pre–discriminated-union shape) — treat as
  // inbox-sync if it carries a `threadIds` array. Defensive against an
  // in-flight client reconnecting to a server still emitting the old shape
  // (e.g. during a rolling deploy).
  if (Array.isArray(obj.threadIds)) {
    const tids = (obj.threadIds as unknown[]).filter(
      (t): t is string => typeof t === "string",
    );
    return { type: "inbox-sync", threadIds: tids };
  }
  return { type: "unknown" };
}

export function InboxEventsListener() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/inbox/events");
    es.onmessage = (msg) => {
      let parsed: ParsedEvent = { type: "unknown" };
      try {
        parsed = parseEvent(JSON.parse(msg.data));
      } catch {
        // Non-JSON frame (heartbeat / comment) — ignore.
      }

      if (parsed.type === "inbox-sync") {
        // Broad invalidations preserved from the pre-summaries listener.
        qc.invalidateQueries({ queryKey: ["inbox"] });
        qc.invalidateQueries({ queryKey: ["thread"] });
        // Per-thread summary invalidation: each touched threadId becomes a
        // single `["thread-summary", id]` invalidation. New mail on a thread
        // also flips `AISummary.invalidatedAt` server-side (writeDelta), so
        // the next refetch will regenerate.
        for (const tid of parsed.threadIds) {
          qc.invalidateQueries({ queryKey: ["thread-summary", tid] });
        }
        return;
      }

      if (parsed.type === "priority-updated") {
        // The row chip lives on the inbox query; invalidate it so the
        // newly-persisted PriorityScore renders. Per-thread summary key is
        // included as a harmless belt-and-suspenders against any future
        // thread-level chip surface.
        qc.invalidateQueries({ queryKey: ["inbox"] });
        qc.invalidateQueries({ queryKey: ["thread-summary", parsed.threadId] });
        return;
      }

      if (
        parsed.type === "send-task-completed" ||
        parsed.type === "send-task-failed"
      ) {
        // Outbox pill drives off this query; refetch so the row drops
        // (completed → deleted) or flips to its error state (failed).
        // Inbox is invalidated via the inbox-sync event the worker emits
        // alongside completion, so we don't double-invalidate here.
        qc.invalidateQueries({ queryKey: OUTBOX_QUERY_KEY });
        return;
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects on transient drops. Nothing to do here.
    };
    return () => {
      es.close();
    };
  }, [qc]);

  return null;
}
