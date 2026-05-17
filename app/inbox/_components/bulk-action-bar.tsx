"use client";

// Bulk-action toolbar — slides in above the thread list when one or more rows
// are selected. Wires to the archive / trash / labels Server Actions, then
// clears selection on success.

import { LabelsPopover } from "@/app/inbox/_components/labels-popover";
import { archiveThreads, trashThreads } from "@/app/inbox/actions";
import { Button } from "@/components/ui/button";
import { useInboxSelection } from "@/lib/inbox/selection-store";
import { cn } from "@/lib/utils";
import { Archive, Loader2, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

interface BulkActionBarProps {
  className?: string;
}

export function BulkActionBar({ className }: BulkActionBarProps) {
  const selected = useInboxSelection((s) => s.selected);
  const clear = useInboxSelection((s) => s.clear);
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  if (selected.size === 0) return null;
  const ids = [...selected];

  const runArchive = () =>
    startTransition(async () => {
      const r = await archiveThreads({ threadIds: ids });
      if (r.ok) {
        clear();
        router.refresh();
      }
    });

  const runTrash = () =>
    startTransition(async () => {
      const r = await trashThreads({ threadIds: ids });
      if (r.ok) {
        clear();
        router.refresh();
      }
    });

  const onLabelsApplied = () => {
    clear();
    router.refresh();
  };

  return (
    <div
      role="toolbar"
      aria-label={`Bulk actions on ${selected.size} thread${selected.size === 1 ? "" : "s"}`}
      className={cn(
        "flex items-center justify-between gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2",
        className,
      )}
    >
      <div className="flex items-center gap-2 text-sm text-zinc-700">
        <button
          type="button"
          aria-label="Clear selection"
          onClick={() => clear()}
          className="rounded p-1 hover:bg-zinc-100"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <span>
          <span className="font-medium">{selected.size}</span> selected
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={runArchive} disabled={isPending}>
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Archive className="h-4 w-4" aria-hidden="true" />
          )}
          <span>Archive</span>
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={runTrash} disabled={isPending}>
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          )}
          <span>Trash</span>
        </Button>
        <LabelsPopover threadIds={ids} onApplied={onLabelsApplied} />
      </div>
    </div>
  );
}
