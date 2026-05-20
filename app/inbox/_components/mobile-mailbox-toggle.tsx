"use client";

import { useEffect, useState } from "react";
import { Menu, Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { MailboxNavList, type MailboxNavAccount } from "@/app/inbox/_components/mailbox-nav-list";

interface MobileMailboxToggleProps {
  accounts: MailboxNavAccount[];
}

export function MobileMailboxToggle({ accounts }: MobileMailboxToggleProps) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams?.toString() ?? "";

  useEffect(() => {
    setOpen(false);
  }, [pathname, queryString]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 md:hidden"
        aria-expanded={open}
        aria-controls="mobile-mailbox-panel"
      >
        <Menu className="h-5 w-5" aria-hidden="true" />
        <span className="sr-only">Open mailboxes</span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute inset-x-0 top-0 h-full max-w-xs overflow-hidden bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Mailboxes</p>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-md text-zinc-700 transition hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900"
              >
                <X className="h-5 w-5" aria-hidden="true" />
                <span className="sr-only">Close mailboxes menu</span>
              </button>
            </div>
            <div className="h-full overflow-y-auto p-4">
              <MailboxNavList accounts={accounts} />
              <Link
                href="/signin?add=1"
                className="mt-4 inline-flex w-full items-center gap-2 rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-900"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Add mailbox</span>
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
