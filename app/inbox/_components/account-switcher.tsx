"use client";

import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export interface AccountChip {
  id: string;
  emailAddress: string;
  displayName: string | null;
}

interface AccountSwitcherProps {
  accounts: AccountChip[];
  active: string | null;
}

export function AccountSwitcher({ accounts, active }: AccountSwitcherProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function setAccount(id: string | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (id) params.set("account", id);
    else params.delete("account");
    const qs = params.toString();
    startTransition(() => {
      router.push(qs ? `/inbox?${qs}` : "/inbox");
    });
  }

  const chips: Array<{ id: string | null; label: string; sublabel?: string }> = [
    { id: null, label: "All inboxes" },
    ...accounts.map((a) => ({
      id: a.id,
      label: a.displayName ?? a.emailAddress,
      sublabel: a.displayName ? a.emailAddress : undefined,
    })),
  ];

  return (
    <div
      role="tablist"
      aria-label="Filter by account"
      className="flex flex-wrap gap-2"
      aria-busy={isPending}
    >
      {chips.map((c) => {
        const isActive = c.id === active;
        return (
          <button
            key={c.id ?? "all"}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => setAccount(c.id)}
            className={cn(
              "inline-flex min-h-[44px] items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-2",
              isActive
                ? "border-zinc-900 bg-zinc-900 text-white ring-1 ring-zinc-900"
                : "border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50",
            )}
          >
            <span className="font-medium">{c.label}</span>
            {c.sublabel ? (
              <span
                className={cn(
                  "hidden text-xs sm:inline",
                  isActive ? "text-zinc-300" : "text-zinc-500",
                )}
              >
                {c.sublabel}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
