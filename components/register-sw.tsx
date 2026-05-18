"use client";

import { useEffect, useRef } from "react";

/**
 * Registers `/sw.js` on mount in production. In dev the SW source isn't
 * emitted to `public/sw.js` (`disable` in `next.config.ts`), so we skip
 * registration entirely — the dev server stays free of any SW caching.
 *
 * Listens for `controllerchange` so a freshly-activated SW (after a deploy)
 * takes effect on the next page load. We reload exactly once via a ref
 * guard to avoid the classic `controllerchange` → reload → controllerchange
 * loop on Firefox.
 */
export function RegisterServiceWorker() {
  const reloadedRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    let cancelled = false;

    const onControllerChange = () => {
      if (reloadedRef.current) return;
      reloadedRef.current = true;
      window.location.reload();
    };

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        if (cancelled) return;
        // Log only the scope, not the full registration (which may contain
        // user-specific URLs in updateViaCache headers).
        console.info("[sw] registered", { scope: reg.scope });
      })
      .catch((e) => {
        console.warn("[sw] register failed", { name: (e as Error)?.name });
      });

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
