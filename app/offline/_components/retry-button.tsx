"use client";

/**
 * Tiny client island for the offline page's Retry button. Server components
 * cannot bind `onClick`; isolating this keeps the rest of `/offline` static.
 */
export function OfflineRetryButton() {
  return (
    <button
      type="button"
      onClick={() => {
        if (typeof window !== "undefined") {
          window.location.reload();
        }
      }}
      className="inline-flex items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
    >
      Retry
    </button>
  );
}
