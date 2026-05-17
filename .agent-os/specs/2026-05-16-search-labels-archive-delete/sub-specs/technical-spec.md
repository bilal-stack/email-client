# Technical Spec — Search, Labels, Archive, Delete

## Server Action shapes

All additive to `app/inbox/actions.ts`. All Zod-validated. All start with `await auth()` → return `{ ok: false, error: "Unauthorized" }` if no session.

```ts
const idArray = z.array(z.string().cuid()).min(1).max(500);

const searchThreadsInput = z.object({
  query: z.string().min(1).max(1024),
  accountId: z.string().cuid().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const mutateThreadsInput = z.object({ threadIds: idArray });

const setThreadLabelsInput = z.object({
  threadIds: idArray,
  add: z.array(z.string().max(256)).max(50).default([]),
  remove: z.array(z.string().max(256)).max(50).default([]),
});

const listLabelsInput = z.object({ accountId: z.string().cuid().optional() });
```

Returns are `{ ok: true; data: ... } | { ok: false; error: string }` matching the existing pattern.

## Ownership scoping pattern (applies to all mutate actions)

```ts
const rows = await prisma.thread.findMany({
  where: { id: { in: threadIds }, account: { userId } },
  select: {
    id: true,
    accountId: true,
    labels: true,
    messages: { select: { providerMessageId: true } },
  },
});
if (rows.length !== threadIds.length) {
  return { ok: false, error: "Forbidden: thread not owned" };
}
```

We reject the whole batch if any thread isn't owned (rather than silently filtering) — clearer security signal in the response.

## Optimistic local mutation + revert

```ts
// Snapshot
const snapshot = rows.map((r) => ({ id: r.id, prevLabels: r.labels as string[] }));

// Apply locally
await applyLabelsLocally(threadIds, userId, add, remove);

// Group by account, dispatch provider calls in parallel
const byAccount = groupBy(rows, (r) => r.accountId);
const results = await Promise.allSettled(
  Object.entries(byAccount).map(async ([accountId, group]) => {
    const provider = await getProviderForAccount(accountId);
    const messageIds = group.flatMap((r) => r.messages.map((m) => m.providerMessageId));
    await provider.setLabels(messageIds, add, remove); // or .archive / .trash
    return group.length;
  }),
);

// Revert any failed account's rows
const failedAccountIds = new Set<string>();
for (const [i, res] of results.entries()) {
  if (res.status === "rejected") {
    const accId = Object.keys(byAccount)[i]!;
    failedAccountIds.add(accId);
  }
}
if (failedAccountIds.size > 0) {
  const revertIds = rows
    .filter((r) => failedAccountIds.has(r.accountId))
    .map((r) => r.id);
  // Per-row revert using the snapshot
  for (const id of revertIds) {
    const prev = snapshot.find((s) => s.id === id)?.prevLabels ?? [];
    await prisma.thread.update({ where: { id }, data: { labels: prev as unknown as Prisma.InputJsonValue } });
  }
}

const updatedCount = results
  .filter((r) => r.status === "fulfilled")
  .reduce((acc, r) => acc + (r as PromiseFulfilledResult<number>).value, 0);
return { ok: true, data: { updatedCount } };
```

Partial success across accounts is preserved (the user sees what worked + an error if anything didn't).

## Local label transforms (`lib/db/inbox-mutations.ts`)

```ts
import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

const INBOX = "INBOX";
const TRASH = "TRASH";

export async function archiveLocally(threadIds: string[], userId: string) {
  // Remove INBOX from each thread's labels JSON; ownership-scoped.
  const rows = await prisma.thread.findMany({
    where: { id: { in: threadIds }, account: { userId } },
    select: { id: true, labels: true },
  });
  for (const r of rows) {
    const labels = (r.labels as string[]).filter((l) => l !== INBOX);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: labels as unknown as Prisma.InputJsonValue },
    });
  }
}

export async function trashLocally(threadIds: string[], userId: string) {
  const rows = await prisma.thread.findMany({
    where: { id: { in: threadIds }, account: { userId } },
    select: { id: true, labels: true },
  });
  for (const r of rows) {
    const next = new Set([...(r.labels as string[]).filter((l) => l !== INBOX), TRASH]);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: [...next] as unknown as Prisma.InputJsonValue },
    });
  }
}

export async function applyLabelsLocally(
  threadIds: string[],
  userId: string,
  add: string[],
  remove: string[],
) {
  const rows = await prisma.thread.findMany({
    where: { id: { in: threadIds }, account: { userId } },
    select: { id: true, labels: true },
  });
  for (const r of rows) {
    const set = new Set((r.labels as string[]).filter((l) => !remove.includes(l)));
    for (const a of add) set.add(a);
    await prisma.thread.update({
      where: { id: r.id },
      data: { labels: [...set] as unknown as Prisma.InputJsonValue },
    });
  }
}
```

## Inbox filter (`lib/db/inbox-queries.ts`)

The `labels` column is a Json array; SQLite doesn't natively query JSON-array containment via Prisma. Two options:

**Option A — filter in JS (chosen for MVP):**
```ts
const threads = await prisma.thread.findMany({ /* existing where + take */ });
const filtered = threads.filter((t) =>
  (t.labels as string[]).includes("INBOX"),
);
```
This loads `take: limit + 1` rows then filters. For an inbox of a few hundred threads, the cost is negligible. Postgres migration in `deploy-vercel` can switch to a `WHERE labels @> '["INBOX"]'` filter for speed if needed.

**Option B — `prisma.$queryRaw`** with SQLite's `json_each`. Faster but Prisma-bypass. **Defer to a later perf-pass spec.**

Choose A. Document in code comment.

## Keyboard hook (`lib/inbox/keyboard.ts`)

```ts
"use client";
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

export function useInboxKeyboard(opts: UseInboxKeyboardOpts) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable) return;
      const o = optsRef.current;
      const ids = o.rowIds;
      if (ids.length === 0) return;

      const targetIds = (): string[] => {
        const sel = o.selectedIds();
        return sel.length > 0 ? sel : [ids[Math.min(focusedIndex, ids.length - 1)]!];
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
          o.onOpen(ids[focusedIndex]!);
          e.preventDefault();
          break;
        case "x":
        case " ":
          o.onToggleSelect(ids[focusedIndex]!);
          e.preventDefault();
          break;
        case "e":
          o.onArchive(targetIds());
          e.preventDefault();
          break;
        case "#":
          o.onTrash(targetIds());
          e.preventDefault();
          break;
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
  }, [focusedIndex]);

  return { focusedIndex, setFocusedIndex };
}
```

## Selection store (`lib/inbox/selection-store.ts`)

```ts
"use client";
import { create } from "zustand";

interface SelectionState {
  selected: Set<string>;
  toggle: (id: string) => void;
  clear: () => void;
  selectMany: (ids: string[]) => void;
  has: (id: string) => boolean;
  asArray: () => string[];
}

export const useInboxSelection = create<SelectionState>((set, get) => ({
  selected: new Set<string>(),
  toggle: (id) =>
    set((s) => {
      const next = new Set(s.selected);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),
  clear: () => set({ selected: new Set() }),
  selectMany: (ids) => set({ selected: new Set(ids) }),
  has: (id) => get().selected.has(id),
  asArray: () => [...get().selected],
}));
```

## Search route shape

`app/inbox/search/page.tsx`:

```ts
export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: { searchParams: Promise<{ q?: string; account?: string }> }) {
  const session = await auth();
  if (!session?.user?.id) redirect("/signin");

  const { q = "", account } = await searchParams;
  if (!q.trim()) return <SearchEmptyState />;

  // Call the Server Action directly (server-component invocation).
  const result = await searchThreads({ query: q, accountId: account });
  if (!result.ok) return <SearchErrorState error={result.error} />;

  return (
    <div className="grid h-full grid-cols-1 md:grid-cols-[minmax(320px,400px)_1fr]">
      <section>
        {/* Reuse <ThreadList /> with the search results */}
        <ThreadList accountId={null} initial={{ threads: result.data.threads, nextCursor: result.data.nextCursor }} />
      </section>
      <section className="hidden items-center justify-center p-12 text-center md:flex">
        <SearchResultsHint count={result.data.threads.length} />
      </section>
    </div>
  );
}
```

## Provider-agnostic guarantee

- `app/inbox/**` — never imports `googleapis`, `@microsoft/microsoft-graph-client`, `imapflow`.
- All adapter calls go via `getProviderForAccount(accountId).{search|archive|trash|setLabels}`.
- The `security-reviewer` grep-checks for these imports + for `provider === "gmail"` branches in compose AND inbox trees.

## What's NOT changing

- No schema changes. `Draft`, `Thread`, `Message`, `Attachment` shapes stay.
- No new env vars.
- No new dependencies. (Zustand already installed; uses existing TanStack Query + shadcn primitives.)
