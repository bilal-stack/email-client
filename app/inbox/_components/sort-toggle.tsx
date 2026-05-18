"use client";

import { cn } from "@/lib/utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type SortValue = "priority" | "time";

const STORAGE_KEY = "inbox-sort";

function isSortValue(v: unknown): v is SortValue {
  return v === "priority" || v === "time";
}

/**
 * Two-state segmented control: Priority / Time.
 *
 * URL `?sort=` is the canonical source of truth — the server reads it via
 * `searchParams` and orders the list accordingly. `localStorage["inbox-sort"]`
 * is a soft layer: when the URL omits `sort`, the toggle visually reflects
 * the user's most recent local choice. On change we always write both.
 */
export function SortToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlSortRaw = searchParams?.get("sort");
  const urlSort: SortValue | null = isSortValue(urlSortRaw) ? urlSortRaw : null;

  // Display value. Starts from the URL on first render (server + client agree).
  // On mount, if the URL omits `sort`, we may upgrade the display to the
  // localStorage preference — this is purely cosmetic; the server already
  // returned its default-sorted page.
  const [display, setDisplay] = useState<SortValue>(urlSort ?? "priority");
  const hasHydrated = useRef(false);

  useEffect(() => {
    if (hasHydrated.current) return;
    hasHydrated.current = true;
    if (urlSort !== null) {
      // URL is canonical — sync display + persist as the user's preference.
      setDisplay(urlSort);
      try {
        window.localStorage.setItem(STORAGE_KEY, urlSort);
      } catch {
        // localStorage unavailable (private mode / quota) — non-fatal.
      }
      return;
    }
    // URL omits sort — fall back to local preference for the toggle display.
    // The server already rendered the priority-sorted page (the default), so
    // if the stored preference is "time" we leave the data alone and just
    // reflect the choice in the toggle until the user clicks something.
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isSortValue(stored)) setDisplay(stored);
    } catch {
      // ignore
    }
  }, [urlSort]);

  // Keep display in sync with the URL when it changes (e.g. back/forward).
  useEffect(() => {
    if (urlSort !== null && urlSort !== display) {
      setDisplay(urlSort);
    }
  }, [urlSort, display]);

  function selectSort(next: SortValue) {
    setDisplay(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.set("sort", next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const options: Array<{ value: SortValue; label: string }> = [
    { value: "priority", label: "Priority" },
    { value: "time", label: "Time" },
  ];

  return (
    <div
      role="radiogroup"
      aria-label="Sort threads by"
      className="inline-flex w-full rounded-md border border-zinc-200 bg-white p-0.5 sm:w-auto"
    >
      {options.map((opt, idx) => {
        const isSelected = display === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            tabIndex={isSelected ? 0 : -1}
            onClick={() => selectSort(opt.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                const other = options[1 - idx];
                if (other) selectSort(other.value);
              } else if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                selectSort(opt.value);
              }
            }}
            className={cn(
              "inline-flex h-7 flex-1 items-center justify-center rounded px-3 text-xs font-medium transition-colors sm:flex-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus-visible:ring-offset-1",
              isSelected
                ? "bg-zinc-900 text-white"
                : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
