"use client";

import { upsertDraft } from "@/app/inbox/compose/actions";
import { bumpAttempt, listQueued, removeQueued } from "./draft-queue";

/**
 * Module-level in-flight gate. The `online` event can fire repeatedly
 * (e.g. on flaky tethering) — we only want one drain at a time. The flag
 * resets in a `finally` so a thrown error doesn't wedge the queue.
 */
let inFlight = false;

async function run(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const queued = await listQueued();
    for (const draft of queued) {
      try {
        const r = await upsertDraft({
          // The queued id is client-side IDB-local — NOT a server `Draft.id`.
          // Pass `draftId: undefined` so the server creates / matches by the
          // (accountId, threadId, mode) tuple per its existing upsert path.
          draftId: undefined,
          accountId: draft.accountId,
          threadId: draft.threadId,
          mode: draft.mode,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
        });
        if (r.ok) {
          await removeQueued(draft.id);
        } else {
          await bumpAttempt(draft.id);
        }
      } catch {
        await bumpAttempt(draft.id);
      }
    }
  } finally {
    inFlight = false;
  }
}

/**
 * Exposed for tests so the unit suite can drive the replay path without
 * having to dispatch a synthetic `online` event. NOT part of the public
 * surface — production code goes through `installReplayListener`.
 */
export const __test__ = { run };

/**
 * Register a `window.online` listener that drains the IDB queue by
 * replaying each entry through `upsertDraft`. Also kicks off an initial
 * drain on mount if `navigator.onLine === true`, in case we missed the
 * transition (e.g. the listener installed after the user came back online).
 *
 * Returns an unsubscribe function suitable for `useEffect` cleanup.
 */
export function installReplayListener(): () => void {
  if (typeof window === "undefined") return () => {};

  const onOnline = () => {
    void run();
  };
  window.addEventListener("online", onOnline);

  // Initial drain. We don't await — the effect mounts during render and
  // shouldn't block. Guard on `onLine` so we don't pointlessly hit the
  // network when the page mounted while offline.
  if (navigator.onLine) {
    void (async () => {
      const queued = await listQueued();
      if (queued.length > 0) void run();
    })();
  }

  return () => window.removeEventListener("online", onOnline);
}
