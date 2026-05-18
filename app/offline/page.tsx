import { OfflineRetryButton } from "./_components/retry-button";

/**
 * Offline fallback. The service worker routes any document request that
 * fails the network to this page (see `app/sw.ts` `fallbacks.entries`).
 */
export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-white px-6 py-12 text-zinc-900">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-2xl font-semibold tracking-tight">You're offline</h1>
        <p className="mt-3 text-sm text-zinc-500">
          Your inbox is unavailable. Reconnect to continue.
        </p>
        <div className="mt-6">
          <OfflineRetryButton />
        </div>
      </div>
    </main>
  );
}
