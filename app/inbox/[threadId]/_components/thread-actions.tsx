"use client";

// Archive + Trash buttons for the thread view header. Client-side so they can
// call the Server Actions and trigger `router.push("/inbox")` on success.

import { archiveThreads, trashThreads } from "@/app/inbox/actions";
import { Button } from "@/components/ui/button";
import { Archive, Loader2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

interface ThreadActionsProps {
  threadId: string;
}

export function ThreadActions({ threadId }: ThreadActionsProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const onArchive = () =>
    startTransition(async () => {
      const r = await archiveThreads({ threadIds: [threadId] });
      if (r.ok) router.push("/inbox");
    });
  const onTrash = () =>
    startTransition(async () => {
      const r = await trashThreads({ threadIds: [threadId] });
      if (r.ok) router.push("/inbox");
    });

  return (
    <>
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
