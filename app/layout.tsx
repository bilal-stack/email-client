import { InstallReplayListener } from "@/components/install-replay-listener";
import { RegisterServiceWorker } from "@/components/register-sw";
import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import NextTopLoader from "nextjs-toploader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Universal Mail",
  description: "One inbox for Gmail, Office 365, and IMAP — with AI that actually reads.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0a0a0a",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-zinc-50 text-zinc-900">
        {/* Global top progress bar for every Link navigation + router.push. */}
        <NextTopLoader
          color="#18181b"
          height={2}
          showSpinner={false}
          shadow="0 0 6px rgba(24,24,27,0.4)"
        />
        <RegisterServiceWorker />
        <InstallReplayListener />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
