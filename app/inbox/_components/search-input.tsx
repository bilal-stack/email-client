"use client";

import { cn } from "@/lib/utils";
import { useRouter, useSearchParams } from "next/navigation";
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

export interface SearchInputHandle {
  focus: () => void;
}

interface SearchInputProps {
  className?: string;
}

/**
 * Search input mounted in the inbox layout header. Pre-populates from `?q=`
 * when on the search route. Pressing Enter navigates to `/inbox/search?q=...`
 * via `router.push`. Exposes `focus()` via ref so the inbox keyboard hook
 * can focus it with the `/` shortcut.
 */
export const SearchInput = forwardRef<SearchInputHandle, SearchInputProps>(({ className }, ref) => {
  const router = useRouter();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = value.trim();
      if (trimmed.length === 0) return;
      router.push(`/inbox/search?q=${encodeURIComponent(trimmed)}`);
    } else if (e.key === "Escape") {
      inputRef.current?.blur();
    }
  };

  return (
    <input
      ref={inputRef}
      type="search"
      aria-label="Search mail"
      placeholder="Search mail   ( / )"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      className={cn(
        "w-full max-w-md rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5",
        "text-sm text-zinc-900 placeholder:text-zinc-500",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
        "focus-visible:ring-offset-2 focus-visible:border-zinc-900",
        className,
      )}
    />
  );
});
SearchInput.displayName = "SearchInput";
