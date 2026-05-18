# Tasks

Ordered top to bottom. Each task is a discrete unit a single specialist agent can complete in one invocation.

## 1. Dependencies + `next.config.ts` integration — `ui-builder`
- `npm install --save-dev @serwist/next serwist` and `npm install --save idb`.
- Edit `next.config.ts` to wrap the config with `withSerwist({ swSrc: "app/sw.ts", swDest: "public/sw.js", disable: process.env.NODE_ENV === "development" })`. Read `next.config.ts` first; the wrapper is a higher-order config function.
- The Serwist plugin also injects `@serwist/next/middleware`-style headers — leave that to the plugin defaults; we don't need to customize.
- Add `public/sw.js` and `public/swe-worker-*.js` to `.gitignore` (they're build outputs).
- Run `npm run build` once locally to confirm the plugin wires cleanly with no errors. Don't commit the build artifacts.

## 2. Service worker source (`app/sw.ts`) — `ui-builder`
- New file with `serwist`'s default-export pattern. Read `https://serwist.pages.dev/docs` if needed for the exact API surface; the canonical shape is:
  ```ts
  import { defaultCache } from "@serwist/next/worker";
  import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
  import { Serwist } from "serwist";

  declare global {
    interface WorkerGlobalScope extends SerwistGlobalConfig {
      __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
    }
  }

  declare const self: ServiceWorkerGlobalScope;

  const serwist = new Serwist({
    precacheEntries: self.__SW_MANIFEST,
    skipWaiting: true,
    clientsClaim: true,
    navigationPreload: true,
    runtimeCaching: [
      // explicit override entries — see below
      ...defaultCache,
    ],
    fallbacks: {
      entries: [{ url: "/offline", matcher: ({ request }) => request.destination === "document" }],
    },
  });

  serwist.addEventListeners();
  ```
- Add four explicit runtime caches at the TOP of `runtimeCaching` (their order matters — first match wins):
  - **`api-auth-bypass`**: `{ matcher: ({ url }) => url.pathname.startsWith("/api/auth/"), handler: new NetworkOnly() }`. Bypasses every OAuth callback.
  - **`inbox-data`**: `{ matcher: ({ url, request }) => request.method === "GET" && url.pathname.startsWith("/api/inbox/"), handler: new StaleWhileRevalidate({ cacheName: "inbox-data" }) }`.
  - **`thread-bodies`**: `{ matcher: ({ url, request }) => request.method === "GET" && /^\/api\/inbox\/thread\/[a-z0-9]+$/.test(url.pathname), handler: new CacheFirst({ cacheName: "thread-bodies", plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 })] }) }`.
  - **`app-shell`**: `{ matcher: ({ request }) => request.destination === "document", handler: new NetworkFirst({ cacheName: "app-shell", networkTimeoutSeconds: 3 }) }`.
- THEN spread `defaultCache` for static assets + everything else.
- The `fallbacks` config makes failed `document` requests fall through to `/offline`.

## 3. GET mirror routes for the inbox Server Actions — `ui-builder`
- The SW can only cache GET responses. Server Actions are POSTs. Add two thin GET routes that mirror the relevant data the offline UI needs:
  - `app/api/inbox/list/route.ts` — `GET` that calls `listThreadsForUser(session.user.id, { accountId, sort })` from query params, returns JSON `{ threads, nextCursor }`. Same auth + Zod validation as the Server Action.
  - `app/api/inbox/thread/[id]/route.ts` — `GET` that calls `getThreadByIdForUser(session.user.id, id)`, returns the same DTO shape `getThread` returns.
- These routes are NOT a new public API — they exist solely for the SW to cache. The UI continues to call the Server Actions when online. ONLY the offline fallback path consumes them.
- Add `export const dynamic = "force-dynamic"` on both — they're per-user; we never want them statically cached.

## 4. Web App Manifest (`app/manifest.ts`) — `ui-builder`
- New file. Returns a `MetadataRoute.Manifest`. Fields:
  - `name`: `"Email Client"`.
  - `short_name`: `"Email"`.
  - `description`: a one-liner.
  - `start_url`: `"/inbox"`.
  - `display`: `"standalone"`.
  - `theme_color`: `"#18181b"` (zinc-900 — matches the existing palette).
  - `background_color`: `"#ffffff"`.
  - `icons`: array referencing the three `/icons/*.png` files committed in task 5.

## 5. Icon assets (`public/icons/*.png`) — `ui-builder`
- Generate three PNG icons:
  - `icon-192.png` — 192×192, opaque, flat color background with a single-letter glyph (e.g. "E" centered on `#18181b`).
  - `icon-512.png` — 512×512, same.
  - `icon-maskable-512.png` — 512×512 with the safe area inside an 80% inner circle (the maskable spec).
- Use a small Node script `scripts/generate-icons.ts` that renders the icons via the `canvas` package OR via `sharp`. **Or** if `canvas` / `sharp` install is fiddly on Windows, hand-craft a 64×64 SVG and use `sharp` only to rasterize to PNG. The script should be runnable via `npx tsx scripts/generate-icons.ts`. Commit the resulting PNGs; the script is a build artifact's source-of-truth.
- If install is genuinely painful, fall back to checking in pre-made PNGs and document the procedure in `scripts/generate-icons.README.md`. The eval reviewer doesn't need to regenerate the icons.

## 6. Offline fallback page (`app/offline/page.tsx`) — `ui-builder`
- Server component. Plain centered message: title "You're offline", subtitle "Your inbox is unavailable. Reconnect to continue.", a "Retry" button that triggers `window.location.reload()`.
- Mobile-responsive layout, no images / fancy assets.

## 7. Install prompt (`components/install-prompt.tsx`) — `ui-builder`
- Client component. State: `deferredPrompt: BeforeInstallPromptEvent | null`, `installed: boolean`.
- On mount, listen for `beforeinstallprompt`; `e.preventDefault()` + stash in state.
- Render: only when `deferredPrompt !== null && !installed`. A small "Install app" button (with a download icon from lucide-react).
- On click: `deferredPrompt.prompt()`; on the user's choice promise, set `installed = true` regardless.
- Persistence: write a `localStorage["install-prompt-dismissed"]` flag if the user closes / dismisses. Suppress the prompt for 30 days after dismissal.
- Mount in the inbox header (right-aligned, before the sort toggle on desktop; in the overflow menu on mobile).

## 8. Service worker registration (`components/register-sw.tsx` + `app/layout.tsx`) — `ui-builder`
- Client component. On mount, `if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production')` registers `/sw.js` with `scope: '/'`. Logs the registration result.
- Listen for `controllerchange` and reload the page once (so a freshly-activated SW takes over immediately on subsequent navigations).
- Add `<RegisterServiceWorker />` to `app/layout.tsx` body (or to a root-level client wrapper if one exists).

## 9. IndexedDB draft queue (`lib/offline/draft-queue.ts`) — `ui-builder`
- `idb`-backed module. Lazily-opened DB `"email-client-offline"`, version 1, store `"drafts"` keyed on `id` (cuid generated client-side).
- Exports:
  - `queueDraft(draft: OfflineDraft): Promise<string>` — generates an id if absent, writes, returns the id.
  - `listQueued(): Promise<OfflineDraft[]>` — returns all queued entries.
  - `removeQueued(id: string): Promise<void>`.
  - `clearQueued(): Promise<void>` — for sign-out / debug.
- `OfflineDraft` shape mirrors the `upsertDraft` Server Action's input plus `id`, `queuedAt: number`.
- Defensive: every read / write wraps in try/catch (Safari occasionally throws `InvalidStateError` during prerender); on any error log + skip rather than crash the composer.

## 10. Replay (`lib/offline/draft-replay.ts`) — `ui-builder`
- Module exports `installReplayListener(): () => void`. The teardown function unregisters the listener.
- On mount: register a `window.addEventListener("online", run)` AND trigger an initial `run()` call if `navigator.onLine === true && (await listQueued()).length > 0`.
- `run()` is debounced (single in-flight) and:
  - Iterates `listQueued()`.
  - For each: `await upsertDraft(draft)` (the existing Server Action).
  - On success → `removeQueued(id)`.
  - On `{ ok: false }` from the action — leave the queued entry in place (it'll retry on the next online event). Surface a toast / inline message after N consecutive failures (per-draft attempt counter in IDB).
- Wire `installReplayListener` from a root layout effect — a client component near `<RegisterServiceWorker />`.

## 11. Composer integration (`app/inbox/_components/composer/composer.tsx`) — `ui-builder`
- Read the current composer. The autosave logic is presumably a `useEffect` that calls `upsertDraft` after a debounce.
- Modify: if `!navigator.onLine` at the moment of save, call `queueDraft(...)` instead. Track the most recent queued draft's id in component state.
- A small "Queued offline" indicator near the existing autosave timestamp (replace the timestamp text when offline). On reconnect, the replay listener handles the round-trip; the composer doesn't need to know — the next online autosave reads the server `Draft` row authoritatively.
- If the user navigates away while offline, the queued draft survives — that's the entire point.

## 12. Offline-aware summary banner — `ui-builder`
- Modify `app/inbox/[threadId]/_components/summary-banner.tsx`. When the TanStack Query fails with a network-class error AND `navigator.onLine === false`, render a small "Summary unavailable offline" line in place of the banner. No retry button while offline (it'd hammer); the existing `online`-event listener naturally re-fetches.

## 13. Tests — `test-author` (minimal — load-bearing only)
Per `sub-specs/tests.md`:
- `lib/offline/draft-queue.test.ts`: round-trip a draft through `queueDraft` / `listQueued` / `removeQueued`. Cover: empty initial state, multi-draft listing order, removal idempotency.
- `lib/offline/draft-replay.test.ts`: replay calls `upsertDraft` for each queued; on success removes the entry; on failure leaves it in place.
- Skip the SW itself (Serwist's own test surface is mature; we'd be testing the framework). Skip Lighthouse — that's a manual smoke step at hand-off.
- Skip per-component render tests; manual smoke catches them.

## 14. Hand-off
- `security-reviewer` runs `/security-review`. Focus areas:
  - (a) SW does NOT cache `/api/auth/**`. NetworkOnly entry is FIRST in the runtime cache list.
  - (b) The two new GET mirror routes (`/api/inbox/list`, `/api/inbox/thread/[id]`) enforce the same `auth()` + ownership scope as the Server Actions they mirror.
  - (c) IndexedDB store name is per-origin, not per-user. On sign-out, `clearQueued` is called from the sign-out handler (add it if absent) so a subsequent user on the same device doesn't inherit drafts.
  - (d) No tokens, AI outputs, or thread bodies from OTHER users get cached. The user-scope enforcement happens at the route level; the cache key includes the request URL but the response is per-session.
  - (e) The install prompt + service worker don't introduce `dangerouslySetInnerHTML` anywhere.
- Manual smoke: run `npm run build && npm run start`, open Chrome, run Lighthouse PWA audit, verify ≥ 90. Toggle DevTools → Network → Offline, verify the inbox + a previously-opened thread render. Type a reply, close the tab, reconnect, reopen — verify the queued draft posted.
- On pass: bump `.claude/CURRENT_SPEC` to `.agent-os/specs/2026-05-18-deploy-vercel/spec.md`.
