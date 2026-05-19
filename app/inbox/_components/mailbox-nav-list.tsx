"use client";

// Left-pane mailbox switcher. Renders an "All inboxes" entry plus one row
// per connected `MailAccount`. Selecting a row sets `?account=<id>` on the
// inbox URL and preserves the user's current folder (`?folder=`) and sort
// (`?sort=`) selections — so a click here just narrows the scope of the
// active view, never blows away the view the user was in.
//
// Server-rendered alternative considered: pure `<Link>` whose `href`
// embeds the current searchParams. We need to read URL state on the
// client anyway to mark the active row, so we already pay the client
// component cost; embedding the searchParams here keeps the merge logic
// in one place.

import { Mail } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

export interface MailboxNavAccount {
  id: string;
  emailAddress: string;
  displayName: string | null;
  provider: string;
}

interface MailboxNavListProps {
  accounts: MailboxNavAccount[];
}

const PROVIDER_LABELS: Record<string, string> = {
  gmail: "Gmail",
  graph: "Outlook",
  imap: "IMAP",
};

export function MailboxNavList({ accounts }: MailboxNavListProps) {
  const params = useSearchParams();
  const activeAccountId = params?.get("account") ?? null;

  /**
   * Build the href for a mailbox row. `accountId === null` means "All
   * inboxes" — we DROP the account param. Otherwise we set it. Other
   * params (folder, sort) survive the click.
   */
  function hrefFor(accountId: string | null): string {
    const next = new URLSearchParams(params?.toString() ?? "");
    if (accountId) next.set("account", accountId);
    else next.delete("account");
    const qs = next.toString();
    return qs ? `/inbox?${qs}` : "/inbox";
  }

  if (accounts.length === 0) {
    return <p className="mt-2 px-2 py-1 text-xs text-zinc-500">No accounts connected.</p>;
  }

  return (
    <ul className="mt-2 space-y-0.5" aria-label="Filter by mailbox">
      <li>
        <Link
          href={hrefFor(null)}
          aria-current={activeAccountId === null ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
            activeAccountId === null
              ? "bg-zinc-900 text-white"
              : "text-zinc-700 hover:bg-zinc-100",
          )}
        >
          <Mail className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="font-medium">All inboxes</span>
        </Link>
      </li>
      {accounts.map((a) => {
        const isActive = a.id === activeAccountId;
        const providerLabel = PROVIDER_LABELS[a.provider] ?? a.provider;
        return (
          <li key={a.id}>
            <Link
              href={hrefFor(a.id)}
              aria-current={isActive ? "page" : undefined}
              title={a.emailAddress}
              className={cn(
                "flex flex-col rounded-md px-2 py-1.5 text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
                isActive ? "bg-zinc-900 text-white" : "text-zinc-700 hover:bg-zinc-100",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "inline-block h-2 w-2 shrink-0 rounded-full",
                    isActive ? "bg-white" : "bg-zinc-400",
                  )}
                  aria-hidden="true"
                />
                <span className="truncate font-medium">{a.displayName ?? a.emailAddress}</span>
              </span>
              <span
                className={cn(
                  "ml-4 truncate text-xs",
                  isActive ? "text-zinc-300" : "text-zinc-500",
                )}
              >
                {a.displayName ? a.emailAddress : providerLabel}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
