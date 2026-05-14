import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

// Edge-safe Auth.js config — no Prisma, no node:crypto. This is what the
// middleware imports. The full server-side config lives in lib/auth/index.ts.
export const authConfig = {
  pages: { signIn: "/signin" },
  session: { strategy: "jwt" },
  providers: [
    Google,
    MicrosoftEntraID({
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
