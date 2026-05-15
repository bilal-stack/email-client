import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

// Edge-safe Auth.js config — no Prisma, no node:crypto. This is what the
// middleware imports. The full server-side config lives in lib/auth/index.ts.
export const authConfig = {
  pages: { signIn: "/signin" },
  session: { strategy: "jwt" },
  // Trust the incoming Host header. Auth.js v5 auto-trusts on Vercel and in dev
  // mode but is strict elsewhere (including local `npm run start`). We're
  // always behind a known host — localhost or the eventual deployed domain —
  // so `trustHost: true` is safe and avoids the `UntrustedHost` error.
  trustHost: true,
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    MicrosoftEntraID({
      clientId: process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET,
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID ?? "common"}/v2.0`,
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const isOnInbox = request.nextUrl.pathname.startsWith("/inbox");
      if (isOnInbox) return !!auth?.user;
      return true;
    },
  },
} satisfies NextAuthConfig;
