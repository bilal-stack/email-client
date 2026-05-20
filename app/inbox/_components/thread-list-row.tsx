"use client";

import { archiveThreads, trashThreads } from "@/app/inbox/actions";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { useInboxSelection } from "@/lib/inbox/selection-store";
import { cn } from "@/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, Sparkles, Tag, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

function formatTime(d: Date | string) {
  const date = typeof d === "string" ? new Date(d) : d;
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function ThreadListRow({
  row,
  selected,
  focused,
}: {
  row: ThreadRow;
  selected?: boolean;
  focused?: boolean;
}) {
  const isUnread = row.unreadCount > 0;
  const senderLabel =
    row.participantCount > 2 ? `${row.fromName} +${row.participantCount - 1}` : row.fromName;
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const [isPending, startTransition] = useTransition();
  const isSelected = useInboxSelection((s) => s.has(row.id));
  const toggleSelection = useInboxSelection((s) => s.toggle);

  // Bust every variant of the inbox query key (any accountId / sort combo) so
  // the row disappears immediately regardless of which view is open. We don't
  // know the exact `(accountId, sort)` tuple this row is being viewed under
  // from inside the row component, so we invalidate by predicate on the
  // top-level "inbox" tag in the queryKey shape (see `_lib/query-keys.ts`).
  const invalidateInbox = () =>
    queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] === "inbox",
    });

  const onArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startTransition(async () => {
      const r = await archiveThreads({ threadIds: [row.id] });
      if (r.ok) {
        await invalidateInbox();
        router.refresh();
      }
    });
  };
  const onTrash = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startTransition(async () => {
      const r = await trashThreads({ threadIds: [row.id] });
      if (r.ok) {
        await invalidateInbox();
        router.refresh();
      }
    });
  };

  // Forward the current `?folder=`, `?sort=`, `?account=` selections so the
  // thread page's side panel renders the same folder/sort context the user
  // was just in. Otherwise opening a Sent-folder thread would bounce them
  // back to the Inbox folder when they return to the list.
  //
  // We read the row id from the live DOM (`data-row-id` on `currentTarget`)
  // instead of trusting the closure's `row.id`. This is a defense against
  // a real bug we saw in manual testing where clicking row A would open
  // row B: an SSE-driven inbox refetch can reorder the list between
  // `mousedown` and `click`, leaving the DOM node attached to a different
  // React component than the one whose closure captured the click handler.
  // Reading the attribute back from `currentTarget` always reflects the
  // row that's currently rendered at the clicked DOM position. The
  // closure's `row.id` is the fallback for keyboard-driven opens.
  const open = (
    e?: { currentTarget: HTMLElement } | React.SyntheticEvent<HTMLElement>,
  ) => {
    const liveId =
      e?.currentTarget instanceof HTMLElement
        ? e.currentTarget.dataset.rowId ?? null
        : null;
    const id = liveId ?? row.id;
    const qs = searchParams?.toString() ?? "";
    router.push(qs ? `/inbox/${id}?${qs}` : `/inbox/${id}`);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts buttons inside; nesting a Link interactive would break their click semantics.
    <div
      role="link"
      tabIndex={0}
      data-row-id={row.id}
      onClick={(e) => open(e)}
      onKeyDown={(e) => {
        if (e.key === "Enter") open(e);
      }}
      className={cn(
        "group flex min-h-[64px] cursor-pointer items-start gap-3 border-b border-zinc-100 bg-white px-4 py-3 transition-colors",
        "hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none",
        selected && "bg-zinc-100 hover:bg-zinc-100",
        focused && "ring-2 ring-inset ring-zinc-300",
        isSelected && "bg-blue-50/40",
        isPending && "opacity-60",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <div
        className={cn(
          "mt-1 flex shrink-0 items-center transition-opacity",
          isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        )}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <Checkbox
          aria-label="Select thread"
          checked={isSelected}
          onCheckedChange={() => toggleSelection(row.id)}
        />
      </div>

      <Avatar fallback={senderLabel || row.accountEmail || "?"} className="mt-0.5 h-9 w-9" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              "truncate text-sm",
              isUnread ? "font-semibold text-zinc-900" : "font-medium text-zinc-700",
            )}
          >
            {senderLabel || row.accountEmail || "(unknown)"}
          </span>
          <span className="shrink-0 text-xs text-zinc-500">{formatTime(row.lastMessageAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-y-1">
          <p
            className={cn(
              "min-w-0 max-w-full truncate text-sm",
              isUnread ? "text-zinc-900" : "text-zinc-700",
              isUnread && "font-medium",
            )}
          >
            {row.subject || row.snippet || "(no subject)"}
          </p>
          {row.reason !== null ? (
            <span
              title={`AI prioritization: ${row.reason}`}
              className="ml-2 inline-flex max-w-[20ch] items-center gap-1 truncate rounded-full bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700"
            >
              <Sparkles className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{row.reason}</span>
            </span>
          ) : (
            <span
              className="ml-2 inline-block w-5 text-center text-xs text-zinc-300"
              aria-hidden="true"
              title="AI is scoring this thread…"
            >
              …
            </span>
          )}
          {row.riskFlag !== null && row.riskFlag !== "ok" ? (
            <span
              aria-label={
                row.riskFlag === "phish" ? "Risk: phishing" : "Risk: promotional"
              }
              className={cn(
                "ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs",
                row.riskFlag === "phish"
                  ? "bg-red-50 text-red-700"
                  : "bg-amber-50 text-amber-800",
              )}
            >
              {row.riskFlag === "phish" ? (
                <AlertTriangle className="h-3 w-3" aria-hidden="true" />
              ) : (
                <Tag className="h-3 w-3" aria-hidden="true" />
              )}
              {row.riskFlag === "phish" ? "phish" : "promo"}
            </span>
          ) : null}
        </div>
        {row.subject && row.snippet ? (
          <p className="truncate text-xs text-zinc-500">{row.snippet}</p>
        ) : null}
      </div>

      <div className="ml-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          aria-label="Archive thread"
          title="Archive (e)"
          onClick={onArchive}
          disabled={isPending}
          className="rounded p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 disabled:opacity-50"
        >
          <Archive className="h-4 w-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label="Move to trash"
          title="Trash (#)"
          onClick={onTrash}
          disabled={isPending}
          className="rounded p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {isUnread ? (
        <span
          aria-label={`${row.unreadCount} unread`}
          className="ml-1 mt-2 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600"
        />
      ) : null}
    </div>
  );
}
