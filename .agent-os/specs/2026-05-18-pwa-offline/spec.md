# PWA Offline

## Goal
Ship the first Phase 5 spec: turn the inbox into an installable Progressive Web App with sensible offline behavior. After this lands, a user can (a) install the app to their home screen / dock; (b) open the app while offline and see the last-synced inbox + previously-opened threads from cache; (c) type a draft offline and have it queued in IndexedDB, then replayed automatically when the connection returns. The PWA shell is driven by **Serwist** (the maintained successor to Workbox-via-next-pwa). The service worker caches the app shell + static assets, the user's last inbox-list response, and the bodies of any threads they've opened in the current session. The Inbox / Compose UI remain functional offline — they show what they have, mark missing data clearly, and (for compose) queue intent for replay. The `Draft` row autosave path stays the source of truth on reconnect; the IndexedDB queue is a transient store, not a parallel database. **No new specs unlock from this** — `deploy-vercel` is next regardless, and this work is mostly orthogonal to the provider / AI features.

## User stories
1. **As a user**, I install the app to my mobile home screen (via the browser's "Add to Home Screen" prompt). It opens full-screen, no browser chrome.
2. **As a user offline**, I open the app and see the inbox I had loaded before going offline — threads, summaries, the priority chip — without an error page.
3. **As a user offline**, I open a thread I had visited before. The full message bodies and AI summary render from cache.
4. **As a user offline**, I open a thread I had NOT previously visited. The UI shows a clear "Offline — can't load this thread" state with a retry affordance (not a generic 500 page).
5. **As a user offline**, I type a reply. The composer's autosave still fires, but the request goes to a service-worker-managed offline queue (IndexedDB) rather than failing. When I come back online, queued drafts post to the server and the regular `Draft` row replaces the queued copy.
6. **As a user**, when I open a thread that has a previously-queued offline draft, the composer hydrates from the queued copy until the server replay confirms — then transparently swaps to the server's `Draft` row.
7. **As an eval reviewer**, the manifest + service worker + install prompt all work in Chrome's Lighthouse audit at PWA score ≥ 90.

## Non-goals
- **No offline AI features.** Summary banner / AI draft panel / prioritization chip all degrade gracefully offline (banner shows a single line "Summary unavailable offline"; the AI draft button is disabled; existing priority chips still render from cache). We do NOT bundle a local model.
- **No offline send.** Sending mail requires the provider — we queue the draft for replay-as-draft, not for replay-as-send. The user re-clicks Send after reconnect.
- **No partial offline sync.** We don't re-implement Inngest sync in the service worker. Mail still arrives via the existing 60s cron path when the user is online; service worker just serves the last-cached page when offline.
- **No background sync API** (registerSync / periodicSync). Both have spotty browser support and require additional permissions; we rely on SSE-on-reconnect to drive UI refresh.
- **No conflict-resolution UI for offline drafts.** If the user typed offline and the same thread received a server-side draft update from another tab / device, the local queue replay overwrites (last-writer-wins). Documented as a known limitation.
- **No push notifications.** Web Push is a stretch goal per the roadmap.
- **No mobile app wrapper.** This is a PWA, not React Native / Capacitor.
- **No HTTP/2 push or preloading optimizations.** Stretch.
- **No analytics or telemetry on offline use.**
- **No service worker for the `(auth)/*` routes.** Sign-in flows go through the network unconditionally — caching OAuth callbacks is dangerous and they're rare enough that the cost is acceptable.

## In-scope surfaces
- **`next.config.ts`** — wire Serwist via `@serwist/next`'s `withSerwist`. Source service worker at `app/sw.ts`, output at `public/sw.js`. Disable in dev (the dev experience is fine without a SW; we ship + test only the prod build for PWA verification).
- **`app/sw.ts`** — new file. The custom service worker. Imports the Serwist defaults, declares a `Serwist` instance with `precacheEntries` from the bundler manifest, and adds runtime caches:
  - `app-shell` (`CacheFirst`) for `/`, `/inbox`, `/inbox/[threadId]` HTML responses.
  - `static-assets` (`CacheFirst`) for `/_next/static/**` + `/icons/**`.
  - `inbox-data` (`StaleWhileRevalidate`) for `GET /api/inbox/*` Server-Action responses — Next.js Server Actions are POSTs internally, so the relevant cacheable surface is the inbox-list endpoint(s) and any explicit GET routes we add for PWA support (a new `app/api/inbox/list/route.ts` minimal mirror of `listThreads` may be the cleanest path; see technical-spec).
  - `thread-bodies` (`CacheFirst` with a 7-day TTL + max 50 entries) for thread-body fetches.
  - Network-first for everything else; fall through to offline fallback page on full failure.
- **`app/manifest.ts`** — new file. Returns a Web App Manifest via Next.js's Metadata API: name, short_name, theme color, background color, display `standalone`, start_url `/inbox`, icons (`/icons/icon-192.png`, `/icons/icon-512.png`, plus a maskable variant).
- **`public/icons/*.png`** — three icons committed: 192×192, 512×512, 512×512 maskable. Generated from a simple wordmark — we don't ship an elaborate design system asset; a flat colored square with the app initial is enough for the eval. **(In-scope deliverable: the icons themselves, even if hand-rolled or generated via a single-file Node script that paints to a canvas.)**
- **`app/offline/page.tsx`** — new route. The offline fallback page the SW falls back to when nothing else matches. Plain message, a single "Retry" button.
- **`components/install-prompt.tsx`** — new client component. Listens for `beforeinstallprompt`, defers the event, exposes a small "Install" button in the inbox header (right side, mobile-prominent). One-shot UI — disappears after the user installs or dismisses.
- **`lib/offline/draft-queue.ts`** — new module. Thin IndexedDB wrapper using `idb` for the queued offline drafts. Schema: `OfflineDraft { id, accountId, threadId | null, mode, to, cc, bcc, subject, bodyHtml, inReplyTo, references, queuedAt }`. CRUD: `queueDraft(draft)`, `listQueued()`, `removeQueued(id)`, `clearQueued()`. Used by the composer's autosave path when `navigator.onLine === false` AND by the replay path that runs on the `online` event.
- **`lib/offline/draft-replay.ts`** — new module. On `window.online`, iterates `listQueued`, calls the existing `upsertDraft` Server Action for each, removes the queued entry on success. Runs at most once per `online` transition (debounced).
- **`app/inbox/_components/composer/composer.tsx`** — modify. Wrap the autosave logic: if `navigator.onLine === false`, push to `queueDraft` instead of (or in addition to — see technical-spec) the Server Action. A small "Queued offline" indicator near the autosave timestamp.
- **`app/inbox/[threadId]/_components/summary-banner.tsx`** — modify. When the TanStack Query fails with a network error AND the user is offline, render a "Summary unavailable offline" placeholder. Don't hammer retry.
- **`app/layout.tsx`** — modify. Register the service worker via a small client component (`<RegisterServiceWorker />`) mounted in the root layout. Also add the manifest link via the Metadata API.
- **`package.json`** — add `@serwist/next` + `serwist` + `idb` dev deps.

## Risks / open questions
1. **Stale auth tokens on reconnect.** A user's OAuth access token can expire while they're offline. When the replay runs, the next `upsertDraft` may trigger a token refresh, which can fail if the refresh token has rotated (MS) or been revoked. *Mitigation:* the canonical error from `canonicalizeProviderError` already covers this — the queued draft stays in IndexedDB until the user reconnects their account, at which point the next online tick retries the replay. Worst case: queued drafts sit in IDB indefinitely; we surface them in the composer as "Pending offline drafts (N)" so the user can manually inspect / discard.
2. **`navigator.onLine` is famously unreliable.** It only reflects whether the OS has any network connection, not whether our server is reachable. *Mitigation:* treat `onLine === false` as "queue locally"; on `online` events fire the replay AND let the regular Server Action retry happen naturally (a still-broken backend just leaves the queue intact for the next online event). We don't probe with a ping endpoint — overkill.
3. **Service-worker scoping.** Serwist registers at `/`; the worker controls every route under the origin. We need the `(auth)/*` flows to bypass the SW for OAuth callbacks. *Mitigation:* explicit allow-list in the SW that NetworkOnly's any path starting with `/api/auth/`. Sign-in pages can be NetworkOnly too — there's no offline use case for signing in.
4. **Server-Action responses are POSTs, hard to cache.** Next.js Server Actions go through a POST to the route's path with a special header. The SW can't safely cache POST responses (semantic violation). *Mitigation:* add explicit `GET /api/inbox/list?accountId=&sort=` and `GET /api/inbox/thread/:id` route handlers that mirror the relevant Server Actions for PWA cache purposes. The UI continues to call the Server Actions when online (they have richer error shapes); the SW falls back to the GET routes only when the Server Action fails offline. Two cached surfaces, one user-visible flow.
5. **IndexedDB quota.** Mobile Safari is the tightest at ~50 MB. Our queue stores drafts (rich-text bodies — tens of KB each); even 100 drafts is well within budget. *Mitigation:* no eviction in v1; the replay path clears entries on success. If a queue grows to 50 entries we surface a warning chip; if it exceeds 200 we stop accepting new entries and require manual cleanup.
6. **Service worker update on deploy.** A SW that holds a stale precache after a new app deploy can serve stale HTML indefinitely. *Mitigation:* the precache is keyed on Serwist's build-time manifest hash; new builds invalidate. We additionally call `self.skipWaiting()` + `self.clients.claim()` in the activate handler so the new SW takes over on next page load without requiring two-reloads. The trade-off — a user on an open tab can briefly see a mix of old + new chunks during the swap — is acceptable for an MVP.
7. **Lighthouse PWA audit needs HTTPS in production.** Localhost is treated as a secure context, so dev passes. On `deploy-vercel` we automatically get HTTPS; nothing to do here. Just calling it out so the audit step at hand-off doesn't surprise anyone.

## Definition of done
- [ ] `app/sw.ts`, `app/manifest.ts`, `app/offline/page.tsx` exist; `next.config.ts` wires `withSerwist`.
- [ ] `public/icons/{icon-192,icon-512,icon-maskable-512}.png` are committed (any reasonable single-color flat asset).
- [ ] In a production build (`npm run build && npm run start`), Chrome registers the service worker, the manifest is parsed, "Install" appears in the address bar, and Lighthouse's PWA audit scores ≥ 90.
- [ ] Going offline (DevTools → Network → Offline) and navigating to `/inbox` shows the previously-loaded threads, not an error page.
- [ ] Going offline and opening a thread that was previously cached shows its bodies + summary chip.
- [ ] Going offline and opening a thread that was NOT previously cached shows the canonical offline-fallback state.
- [ ] Offline composer: typing in the reply view queues to IndexedDB; the "Queued offline" indicator appears.
- [ ] Coming back online: the queued draft replays into the server's `Draft` table within ~2 seconds; the indicator disappears.
- [ ] `<InstallPrompt />` button appears on supported browsers and triggers the native install flow.
- [ ] No service worker registered in dev mode (`npm run dev`).
- [ ] `security-reviewer` PASS — focus on (a) SW scope excludes `/api/auth/**`, (b) no token-bearing responses cached, (c) IndexedDB only holds the user's own draft content (no other-user data via shared origin in a multi-user device — `clearQueued` runs on sign-out).
- [ ] `.claude/CURRENT_SPEC` advanced to `.agent-os/specs/2026-05-18-deploy-vercel/spec.md`.
