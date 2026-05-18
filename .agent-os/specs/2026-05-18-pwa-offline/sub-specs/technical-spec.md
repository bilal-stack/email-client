# Technical Spec — PWA Offline

## Why Serwist (not `next-pwa`)

`next-pwa` is the historical pick but unmaintained — last release pre-Next-15 and incompatible with the App Router's RSC streaming. **Serwist** is the maintained successor by the same author, written specifically for the App Router, with first-class support for `next.config.ts`-based config and the `app/sw.ts` source convention. The package map: `@serwist/next` (the Next.js plugin wrapper) + `serwist` (the runtime / cache strategies). Both are already locked by tech-stack.md.

## `next.config.ts` wrap

```ts
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

const baseConfig: NextConfig = { /* existing settings */ };

export default withSerwist(baseConfig);
```

`disable: true` in dev means the SW source is type-checked but never built into `public/sw.js` during `npm run dev`. The Next.js dev server's HMR + RSC streaming continues unimpeded.

## Service worker (`app/sw.ts`)

```ts
import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import {
  CacheFirst,
  ExpirationPlugin,
  NetworkFirst,
  NetworkOnly,
  Serwist,
  StaleWhileRevalidate,
} from "serwist";

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
  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
  runtimeCaching: [
    // 1. Auth bypass — MUST be first. OAuth callbacks must never be cached.
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/auth/"),
      handler: new NetworkOnly(),
    },

    // 2. Thread-body GET mirror — long-lived, capped.
    {
      matcher: ({ url, request }) =>
        request.method === "GET" &&
        /^\/api\/inbox\/thread\/[a-z0-9]+$/i.test(url.pathname),
      handler: new CacheFirst({
        cacheName: "thread-bodies",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 50,
            maxAgeSeconds: 7 * 24 * 60 * 60,
          }),
        ],
      }),
    },

    // 3. Inbox-list GET mirror — stale-while-revalidate gives offline reads
    // + fresh data on next online tick.
    {
      matcher: ({ url, request }) =>
        request.method === "GET" && url.pathname.startsWith("/api/inbox/"),
      handler: new StaleWhileRevalidate({ cacheName: "inbox-data" }),
    },

    // 4. App shell — HTML documents.
    {
      matcher: ({ request }) => request.destination === "document",
      handler: new NetworkFirst({
        cacheName: "app-shell",
        networkTimeoutSeconds: 3,
      }),
    },

    // 5. Static assets + defaults.
    ...defaultCache,
  ],
});

serwist.addEventListeners();
```

`skipWaiting: true` + `clientsClaim: true` means a new SW takes over without requiring the "two reloads" dance. `navigationPreload: true` lets the SW dispatch the network fetch in parallel with its own activation — measurable wins on slow connections.

## GET mirror routes

```ts
// app/api/inbox/list/route.ts
import { auth } from "@/lib/auth";
import { listThreadsForUser } from "@/lib/db/inbox-queries";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const InputSchema = z.object({
  accountId: z.string().cuid().optional(),
  sort: z.enum(["priority", "time"]).optional(),
});

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const parsed = InputSchema.safeParse({
    accountId: url.searchParams.get("accountId") ?? undefined,
    sort: url.searchParams.get("sort") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const data = await listThreadsForUser(session.user.id, parsed.data);
  return NextResponse.json(data);
}
```

`app/api/inbox/thread/[id]/route.ts` mirrors `getThread` similarly. Both routes are PER-USER and `force-dynamic` so the Next.js data cache never accidentally serves another user's data — the SW's per-tab cache is the only caching layer here.

## Manifest

```ts
// app/manifest.ts
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Email Client",
    short_name: "Email",
    description: "AI-first universal email client",
    start_url: "/inbox",
    display: "standalone",
    theme_color: "#18181b",
    background_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
```

Next.js's Metadata API serves this at `/manifest.webmanifest`. No extra `<link>` tag needed in the layout — the framework injects it.

## Icon generation (`scripts/generate-icons.ts`)

```ts
// Run via: npx tsx scripts/generate-icons.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";

const OUT = resolve("public/icons");
mkdirSync(OUT, { recursive: true });

const svg = (size: number, padded: boolean) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <rect width="${size}" height="${size}" fill="#18181b"/>
  <text x="50%" y="50%" font-size="${padded ? size * 0.45 : size * 0.6}"
        font-family="-apple-system, BlinkMacSystemFont, sans-serif"
        font-weight="700" fill="#fafafa"
        text-anchor="middle" dominant-baseline="central">E</text>
</svg>`;

async function main() {
  await sharp(Buffer.from(svg(192, false))).png().toFile(`${OUT}/icon-192.png`);
  await sharp(Buffer.from(svg(512, false))).png().toFile(`${OUT}/icon-512.png`);
  await sharp(Buffer.from(svg(512, true))).png().toFile(`${OUT}/icon-maskable-512.png`);
  console.log("Generated icons at public/icons/");
}

main();
```

`sharp` install can be cranky on Windows. If `npm install sharp` fails, fall back to checking in pre-made PNGs from any online generator (https://realfavicongenerator.net/ or similar) with a `scripts/generate-icons.README.md` documenting how the icons were sourced. Either path satisfies the spec.

## IndexedDB queue (`lib/offline/draft-queue.ts`)

```ts
"use client";

import { openDB, type IDBPDatabase } from "idb";
import { createId } from "@paralleldrive/cuid2";

export interface OfflineDraft {
  id: string;
  accountId: string;
  threadId: string | null;
  mode: "new" | "reply" | "reply-all" | "forward";
  to: Array<{ name?: string; email: string }>;
  cc: Array<{ name?: string; email: string }>;
  bcc: Array<{ name?: string; email: string }>;
  subject: string;
  bodyHtml: string;
  inReplyTo?: string[];
  references?: string[];
  queuedAt: number;
  attemptCount: number;
}

const DB_NAME = "email-client-offline";
const STORE = "drafts";
const VERSION = 1;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB only available in the browser"));
  }
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      },
    });
  }
  return dbPromise;
}

export async function queueDraft(
  input: Omit<OfflineDraft, "id" | "queuedAt" | "attemptCount"> & { id?: string },
): Promise<string> {
  try {
    const db = await getDb();
    const id = input.id ?? createId();
    const draft: OfflineDraft = {
      ...input,
      id,
      queuedAt: Date.now(),
      attemptCount: 0,
    };
    await db.put(STORE, draft);
    return id;
  } catch (e) {
    console.warn("offline.queueDraft failed", { name: (e as Error)?.name });
    throw e;
  }
}

export async function listQueued(): Promise<OfflineDraft[]> {
  try {
    const db = await getDb();
    const all = await db.getAll(STORE);
    return (all as OfflineDraft[]).sort((a, b) => a.queuedAt - b.queuedAt);
  } catch (e) {
    console.warn("offline.listQueued failed", { name: (e as Error)?.name });
    return [];
  }
}

export async function removeQueued(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db.delete(STORE, id);
  } catch (e) {
    console.warn("offline.removeQueued failed", { name: (e as Error)?.name });
  }
}

export async function clearQueued(): Promise<void> {
  try {
    const db = await getDb();
    await db.clear(STORE);
  } catch (e) {
    console.warn("offline.clearQueued failed", { name: (e as Error)?.name });
  }
}

export async function bumpAttempt(id: string): Promise<void> {
  try {
    const db = await getDb();
    const row = (await db.get(STORE, id)) as OfflineDraft | undefined;
    if (!row) return;
    row.attemptCount += 1;
    await db.put(STORE, row);
  } catch {
    /* best-effort */
  }
}
```

## Replay (`lib/offline/draft-replay.ts`)

```ts
"use client";

import { upsertDraft } from "@/app/inbox/compose/actions";
import { listQueued, removeQueued, bumpAttempt } from "./draft-queue";

let inFlight = false;

async function run(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const queued = await listQueued();
    for (const draft of queued) {
      try {
        const r = await upsertDraft({
          draftId: undefined,
          accountId: draft.accountId,
          threadId: draft.threadId,
          mode: draft.mode,
          to: draft.to,
          cc: draft.cc,
          bcc: draft.bcc,
          subject: draft.subject,
          bodyHtml: draft.bodyHtml,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
        });
        if (r.ok) {
          await removeQueued(draft.id);
        } else {
          await bumpAttempt(draft.id);
        }
      } catch {
        await bumpAttempt(draft.id);
      }
    }
  } finally {
    inFlight = false;
  }
}

export function installReplayListener(): () => void {
  if (typeof window === "undefined") return () => {};

  const onOnline = () => {
    void run();
  };
  window.addEventListener("online", onOnline);

  // Kick off an initial drain on mount in case we missed an `online` event
  // (the listener was installed after the transition).
  if (navigator.onLine) {
    void run();
  }

  return () => window.removeEventListener("online", onOnline);
}
```

The replay imports `upsertDraft` directly. In production, Next.js routes the Server Action invocation through a POST to the route — the SW's NetworkOnly entry for `/api/auth/*` doesn't apply, but Server Action POSTs to non-auth routes still need network. That's fine: replay only fires on the `online` event, when the network is present.

## Composer integration sketch

```ts
// inside composer.tsx
const queuedIdRef = useRef<string | null>(null);

useDebouncedEffect(() => {
  if (!isDirty) return;
  const payload = { /* current form state */ };

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    queueDraft({ ...payload, id: queuedIdRef.current ?? undefined })
      .then((id) => { queuedIdRef.current = id; })
      .catch(() => { /* surface offline-save-failed inline */ });
    setSaveState({ kind: "queued-offline" });
    return;
  }

  upsertDraft(payload).then((r) => {
    if (r.ok) setSaveState({ kind: "saved", at: r.data.updatedAt });
    // online but server-side error — leave existing state; the next autosave retries
  });
}, [debouncedFormState]);
```

`save-state` is a small union (`{ kind: "saving" | "saved" | "queued-offline" | "failed" }`) consumed by the indicator pill near the composer footer. When the replay listener flushes the queue, the next autosave call (online path) hits `upsertDraft` and the indicator transitions back to `"saved"` cleanly.

## Sign-out cleanup

When the user signs out, call `clearQueued()` from the sign-out handler. This prevents a different user on the same device from inheriting drafts.

Find the existing sign-out path (`app/(auth)/signout/route.ts` or a server-action) and add a small client wrapper: a `<SignOutButton />` that calls `clearQueued()` then triggers the Auth.js `signOut()`. If the existing sign-out is a plain redirect, add a tiny client component intermediary.

## Env vars

No new env vars. The PWA is purely static + Server Action + SW.

## Out of scope (recap)

Offline AI, offline send (queue is for drafts, not for `sendMail`), background-sync API, Web Push, conflict-resolution UI, server-side draft merge.
