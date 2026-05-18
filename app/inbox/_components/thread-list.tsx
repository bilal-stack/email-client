"use client";

import { BulkActionBar } from "@/app/inbox/_components/bulk-action-bar";
import { InboxEventsListener } from "@/app/inbox/_components/inbox-events-listener";
import { ThreadListRow } from "@/app/inbox/_components/thread-list-row";
import { queryKeys } from "@/app/inbox/_lib/query-keys";
import { archiveThreads, listThreads, trashThreads } from "@/app/inbox/actions";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { useInboxKeyboard } from "@/lib/inbox/keyboard";
import { useInboxSelection } from "@/lib/inbox/selection-store";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

interface ThreadListProps {
  accountId: string | null;
  initial: { threads: ThreadRow[]; nextCursor: string | null };
  selectedThreadId?: string | null;
  sort?: "priority" | "time";
}

export function ThreadList({
  accountId,
  initial,
  selectedThreadId,
  sort = "priority",
}: ThreadListProps) {
  const query = useQuery({
    queryKey: queryKeys.inbox(accountId, sort),
    queryFn: async () => {
      const res = await listThreads({
        ...(accountId ? { accountId } : {}),
        sort,
      });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    initialData: initial,
    refetchOnMount: false,
  });

  const data = query.data ?? initial;
  const rowIds = data.threads.map((t) => t.id);
  const router = useRouter();
  const selectedIds = useInboxSelection((s) => s.selected);
  const toggleSelection = useInboxSelection((s) => s.toggle);
  const clearSelection = useInboxSelection((s) => s.clear);

  const { focusedIndex, setFocusedIndex } = useInboxKeyboard({
    rowIds,
    onOpen: (id) => router.push(`/inbox/${id}`),
    onArchive: async (ids) => {
      await archiveThreads({ threadIds: ids });
      clearSelection();
      router.refresh();
    },
    onTrash: async (ids) => {
      await trashThreads({ threadIds: ids });
      clearSelection();
      router.refresh();
    },
    onToggleSelect: (id) => toggleSelection(id),
    onClearSelection: () => clearSelection(),
    onFocusSearch: () => {
      const input = document.querySelector('input[type="search"]') as HTMLInputElement | null;
      input?.focus();
    },
    selectedIds: () => [...selectedIds],
  });

  // Scroll the focused row into view when it changes
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rowIds.length === 0) return;
    const id = rowIds[focusedIndex];
    if (!id) return;
    const el = containerRef.current?.querySelector(`[data-row-id="${id}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [focusedIndex, rowIds]);

  // Clamp focused index when the list shrinks (e.g. after archive)
  useEffect(() => {
    if (focusedIndex >= rowIds.length) setFocusedIndex(Math.max(0, rowIds.length - 1));
  }, [rowIds.length, focusedIndex, setFocusedIndex]);

  return (
    <div ref={containerRef} className="flex flex-col">
      <InboxEventsListener />
      <BulkActionBar />
      {query.isError ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Failed to refresh inbox. Showing last loaded data.
        </div>
      ) : null}
      {data.threads.length === 0 ? (
        <EmptyInboxState />
      ) : (
        <ul className="divide-y divide-zinc-100">
          {data.threads.map((t, i) => (
            <li key={t.id}>
              <ThreadListRow
                row={t}
                selected={selectedThreadId === t.id}
                focused={i === focusedIndex}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyInboxState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-zinc-700">Your inbox is empty</p>
      <p className="max-w-sm text-xs text-zinc-500">
        New mail will land here automatically as the background sync runs. You'll see it without
        refreshing.
      </p>
    </div>
  );
}
