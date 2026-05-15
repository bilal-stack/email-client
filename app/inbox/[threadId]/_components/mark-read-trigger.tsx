"use client";

import { markThreadRead } from "@/app/inbox/actions";
import { useEffect } from "react";

export function MarkReadTrigger({ threadId }: { threadId: string }) {
  useEffect(() => {
    let cancelled = false;
    markThreadRead({ threadId })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          console.warn("markThreadRead failed:", res.error);
        }
      })
      .catch((e) => {
        console.warn("markThreadRead threw:", e);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);
  return null;
}
