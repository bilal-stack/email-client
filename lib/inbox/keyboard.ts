"use client";

// Inbox keyboard-shortcut hook. Captures `keydown` on `document` and dispatches
// to the inbox's actions (open thread, archive, trash, select, focus search).
// Deliberately ignores events whose target is an `<input>`, `<textarea>`, or
// `[contenteditable]` element — so the composer and search input keep working
// normally.

import { useEffect, useRef, useState } from "react";

interface UseInboxKeyboardOpts {
  rowIds: string[];
  onOpen: (id: string) => void;
  onArchive: (ids: string[]) => void;
  onTrash: (ids: string[]) => void;
  onToggleSelect: (id: string) => void;
  onClearSelection: () => void;
  onFocusSearch: () => void;
  selectedIds: () => string[];
}

export function useInboxKeyboard(opts: UseInboxKeyboardOpts): {
  focusedIndex: number;
  setFocusedIndex: (n: number) => void;
} {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const focusedRef = useRef(focusedIndex);
  focusedRef.current = focusedIndex;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      const o = optsRef.current;
      const ids = o.rowIds;
      if (ids.length === 0) return;

      const focused = focusedRef.current;
      const safeFocused = Math.min(Math.max(focused, 0), ids.length - 1);
      const focusedId = ids[safeFocused];
      const targetIds = (): string[] => {
        const sel = o.selectedIds();
        if (sel.length > 0) return sel;
        return focusedId ? [focusedId] : [];
      };

      switch (e.key) {
        case "j":
          setFocusedIndex((i) => Math.min(i + 1, ids.length - 1));
          e.preventDefault();
          break;
        case "k":
          setFocusedIndex((i) => Math.max(i - 1, 0));
          e.preventDefault();
          break;
        case "Enter":
          if (focusedId) o.onOpen(focusedId);
          e.preventDefault();
          break;
        case "x":
        case " ":
          if (focusedId) o.onToggleSelect(focusedId);
          e.preventDefault();
          break;
        case "e": {
          const ids = targetIds();
          if (ids.length > 0) o.onArchive(ids);
          e.preventDefault();
          break;
        }
        case "#": {
          const ids = targetIds();
          if (ids.length > 0) o.onTrash(ids);
          e.preventDefault();
          break;
        }
        case "/":
          o.onFocusSearch();
          e.preventDefault();
          break;
        case "Escape":
          o.onClearSelection();
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return { focusedIndex, setFocusedIndex };
}
