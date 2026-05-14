import { authConfig } from "@/auth.config";
import { encrypt } from "@/lib/auth/crypto";
import { prisma } from "@/lib/db";
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
    Google({
      authorization: {
        params: { scope: GOOGLE_SCOPES, access_type: "offline", prompt: "consent" },
      },
    }),
    MicrosoftEntraID({
      authorization: { params: { scope: MICROSOFT_SCOPES } },
      issuer: `https://login.microsoftonline.com/${process.env.AZURE_AD_TENANT_ID ?? "common"}/v2.0`,
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
    async signIn({ account, profile }) {
      if (!account || account.type !== "oauth") return true;
      const providerName = mapProvider(account.provider);
      if (!providerName) return true;

      const emailAddress = typeof profile?.email === "string" ? profile.email : null;
      if (!emailAddress) return false;

      const secretJson = JSON.stringify({
        accessToken: account.access_token ?? null,
        refreshToken: account.refresh_token ?? null,
        expiresAt: account.expires_at ?? null,
        scope: account.scope ?? null,
        tokenType: account.token_type ?? null,
        idToken: account.id_token ?? null,
      });
      const sealed = encrypt(secretJson);

      const dbUser = await prisma.user.findUnique({ where: { email: emailAddress } });
      if (!dbUser) return true;

      await prisma.mailAccount.upsert({
        where: {
          userId_provider_emailAddress: {
            userId: dbUser.id,
            provider: providerName,
            emailAddress,
          },
        },
        create: {
          userId: dbUser.id,
          provider: providerName,
          emailAddress,
          displayName: typeof profile?.name === "string" ? profile.name : null,
          encryptedSecret: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
        },
        update: {
          encryptedSecret: sealed.ciphertext,
          secretIv: sealed.iv,
          secretTag: sealed.tag,
          displayName: typeof profile?.name === "string" ? profile.name : undefined,
        },
      });
      return true;
    },
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

function mapProvider(authProvider: string): "gmail" | "graph" | null {
  if (authProvider === "google") return "gmail";
  if (authProvider === "microsoft-entra-id") return "graph";
  return null;
}
