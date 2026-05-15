import { Avatar } from "@/components/ui/avatar";
import type { ThreadRow } from "@/lib/db/inbox-queries";
import { cn } from "@/lib/utils";
import Link from "next/link";

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
}: {
  row: ThreadRow;
  selected?: boolean;
}) {
  const isUnread = row.unreadCount > 0;
  const senderLabel =
    row.participantCount > 2 ? `${row.fromName} +${row.participantCount - 1}` : row.fromName;
  return (
    <Link
      href={`/inbox/${row.id}`}
      prefetch={false}
      className={cn(
        "flex min-h-[64px] items-start gap-3 border-b border-zinc-100 bg-white px-4 py-3 transition-colors",
        "hover:bg-zinc-50 focus-visible:bg-zinc-50 focus-visible:outline-none",
        selected && "bg-zinc-100 hover:bg-zinc-100",
      )}
      aria-current={selected ? "true" : undefined}
    >
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
        <p
          className={cn(
            "truncate text-sm",
            isUnread ? "text-zinc-900" : "text-zinc-700",
            isUnread && "font-medium",
          )}
        >
          {row.subject || "(no subject)"}
        </p>
        <p className="truncate text-xs text-zinc-500">{row.snippet}</p>
      </div>
      {isUnread ? (
        <span
          aria-label={`${row.unreadCount} unread`}
          className="mt-2 inline-flex h-2.5 w-2.5 shrink-0 rounded-full bg-blue-600"
        />
      ) : null}
    </Link>
  );
}
