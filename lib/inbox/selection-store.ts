"use client";

// Client-only Zustand slice for the inbox's multi-select state. Used by the
// thread row checkboxes, the bulk action toolbar, and the keyboard `x`
// shortcut. Selections are NOT persisted across page reloads — that's
// deliberate; bulk actions are short-lived intents.

import { create } from "zustand";

interface SelectionState {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  selectMany: (ids: string[]) => void;
  has: (id: string) => boolean;
  asArray: () => string[];
  size: number;
}

export const useInboxSelection = create<SelectionState>((set, get) => ({
  selected: new Set<string>(),
  size: 0,
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next, size: next.size };
    }),
  clear: () => set({ selected: new Set(), size: 0 }),
  selectMany: (ids) => {
    const next = new Set(ids);
    set({ selected: next, size: next.size });
  },
  has: (id) => get().selected.has(id),
  asArray: () => [...get().selected],
}));
