import type { MetadataRoute } from "next";

/**
 * Web App Manifest, served by Next.js at `/manifest.webmanifest`.
 * The framework injects the `<link rel="manifest">` tag automatically;
 * no extra wiring needed in `app/layout.tsx`.
 */
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
