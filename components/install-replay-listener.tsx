"use client";

import { installReplayListener } from "@/lib/offline/draft-replay";
import { useEffect } from "react";

/**
 * Mounts the offline-draft replay listener at the root layout. The listener
 * subscribes to `window.online` and drains the IDB queue back through the
 * `upsertDraft` Server Action when connectivity returns. Renders nothing.
 */
export function InstallReplayListener() {
  useEffect(() => {
    const teardown = installReplayListener();
    return teardown;
  }, []);
  return null;
}
