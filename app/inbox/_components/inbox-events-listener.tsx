"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

export function InboxEventsListener() {
  const qc = useQueryClient();

  useEffect(() => {
    const es = new EventSource("/api/inbox/events");
    es.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["inbox"] });
      qc.invalidateQueries({ queryKey: ["thread"] });
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
