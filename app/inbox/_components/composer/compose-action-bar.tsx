"use client";

import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "queued-offline";

interface ComposeActionBarProps {
  saveStatus: SaveStatus;
  sending: boolean;
  canSend: boolean;
  canDiscard: boolean;
  onSend: () => void;
  onDiscard: () => void;
}

function saveLabel(s: SaveStatus): string {
  switch (s) {
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "error":
      return "Save failed";
    case "queued-offline":
      return "Queued offline";
    case "idle":
      return "";
  }
}

function saveClassName(s: SaveStatus): string {
  if (s === "error") return "text-xs text-red-600";
  if (s === "queued-offline") return "text-xs text-amber-600";
  return "text-xs text-zinc-500";
}

export function ComposeActionBar({
  saveStatus,
  sending,
  canSend,
  canDiscard,
  onSend,
  onDiscard,
}: ComposeActionBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-zinc-200 bg-white px-4 py-3">
      <Button type="button" onClick={onSend} disabled={!canSend || sending} aria-busy={sending}>
        {sending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Sending…</span>
          </>
        ) : (
          "Send"
        )}
      </Button>
      <Button type="button" variant="ghost" onClick={onDiscard} disabled={!canDiscard || sending}>
        Discard
      </Button>
      <span className={saveClassName(saveStatus)} aria-live="polite">
        {saveLabel(saveStatus)}
      </span>
    </div>
  );
}
