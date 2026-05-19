"use client";

// Horizontal folder switcher. Renders the standard mail folder tabs
// (Inbox / Sent / Drafts / Archived / Spam / Trash) above the thread list.
// Each tab is a real `<Link>` so it survives a hard reload, plays nicely
// with the Next.js prefetcher, and preserves the `?account=` filter so
// switching folders inside a single-account view doesn't drop the user
// back into the unified inbox.
//
// "All mail" is intentionally omitted from the visible tabs — it's a power-
// user view available via `?folder=all` but not chrome the casual user needs.

import { cn } from "@/lib/utils";
import { Archive, Inbox, Mail, MailX, Pencil, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

export type FolderKey =
  | "inbox"
  | "sent"
  | "drafts"
  | "archived"
  | "spam"
  | "trash"
  | "all";

interface FolderNavProps {
  active: FolderKey;
}

const FOLDERS: ReadonlyArray<{
  key: FolderKey;
  label: string;
  icon: typeof Mail;
}> = [
  { key: "inbox", label: "Inbox", icon: Inbox },
  { key: "sent", label: "Sent", icon: Send },
  { key: "drafts", label: "Drafts", icon: Pencil },
  { key: "archived", label: "Archived", icon: Archive },
  { key: "spam", label: "Spam", icon: MailX },
  { key: "trash", label: "Trash", icon: Trash2 },
];

export function FolderNav({ active }: FolderNavProps) {
  const params = useSearchParams();

  function hrefFor(folder: FolderKey): string {
    const next = new URLSearchParams(params?.toString() ?? "");
    // Inbox is the default folder, so omit the query param to keep URLs clean.
    if (folder === "inbox") next.delete("folder");
    else next.set("folder", folder);
    // Drafts has no sort axis; clear it so the URL stays minimal and the
    // sort toggle's localStorage fallback is what governs the next thread-
    // view visit.
    if (folder === "drafts") next.delete("sort");
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  }

  return (
    <nav
      aria-label="Mail folders"
      // Horizontal scroll on narrow screens — six chips comfortably fit on a
      // 600px+ viewport, but a phone in portrait would otherwise wrap into
      // two ragged rows. Single-row scroll is the standard mail-app pattern.
      className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5"
    >
      {FOLDERS.map((f) => {
        const isActive = f.key === active;
        return (
          <Link
            key={f.key}
            href={hrefFor(f.key)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1",
              isActive
                ? "border-zinc-900 bg-zinc-900 text-white"
                : "border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50",
            )}
          >
            <f.icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{f.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
