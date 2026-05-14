import { cn } from "@/lib/utils";
import * as React from "react";

export interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  src?: string | null;
  alt?: string;
  fallback?: string;
}

export const Avatar = React.forwardRef<HTMLDivElement, AvatarProps>(
  ({ src, alt, fallback, className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "relative inline-flex h-9 w-9 shrink-0 overflow-hidden rounded-full bg-zinc-200 text-sm font-medium text-zinc-700",
          className,
        )}
        {...props}
      >
        {src ? (
          <img src={src} alt={alt ?? ""} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-full w-full items-center justify-center">
            {(fallback ?? alt ?? "?").slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>
    );
  },
);
Avatar.displayName = "Avatar";
