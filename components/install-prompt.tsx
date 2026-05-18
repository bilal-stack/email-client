"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";

/**
 * The `beforeinstallprompt` event isn't yet in the standard DOM types
 * (Chrome-only at the time of writing). We narrow it locally so the
 * Install button can call `prompt()` + read `userChoice`.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "install-prompt-dismissed";
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function dismissedRecently(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number.parseInt(raw, 10);
    if (!Number.isFinite(at)) return false;
    return Date.now() - at < DISMISS_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Captures the browser's `beforeinstallprompt` event, defers it, and
 * exposes a small Install button that fires the deferred prompt.
 *
 * Suppressed for 30 days after dismissal. Renders nothing on browsers
 * that don't fire the event (Safari, Firefox).
 */
export function InstallPrompt() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (dismissedRecently()) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || !event) return null;

  const onInstallClick = async () => {
    const current = event;
    setEvent(null); // The deferred event can only be used once.
    try {
      await current.prompt();
      const choice = await current.userChoice;
      if (choice.outcome === "dismissed") {
        try {
          window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
        } catch {
          /* best-effort */
        }
      } else {
        setInstalled(true);
      }
    } catch {
      // The browser already consumed the event — nothing to do.
    }
  };

  const onDismissClick = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* best-effort */
    }
    setEvent(null);
  };

  return (
    <div className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={onInstallClick}
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
        aria-label="Install app"
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Install app</span>
      </button>
      <button
        type="button"
        onClick={onDismissClick}
        className="text-xs text-zinc-400 hover:text-zinc-600"
        aria-label="Dismiss install prompt"
      >
        ×
      </button>
    </div>
  );
}
