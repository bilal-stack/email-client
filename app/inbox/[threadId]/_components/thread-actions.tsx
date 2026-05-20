"use client";

// Archive + Trash + Move-to-Inbox buttons for the thread view header.
// Client-side so they can call Server Actions and trigger
// `router.push("/inbox")` on success. After every mutation we bust every
// variant of the inbox query (any folder / sort / account combo) — without
// that, landing back on /inbox would render a stale TanStack Query cache
// that still contains the just-archived row.

import {
  archiveThreads,
  setThreadLabels,
  trashThreads,
} from "@/app/inbox/actions";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, Inbox, Loader2, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

interface ThreadActionsProps {
  threadId: string;
  /// The thread's current labels. Drives folder-aware buttons (e.g. show
  /// "Move to inbox" only when the thread is currently in Spam / Archived /
  /// Trash; show "Not spam" only when it's in Spam). Pass through from
  /// the server-rendered thread row.
  labels?: readonly string[];
}

export function ThreadActions({ threadId, labels = [] }: ThreadActionsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();

  const inSpam = labels.includes("SPAM");
  const inTrash = labels.includes("TRASH");
  const inInbox = labels.includes("INBOX");

  // Bust every cached inbox variant — keys are shaped
  // `["inbox", folder, accountId, sort]` so predicating on the leading
  // segment hits all of them without us having to enumerate.
  const invalidateInbox = () =>
    queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "inbox",
    });

  // After a folder-changing mutation we land on /inbox preserving the
  // current scope (?folder=, ?account=, ?sort=). Otherwise archiving a
  // Sent-folder thread would dump the user back into the default Inbox
  // view, losing where they were.
  const inboxHref = () => {
    const qs = searchParams?.toString() ?? "";
    return qs ? `/inbox?${qs}` : "/inbox";
  };

  const onArchive = () =>
    startTransition(async () => {
      const r = await archiveThreads({ threadIds: [threadId] });
      if (r.ok) {
        await invalidateInbox();
        router.push(inboxHref());
      }
    });
  const onTrash = () =>
    startTransition(async () => {
      const r = await trashThreads({ threadIds: [threadId] });
      if (r.ok) {
        await invalidateInbox();
        router.push(inboxHref());
      }
    });

  // "Move to inbox" — used to recover Spam / Trash / Archived threads.
  // Adds INBOX, removes whatever folder label is currently sticking the
  // thread out of the inbox view. We send all three removes regardless;
  // the provider call is idempotent on labels the thread doesn't have.
  //
  // We do NOT redirect away from the thread on success. The earlier behavior
  // pushed the user to `/inbox` and relied on the invalidated query to
  // refetch, but the new row didn't always render in time — the provider
  // call returned, the local Thread.labels was updated, the inbox query
  // was invalidated, but the listThreadsForUser refetch raced with the
  // SSE inbox-sync emit and the user landed on a stale list. Easier and
  // less surprising: stay on the thread, the user navigates back when
  // they want and the inbox list is correct by then.
  const onMoveToInbox = () =>
    startTransition(async () => {
      const r = await setThreadLabels({
        threadIds: [threadId],
        add: ["INBOX"],
        remove: ["SPAM", "TRASH"],
      });
      if (r.ok) {
        await invalidateInbox();
        // Re-fetch the current server-rendered thread so the header
        // (which renders this component with `labels` from props) reflects
        // the new label set — "Not spam" button disappears, etc.
        router.refresh();
      }
    });

  const showMoveToInbox = inSpam || inTrash || (!inInbox && labels.length > 0);

  return (
    <>
      {showMoveToInbox ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onMoveToInbox}
          disabled={isPending}
          aria-label={inSpam ? "Not spam — move to inbox" : "Move to inbox"}
          title={inSpam ? "Not spam — move to inbox" : "Move to inbox"}
        >
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Inbox className="h-4 w-4" aria-hidden="true" />
          )}
          <span>{inSpam ? "Not spam" : "Move to inbox"}</span>
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onArchive}
        disabled={isPending}
        aria-label="Archive thread"
        title="Archive (e)"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Archive className="h-4 w-4" aria-hidden="true" />
        )}
        <span>Archive</span>
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        onClick={onTrash}
        disabled={isPending}
        aria-label="Move to trash"
        title="Trash (#)"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        )}
        <span>Trash</span>
      </Button>
    </>
  );
}
