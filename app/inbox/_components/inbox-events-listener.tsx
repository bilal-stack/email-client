"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

// SSE event payload from `/api/inbox/events`. Mirrors `SyncEvent` in
// `lib/realtime/inbox-events.ts`. We parse defensively — a malformed frame
// must not throw out of the EventSource handler.
interface InboxSyncEventShape {
  accountId?: string;
  threadIds?: unknown;
  at?: number;
}

function extractThreadIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const tids = (payload as InboxSyncEventShape).threadIds;
  if (!Array.isArray(tids)) return [];
  return tids.filter((t): t is string => typeof t === "string");
}

export function InboxEventsListener() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/inbox/events");
    es.onmessage = (msg) => {
      // Broad invalidations preserved from the pre-summaries listener.
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["thread"] });

      // Per-thread summary invalidation: each touched threadId becomes a
      // single `["thread-summary", id]` invalidation. New mail on a thread
      // also flips `AISummary.invalidatedAt` server-side (writeDelta), so
      // the next refetch will regenerate.
      let threadIds: string[] = [];
      try {
        threadIds = extractThreadIds(JSON.parse(msg.data));
      } catch {
        // Non-JSON frame (heartbeat / comment) — ignore.
      }
      for (const tid of threadIds) {
        qc.invalidateQueries({ queryKey: ["thread-summary", tid] });
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
