"use client";

import { markThreadRead } from "@/app/inbox/actions";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function MarkReadTrigger({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    markThreadRead({ threadId })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.warn("markThreadRead failed:", res.error);
          return;
        }
        // Bust every cached inbox variant so the row's unread chip + bold
        // styling drops. Keys are `["inbox", folder, accountId, sort]`;
        // a leading-segment predicate hits all variants without us having
        // to enumerate. Without this the row visually stays bold/unread
        // (and the unread dot stays blue) until the next manual refresh.
        queryClient.invalidateQueries({
          predicate: (q) => q.queryKey[0] === "inbox",
        });
      })
      .catch((e) => {
        console.warn("markThreadRead threw:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, queryClient]);
  return null;
}
