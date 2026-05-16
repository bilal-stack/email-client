"use client";

import { Button } from "@/components/ui/button";
import { Pencil } from "lucide-react";
import Link from "next/link";

/**
 * Inline button on `md+` (rendered in the header next to Sign out); floating
 * action button on `<md` (anchored to the bottom right above the safe area).
 * Both link to `/inbox/compose/new`.
 */
export function ComposeButton() {
  return (
    <>
      <Button asChild size="sm" className="hidden md:inline-flex">
        <Link href="/inbox/compose/new">
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Compose
        </Link>
      </Button>
      <Link
        href="/inbox/compose/new"
        aria-label="Compose new message"
        className="fixed bottom-6 right-6 z-30 inline-flex h-14 w-14 items-center justify-center rounded-full bg-zinc-900 text-white shadow-lg ring-1 ring-black/10 transition-colors hover:bg-zinc-800 md:hidden"
      >
        <Pencil className="h-5 w-5" aria-hidden="true" />
      </Link>
    </>
  );
}
