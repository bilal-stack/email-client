/// <reference lib="webworker" />

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
