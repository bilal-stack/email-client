"use client";

import { archiveThreads, trashThreads } from "@/app/inbox/actions";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { useInboxSelection } from "@/lib/inbox/selection-store";
import { cn } from "@/lib/utils";
import { AlertTriangle, Archive, Tag, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
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
  const [isPending, startTransition] = useTransition();
  const isSelected = useInboxSelection((s) => s.has(row.id));
  const toggleSelection = useInboxSelection((s) => s.toggle);

  const onArchive = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startTransition(async () => {
      const r = await archiveThreads({ threadIds: [row.id] });
      if (r.ok) router.refresh();
    });
  };
  const onTrash = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    startTransition(async () => {
      const r = await trashThreads({ threadIds: [row.id] });
      if (r.ok) router.refresh();
    });
  };

  const open = () => router.push(`/inbox/${row.id}`);

  return (
    // biome-ignore lint/a11y/useSemanticElements: row hosts buttons inside; nesting a Link interactive would break their click semantics.
    <div
      role="link"
      tabIndex={0}
      data-row-id={row.id}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter") open();
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
            <span className="ml-2 inline-block max-w-[18ch] truncate rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700">
              {row.reason}
            </span>
          ) : (
            <span
              className="ml-2 inline-block w-5 text-center text-xs text-zinc-300"
              aria-hidden="true"
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
