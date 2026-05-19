import withSerwistInit from "@serwist/next";
import type { NextConfig } from "next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
  cacheOnNavigation: true,
  reloadOnOnline: true,
});

const baseConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Server Actions default to a 1 MB request body cap. Our compose path
  // accepts attachments up to 25 MB total (`lib/compose/upload-guard.ts` —
  // matches Gmail's send cap); raise the framework cap to 30 MB so the
  // upload-guard's friendly per-cap error is what the user actually sees
  // when they exceed it. Without this, oversized FormData requests are
  // silently dropped at the framework boundary before the Server Action
  // runs — symptom: send button spins forever, no log line on the dev
  // server.
  experimental: {
    serverActions: {
      bodySizeLimit: "30mb",
    },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default withSerwist(baseConfig);
