"use client";

import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import * as React from "react";
import { useFormStatus } from "react-dom";

/**
 * Submit button wired to React 19's `useFormStatus` — disables itself and shows
 * a spinner while the parent `<form action={serverAction}>` is pending. Use
 * instead of plain `<Button type="submit">` whenever a form posts to a Server
 * Action that takes more than ~100ms (OAuth redirects, DB writes, anything
 * network-bound).
 */
export const SubmitButton = React.forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, "type"> & { pendingLabel?: string }
>(({ children, pendingLabel, disabled, className, ...props }, ref) => {
  const { pending } = useFormStatus();
  return (
    <Button
      ref={ref}
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending}
      className={cn(className)}
      {...props}
    >
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>{pendingLabel ?? children}</span>
        </>
      ) : (
        children
      )}
    </Button>
  );
});
SubmitButton.displayName = "SubmitButton";
