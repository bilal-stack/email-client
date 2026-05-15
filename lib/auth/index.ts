import { authConfig } from "@/auth.config";
import { handleSignIn } from "@/lib/auth/signin-callback";
import { prisma } from "@/lib/db";
// Importing `env` triggers boot-time validation. Any invalid env var throws
// here before NextAuth() runs, so misconfigured envs surface immediately at
// `npm run dev` start instead of on the user's first sign-in attempt.
import { env } from "@/lib/env";
import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.modify",
].join(" ");

const MICROSOFT_SCOPES = [
  "openid",
  "email",
  "profile",
  "offline_access",
  "Mail.ReadWrite",
  "Mail.Send",
  "User.Read",
].join(" ");

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  adapter: PrismaAdapter(prisma),
  providers: [
    // Explicitly pass clientId/clientSecret instead of relying on Auth.js v5's
    // env-var auto-detection (which expects AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET,
    // not GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET). Keeps `.env` naming
    // consistent across the project + matches what most tutorials show.
    Google({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: { scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent" },
      },
    }),
    MicrosoftEntraID({
      clientId: env.AZURE_AD_CLIENT_ID,
      clientSecret: env.AZURE_AD_CLIENT_SECRET,
      authorization: { params: { scope: MICROSOFT_SCOPES } },
      issuer: `https://login.microsoftonline.com/${env.AZURE_AD_TENANT_ID}/v2.0`,
    }),
    // IMAP credentials provider is fleshed out in spec `imap-provider`.
    Credentials({
      id: "imap",
      name: "IMAP",
      credentials: {
        emailAddress: { label: "Email", type: "email" },
        password: { label: "App password", type: "password" },
        imapHost: { label: "IMAP host", type: "text" },
        smtpHost: { label: "SMTP host", type: "text" },
      },
      authorize: async () => null,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    signIn: handleSignIn,
    async jwt({ token, user }) {
      if (user?.id) token.userId = user.id;
      return token;
    },
    async session({ session, token }) {
      if (session.user && typeof token.userId === "string") {
        session.user.id = token.userId;
      }
      return session;
    },
  },
});
