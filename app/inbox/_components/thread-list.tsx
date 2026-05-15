"use client";

import { InboxEventsListener } from "@/app/inbox/_components/inbox-events-listener";
import { ThreadListRow } from "@/app/inbox/_components/thread-list-row";
import { queryKeys } from "@/app/inbox/_lib/query-keys";
import { listThreads } from "@/app/inbox/actions";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { useQuery } from "@tanstack/react-query";

interface ThreadListProps {
  accountId: string | null;
  initial: { threads: ThreadRow[]; nextCursor: string | null };
  selectedThreadId?: string | null;
}

export function ThreadList({ accountId, initial, selectedThreadId }: ThreadListProps) {
  const query = useQuery({
    queryKey: queryKeys.inbox(accountId),
    queryFn: async () => {
      const res = await listThreads(accountId ? { accountId } : {});
      if (!res.ok) throw new Error(res.error);
      return res.data;
    },
    initialData: initial,
    refetchOnMount: false,
  });

  const data = query.data ?? initial;

  return (
    <div className="flex flex-col">
      <InboxEventsListener />
      {query.isError ? (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Failed to refresh inbox. Showing last loaded data.
        </div>
      ) : null}
      {data.threads.length === 0 ? (
        <EmptyInboxState />
      ) : (
        <ul className="divide-y divide-zinc-100">
          {data.threads.map((t) => (
            <li key={t.id}>
              <ThreadListRow row={t} selected={selectedThreadId === t.id} />
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
