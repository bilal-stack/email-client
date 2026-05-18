# Tests — PWA Offline

`test-author` writes these alongside the build. **Minimal first-pass posture** — same eval-mode trade-off established throughout. The PWA layer is largely Serwist framework code (mature, well-tested upstream); our load-bearing surface is the IndexedDB queue + replay logic.

**No E2E in this spec.** The Lighthouse PWA audit at hand-off is the validation gate for the SW + manifest. Offline interaction tests in Playwright are technically possible (DevTools protocol allows `Network.emulateNetworkConditions`) but the value-to-effort ratio is poor for the eval timeline.

## What lands as code

### `lib/offline/draft-queue.test.ts` (NEW)
Uses `fake-indexeddb` to provide an in-memory IndexedDB in vitest's Node environment. Install as a devDep if not already present (`npm install --save-dev fake-indexeddb`). Import at top of the test file:
```ts
import "fake-indexeddb/auto";
```

- **Round-trip a draft**: `queueDraft(...)` returns an id; `listQueued()` returns the row; `removeQueued(id)` deletes it; final `listQueued()` returns `[]`.
- **Multi-draft ordering**: queue three drafts in sequence with sleeps to ensure distinct `queuedAt`; `listQueued()` returns them in chronological order.
- **Idempotent remove**: calling `removeQueued` on an id that was already removed (or never existed) does NOT throw.
- **`bumpAttempt` increments counter**: queue a draft, call `bumpAttempt(id)` twice, listQueued shows `attemptCount === 2`.
- **`clearQueued` empties the store**: queue 3, clearQueued, listQueued → `[]`.
- Skip tests for `getDb`'s SSR guard (the `typeof window === "undefined"` branch) — covered transitively by any caller; testing the guard against vitest's Node env is awkward.

### `lib/offline/draft-replay.test.ts` (NEW)
Mock `upsertDraft` from `@/app/inbox/compose/actions` at module boundary.

- **Replay calls `upsertDraft` for each queued + removes on success**: queue 2 drafts, mock `upsertDraft` to return `{ ok: true, data: { draftId: "x", updatedAt: new Date() } }`. Call `run()` (export it from the module via a test-only export, or invoke `installReplayListener` and trigger the `online` event). After: `upsertDraft` called twice, `listQueued()` returns `[]`.
- **Failed replay leaves the entry in IDB + bumps attempt count**: queue 1 draft, mock `upsertDraft` to return `{ ok: false, error: "..." }`. Call `run()`. After: the draft still in `listQueued()` with `attemptCount === 1`.
- **In-flight gate prevents concurrent runs**: call `run()` twice in quick succession with a slow-resolving `upsertDraft` mock. Assert `upsertDraft` was called only once across both `run()` invocations (the second `run()` short-circuits).
- Skip the `online` event listener wiring test — the `installReplayListener` return value (the unsubscribe function) is structural; not load-bearing.

### Manual smoke (NOT automated)
- `npm run build && npm run start`. Open Chrome on `http://localhost:3000/inbox`. DevTools → Application tab → Service Workers — verify `sw.js` is registered.
- Lighthouse PWA audit on `/inbox` → expect ≥ 90. (Categories: Installable, PWA Optimized, Fast & Reliable.)
- DevTools → Network → Offline. Refresh `/inbox` — the previously-loaded inbox renders.
- Open a thread that was previously visited (loaded into the `thread-bodies` cache) — bodies render.
- Open a thread that was NOT previously visited — fallback to `/offline` page.
- Type a reply in an open thread. Indicator shows "Queued offline".
- DevTools → Network → Online. Wait ~3s. Indicator returns to "Saved". Refresh — the server's `Draft` row reflects the queued content.

## What's NOT written

- SW unit tests — Serwist is upstream-tested. Our SW source is mostly declarative configuration; testing it would replicate Serwist's own suite.
- Manifest tests — the file returns a static object; the manifest is consumed by browsers, not our code.
- Composer integration tests — manual smoke validates the "Queued offline" indicator transitions.
- Install-prompt component test — the `beforeinstallprompt` event isn't easily synthesizable in vitest without heavy DOM mocking; manual smoke is the validation.
- Lighthouse-as-test — adds CI complexity (headless Chrome) without a corresponding eval-signal gain. Manual.

## Mocking strategy

- **`fake-indexeddb/auto`** at the top of `draft-queue.test.ts` provides an in-memory IDB shim. Fast, deterministic, no real DB.
- **`upsertDraft`** mocked at module boundary in the replay test: `vi.mock("@/app/inbox/compose/actions", () => ({ upsertDraft: vi.fn() }))`.
- **`navigator.onLine`**: not exercised in the unit tests (the replay test calls `run()` directly).
- **No real network** in any test.

## E2E (Playwright)

**N/A in this spec.** Manual smoke per the list above is the validation gate.
