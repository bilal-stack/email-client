"use client";

// Minimal accessible checkbox. shadcn-style API but using a native <input>
// rather than Radix Checkbox to avoid pulling in another dep for the only
// use case (thread row selection + label popover).

import { cn } from "@/lib/utils";
import * as React from "react";

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type" | "onChange"> {
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type="checkbox"
        checked={checked}
        onChange={(e) => onCheckedChange?.(e.target.checked)}
        className={cn(
          "h-4 w-4 shrink-0 cursor-pointer rounded border border-zinc-300 bg-white",
          "text-zinc-900 accent-zinc-900",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900",
          "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    );
  },
);
Checkbox.displayName = "Checkbox";
