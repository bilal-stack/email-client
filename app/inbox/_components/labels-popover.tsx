"use client";

// Labels popover. Lazy-fetches the user's existing labels when opened, lets
// them check/uncheck across a set of threads, computes the add/remove diff
// against the union of currently-applied labels, and applies via
// `setThreadLabels`. Closes on success.
//
// `currentLabels` can be passed by the caller when it already has the data on
// hand (e.g. a single-thread view that loaded the thread's labels). Otherwise
// the popover lazy-fetches the union of labels across `threadIds` when it
// opens — without that seed, the diff would only ever produce additions and
// bulk-remove via the UI would be impossible.

import { getLabelsForThreads, listAvailableLabels, setThreadLabels } from "@/app/inbox/actions";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { Loader2, Tag } from "lucide-react";
import { useEffect, useState, useTransition } from "react";

interface LabelsPopoverProps {
  threadIds: string[];
  /**
   * Labels currently applied to ANY of the selected threads — used to seed
   * checkbox state. If omitted, the popover fetches the union itself when it
   * first opens.
   */
  currentLabels?: string[];
  onApplied?: () => void;
  className?: string;
}

export function LabelsPopover({
  threadIds,
  currentLabels,
  onApplied,
  className,
}: LabelsPopoverProps) {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] = useState<string[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [seedLabels, setSeedLabels] = useState<string[] | null>(currentLabels ?? null);
  const [loadingSeed, setLoadingSeed] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Lazy-fetch the user's available labels the first time the popover opens.
  useEffect(() => {
    if (!open || available !== null || loadingList) return;
    setLoadingList(true);
    listAvailableLabels({})
      .then((result) => {
        if (result.ok) setAvailable(result.data.labels);
        else setError(result.error);
      })
      .finally(() => setLoadingList(false));
  }, [open, available, loadingList]);

  // If the caller didn't pass currentLabels, lazy-fetch the union across the
  // selected threads when the popover opens. This is what makes bulk-remove
  // possible: without a seed, every "applied" label would look unchecked and
  // the diff would only ever produce additions.
  useEffect(() => {
    if (!open) return;
    if (currentLabels !== undefined) {
      setSeedLabels(currentLabels);
      return;
    }
    if (seedLabels !== null || loadingSeed || threadIds.length === 0) return;
    setLoadingSeed(true);
    getLabelsForThreads({ threadIds })
      .then((result) => {
        if (result.ok) setSeedLabels(result.data.labels);
        else setError(result.error);
      })
      .finally(() => setLoadingSeed(false));
  }, [open, currentLabels, seedLabels, loadingSeed, threadIds]);

  // Seed the checkbox state once we have the labels for the current selection.
  useEffect(() => {
    if (open && seedLabels !== null) setChecked(new Set(seedLabels));
  }, [open, seedLabels]);

  const toggle = (label: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const apply = () => {
    if (threadIds.length === 0) return;
    setError(null);
    const initial = new Set(seedLabels ?? []);
    const add = [...checked].filter((l) => !initial.has(l));
    const remove = [...initial].filter((l) => !checked.has(l));
    if (add.length === 0 && remove.length === 0) {
      setOpen(false);
      return;
    }
    startTransition(async () => {
      const result = await setThreadLabels({ threadIds, add, remove });
      if (result.ok) {
        setOpen(false);
        onApplied?.();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div className={cn("relative inline-block", className)}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Tag className="h-4 w-4" aria-hidden="true" />
        <span>Labels</span>
      </Button>
      {open ? (
        // biome-ignore lint/a11y/useSemanticElements: a non-modal popover; <dialog> would force focus-trapping semantics we don't want here.
        <div
          role="dialog"
          aria-label="Apply labels"
          className="absolute right-0 z-20 mt-1 w-64 rounded-md border border-zinc-200 bg-white p-2 shadow-md"
        >
          {loadingList || loadingSeed ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-zinc-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              <span>Loading labels…</span>
            </div>
          ) : !available || available.length === 0 ? (
            <p className="px-2 py-3 text-sm text-zinc-500">No labels yet.</p>
          ) : (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {available.map((label) => (
                <li key={label}>
                  {/* biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox child renders a real <input>; Biome can't see through the custom component. */}
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-50">
                    <Checkbox checked={checked.has(label)} onCheckedChange={() => toggle(label)} />
                    <span className="truncate">{label}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          {error ? (
            <p role="alert" className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
              {error}
            </p>
          ) : null}
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-zinc-100 pt-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={apply} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>Applying…</span>
                </>
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
