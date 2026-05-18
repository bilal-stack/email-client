# Database Schema — PWA Offline

**No Prisma schema changes in this spec.**

The IndexedDB store `email-client-offline > drafts` is a client-side queue, not a database. Schema lives in `lib/offline/draft-queue.ts` as a TypeScript interface (`OfflineDraft`). The store is per-origin and managed entirely in browser code — no migration runner, no server-side reflection.

## Why IndexedDB and not the Prisma `Draft` table

Two reasons:

1. **Offline-only is an in-browser concern.** When the user types offline, there is by definition no server reachable. The `Draft` table is on the server; we can't write to it. IndexedDB is the only durable client-side store with enough capacity to hold rich-text bodies.
2. **The server `Draft` row stays the source of truth.** Once the replay path posts the queued draft via `upsertDraft`, the server creates/updates a `Draft` row and the client re-reads it via the normal autosave path. The IndexedDB entry is removed on success. **The two stores are never both authoritative at the same time** — queued offline OR persisted on the server, never both with conflicting state.

## Capacity + lifecycle

- Each queued draft is a few KB to tens of KB (rich-text body up to ~2 MB cap per the Zod schema in `upsertDraft`).
- Mobile Safari quota: ~50 MB per origin. Even 200 large drafts fits comfortably.
- Lifecycle: created when `navigator.onLine === false` AND the composer's autosave fires. Removed on a successful `upsertDraft` replay, OR on user-initiated `clearQueued()` (sign-out, or "discard offline drafts" debug action).
- An `attemptCount` field per row tracks consecutive failed replay attempts. The UI surfaces a warning when any draft passes N=5 (the threshold is in the spec's risk discussion; not enforced by the queue itself).

## What does NOT go in IndexedDB

- Tokens or any `MailAccount` rows — the secret blob is server-only.
- Other users' data — the IndexedDB origin is the same across users on a shared device, BUT the sign-out handler calls `clearQueued()` to flush the queue before another user signs in.
- Anthropic API outputs — the AI summary / draft / prioritization rows live in the Prisma DB only.
- Email thread bodies — those are cached in the Service Worker's `thread-bodies` Cache Storage, NOT IndexedDB. Cache Storage is a separate origin-scoped resource with its own quota.

## Out of scope (recap)

- A per-user IndexedDB database name (`email-client-offline-{userId}`) — premature; the `clearQueued()` on sign-out is the simpler safe path. If multi-user-per-device becomes a common scenario, a future spec adds the partition.
- Schema versioning beyond v1 — the `idb` upgrade handler is wired so a v2 schema is a one-line addition.
- Cross-device sync of offline drafts — the queue is per-device by design. The server `Draft` row is the cross-device surface.
