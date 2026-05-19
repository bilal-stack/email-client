"use client";

import { BulkActionBar } from "@/app/inbox/_components/bulk-action-bar";
import { ThreadListRow } from "@/app/inbox/_components/thread-list-row";
import { queryKeys } from "@/app/inbox/_lib/query-keys";
import { archiveThreads, listThreads, trashThreads } from "@/app/inbox/actions";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { useInboxKeyboard } from "@/lib/inbox/keyboard";
import { useInboxSelection } from "@/lib/inbox/selection-store";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

interface ThreadListProps {
  accountId: string | null;
  initial: { threads: ThreadRow[]; nextCursor: string | null };
  selectedThreadId?: string | null;
  sort?: "priority" | "time";
  /// Which logical folder this list is viewing. Drives both the query key
  /// (so each folder has its own cache slot) and the `folder` argument
  /// passed to `listThreads`. Default `"inbox"` for backwards compat with
  /// existing call sites that don't yet pass the prop.
  folder?: "inbox" | "sent" | "archived" | "spam" | "trash" | "all";
}

export function ThreadList({
  accountId,
  initial,
  selectedThreadId,
  sort = "priority",
  folder = "inbox",
}: ThreadListProps) {
  const query = useQuery({
    queryKey: queryKeys.inbox(accountId, sort, folder),
    queryFn: async () => {
      const res = await listThreads({
        ...(accountId ? { accountId } : {}),
        sort,
        folder,
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
  const queryClient = useQueryClient();
  const selectedIds = useInboxSelection((s) => s.selected);
  const toggleSelection = useInboxSelection((s) => s.toggle);
  const clearSelection = useInboxSelection((s) => s.clear);

  const { focusedIndex, setFocusedIndex } = useInboxKeyboard({
    rowIds,
    onOpen: (id) => router.push(`/inbox/${id}`),
    onArchive: async (ids) => {
      await archiveThreads({ threadIds: ids });
      clearSelection();
      // Invalidate the inbox query so the archived rows disappear without a
      // full page reload. `router.refresh()` re-renders the page's server
      // components but doesn't bust the TanStack Query cache that drives
      // this list, so without the explicit invalidate the row would
      // visibly stick until the user manually reloaded.
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox(accountId, sort, folder) });
      router.refresh();
    },
    onTrash: async (ids) => {
      await trashThreads({ threadIds: ids });
      clearSelection();
      await queryClient.invalidateQueries({ queryKey: queryKeys.inbox(accountId, sort, folder) });
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
      {/* InboxEventsListener moved to layout — see app/inbox/layout.tsx */}
      <BulkActionBar />
      {query.isError ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Failed to refresh inbox. Showing last loaded data.
        </div>
      ) : null}
      {data.threads.length === 0 ? (
        <EmptyInboxState folder={folder} />
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

const EMPTY_COPY: Record<
  NonNullable<ThreadListProps["folder"]>,
  { title: string; body: string }
> = {
  inbox: {
    title: "Your inbox is empty",
    body: "New mail will land here automatically as the background sync runs. You'll see it without refreshing.",
  },
  sent: {
    title: "No sent mail yet",
    body: "Messages you send will appear here automatically.",
  },
  archived: {
    title: "Nothing archived",
    body: "Archive a thread from the inbox to move it here.",
  },
  spam: {
    title: "No spam",
    body: "Anything your mail provider flags as junk will land here.",
  },
  trash: {
    title: "Trash is empty",
    body: "Threads you delete will live here until your provider purges them.",
  },
  all: {
    title: "No mail yet",
    body: "Once sync runs, every message across your accounts will appear here.",
  },
};

function EmptyInboxState({
  folder,
}: {
  folder: NonNullable<ThreadListProps["folder"]>;
}) {
  const copy = EMPTY_COPY[folder];
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm font-medium text-zinc-700">{copy.title}</p>
      <p className="max-w-sm text-xs text-zinc-500">{copy.body}</p>
    </div>
  );
}
