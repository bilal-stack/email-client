"use client";

// AI reply-draft panel. Mounted inside the composer (reply / reply-all /
// forward routes) above the TipTap editor. Provides a "AI draft" button that,
// on click, opens a three-tabbed panel and calls the `requestAIDraft` Server
// Action. Each tab consumes one of the three RSC streamables returned by the
// action and renders its progressive text.
//
// IMPORTANT: this is a client component. It must NEVER import
// `@anthropic-ai/sdk` or anything that does. The Server Action is the only
// boundary that touches the SDK; this file only handles the returned
// streamables via `useStreamableValue`.

import {
  requestAIDraft,
  type RequestAIDraftResult,
} from "@/app/inbox/[threadId]/draft-actions";
import { Button } from "@/components/ui/button";
import { type StreamableValue, useStreamableValue } from "ai/rsc";
import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export interface AIDraftPanelProps {
  threadId: string;
  mode: "reply" | "reply-all" | "forward";
  accountId: string;
  onPick: (text: string) => void;
  hasUnsavedManualEdits: boolean;
}

type Variant = "terse" | "friendly" | "detailed";

const VARIANTS: ReadonlyArray<{ id: Variant; label: string }> = [
  { id: "terse", label: "Terse" },
  { id: "friendly", label: "Friendly" },
  { id: "detailed", label: "Detailed" },
];

interface OkStreams {
  terseStream: StreamableValue<string>;
  friendlyStream: StreamableValue<string>;
  detailedStream: StreamableValue<string>;
}

type PanelState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; streams: OkStreams }
  | { status: "error"; message: string };

export function AIDraftPanel({
  threadId,
  mode,
  accountId,
  onPick,
  hasUnsavedManualEdits,
}: AIDraftPanelProps) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const [activeTab, setActiveTab] = useState<Variant>("terse");
  // Confirm-dialog target — the text the user wants to apply, pending confirm.
  const [pendingPickText, setPendingPickText] = useState<string | null>(null);

  const regionLabelId = useId();

  async function kickoff() {
    setState({ status: "loading" });
    let result: RequestAIDraftResult;
    try {
      result = await requestAIDraft({ threadId, mode, accountId });
    } catch {
      // The Server Action call itself failed (network, transport). The action
      // is designed to return a discriminated-union on failure, but the
      // `await` can still throw on transport-level errors.
      setState({
        status: "error",
        message: "Couldn't reach AI service. Try again.",
      });
      return;
    }
    if (!result.ok) {
      setState({ status: "error", message: result.error });
      return;
    }
    setState({
      status: "ready",
      streams: {
        terseStream: result.terseStream,
        friendlyStream: result.friendlyStream,
        detailedStream: result.detailedStream,
      },
    });
  }

  function handleOpen() {
    setOpen(true);
    setActiveTab("terse");
    void kickoff();
  }

  function handleClose() {
    setOpen(false);
    setState({ status: "idle" });
    setPendingPickText(null);
  }

  function attemptPick(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (hasUnsavedManualEdits) {
      setPendingPickText(text);
      return;
    }
    onPick(text);
    handleClose();
  }

  function confirmReplace() {
    if (pendingPickText !== null) {
      onPick(pendingPickText);
    }
    setPendingPickText(null);
    handleClose();
  }

  function cancelReplace() {
    setPendingPickText(null);
  }

  // Escape closes the panel (mirrors the X button). Skipped when the confirm
  // dialog is open — Escape should cancel that first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingPickText !== null) {
        cancelReplace();
      } else {
        handleClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // handleClose / cancelReplace are stable closures over setState only.
    // biome-ignore lint/correctness/useExhaustiveDependencies: see note above
  }, [open, pendingPickText]);

  // Trigger button (always rendered). The panel mounts below it when open.
  return (
    <div className="space-y-3">
      <div>
        <Button
          type="button"
          variant="outline"
          onClick={handleOpen}
          disabled={open}
          className="inline-flex items-center gap-2"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          AI draft
        </Button>
      </div>

      {open ? (
        <section
          role="region"
          aria-label="AI draft suggestions"
          aria-labelledby={regionLabelId}
          className="rounded-lg border border-zinc-200 bg-white shadow-sm"
        >
          <header className="flex items-center justify-between border-b border-zinc-200 px-3 py-2 sm:px-4">
            <h2
              id={regionLabelId}
              className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-900"
            >
              <Sparkles className="h-4 w-4" aria-hidden />
              AI draft suggestions
            </h2>
            <button
              type="button"
              onClick={handleClose}
              className="inline-flex h-11 w-11 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100"
              aria-label="Close AI draft panel"
            >
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="p-3 sm:p-4">
            {state.status === "loading" ? (
              <p className="inline-flex items-center gap-2 text-sm text-zinc-600">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Generating drafts…
              </p>
            ) : null}

            {state.status === "error" ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between"
              >
                <p className="leading-snug">{state.message}</p>
                <button
                  type="button"
                  onClick={() => void kickoff()}
                  className="inline-flex h-10 items-center justify-center self-start rounded-md border border-amber-300 bg-white px-3 text-sm font-medium text-amber-900 hover:bg-amber-100 sm:self-auto"
                >
                  Retry
                </button>
              </div>
            ) : null}

            {state.status === "ready" ? (
              <ReadyTabs
                streams={state.streams}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                onPick={attemptPick}
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {pendingPickText !== null ? (
        <ConfirmReplaceDialog
          onConfirm={confirmReplace}
          onCancel={cancelReplace}
        />
      ) : null}
    </div>
  );
}

interface ReadyTabsProps {
  streams: OkStreams;
  activeTab: Variant;
  onTabChange: (v: Variant) => void;
  onPick: (text: string) => void;
}

function ReadyTabs({ streams, activeTab, onTabChange, onPick }: ReadyTabsProps) {
  const tabRefs = useRef<Partial<Record<Variant, HTMLButtonElement | null>>>({});

  function focusTab(v: Variant) {
    const el = tabRefs.current[v];
    if (el) el.focus();
  }

  function handleTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const idx = VARIANTS.findIndex((v) => v.id === activeTab);
    if (idx < 0) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const next = VARIANTS[(idx + 1) % VARIANTS.length];
      if (next) {
        onTabChange(next.id);
        focusTab(next.id);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const prev = VARIANTS[(idx - 1 + VARIANTS.length) % VARIANTS.length];
      if (prev) {
        onTabChange(prev.id);
        focusTab(prev.id);
      }
    }
  }

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="Draft tone"
        className="flex w-full gap-1 border-b border-zinc-200"
      >
        {VARIANTS.map((v) => {
          const isActive = v.id === activeTab;
          return (
            <button
              type="button"
              key={v.id}
              ref={(el) => {
                tabRefs.current[v.id] = el;
              }}
              role="tab"
              aria-selected={isActive}
              aria-controls={`ai-draft-panel-${v.id}`}
              id={`ai-draft-tab-${v.id}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTabChange(v.id)}
              onKeyDown={handleTabKey}
              className={
                isActive
                  ? "border-b-2 border-zinc-900 px-3 py-2 text-sm font-medium text-zinc-900"
                  : "border-b-2 border-transparent px-3 py-2 text-sm font-medium text-zinc-500 hover:text-zinc-800"
              }
            >
              {v.label}
            </button>
          );
        })}
      </div>

      <VariantPanel
        variant="terse"
        stream={streams.terseStream}
        active={activeTab === "terse"}
        onPick={onPick}
      />
      <VariantPanel
        variant="friendly"
        stream={streams.friendlyStream}
        active={activeTab === "friendly"}
        onPick={onPick}
      />
      <VariantPanel
        variant="detailed"
        stream={streams.detailedStream}
        active={activeTab === "detailed"}
        onPick={onPick}
      />
    </div>
  );
}

interface VariantPanelProps {
  variant: Variant;
  stream: StreamableValue<string>;
  active: boolean;
  onPick: (text: string) => void;
}

function VariantPanel({ variant, stream, active, onPick }: VariantPanelProps) {
  const [text, error] = useStreamableValue(stream);
  const safeText = typeof text === "string" ? text : "";
  const hasText = safeText.trim().length > 0;

  return (
    <div
      role="tabpanel"
      id={`ai-draft-panel-${variant}`}
      aria-labelledby={`ai-draft-tab-${variant}`}
      hidden={!active}
      className="space-y-3"
    >
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          Draft generation failed. Please try again.
        </p>
      ) : hasText ? (
        <p className="whitespace-pre-wrap rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm leading-relaxed text-zinc-900">
          {safeText}
        </p>
      ) : (
        <ShimmerSkeleton />
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={() => onPick(safeText)}
          disabled={!hasText}
          className="min-h-[44px]"
        >
          Use this draft
        </Button>
      </div>
    </div>
  );
}

function ShimmerSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading draft"
      className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2"
    >
      <div className="h-3 w-11/12 animate-pulse rounded bg-zinc-200" />
      <div className="h-3 w-10/12 animate-pulse rounded bg-zinc-200" />
      <div className="h-3 w-7/12 animate-pulse rounded bg-zinc-200" />
    </div>
  );
}

interface ConfirmReplaceDialogProps {
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmReplaceDialog({ onConfirm, onCancel }: ConfirmReplaceDialogProps) {
  const labelId = useId();
  const descId = useId();
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onCancel}
      role="presentation"
    >
      <div
        // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop swallows clicks; Escape handled by the parent panel.
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        aria-describedby={descId}
        className="w-full max-w-md rounded-t-xl bg-white shadow-xl sm:rounded-xl"
      >
        <div className="space-y-3 px-4 py-4 sm:px-6 sm:py-5">
          <h3 id={labelId} className="text-base font-semibold text-zinc-900">
            Replace your current draft?
          </h3>
          <p id={descId} className="text-sm text-zinc-600">
            Your typed edits will be discarded.
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              className="min-h-[44px]"
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirm}
              className="min-h-[44px]"
            >
              Replace
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
