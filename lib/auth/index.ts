import { authConfig } from "@/auth.config";
import { encrypt } from "@/lib/auth/crypto";
import { assertHostAllowed } from "@/lib/auth/imap-host-guard";
import { handleSignIn } from "@/lib/auth/signin-callback";
import { prisma } from "@/lib/db";
// Importing `env` triggers boot-time validation. Any invalid env var throws
// here before NextAuth() runs, so misconfigured envs surface immediately at
// `npm run dev` start instead of on the user's first sign-in attempt.
import { env } from "@/lib/env";
import type { ImapMailboxSecret } from "@/lib/providers/auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { ImapFlow } from "imapflow";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { z } from "zod";

const ImapCredentialsSchema = z.object({
  emailAddress: z.string().email(),
  password: z.string().min(1).max(1024),
  imapHost: z.string().min(1).max(253),
  smtpHost: z.string().min(1).max(253),
  imapPort: z.coerce.number().int().min(1).max(65535).default(993),
  smtpPort: z.coerce.number().int().min(1).max(65535).default(465),
});

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
    // IMAP credentials provider: validates against the live server, then
    // encrypts and persists the app-password into MailAccount.encryptedSecret.
    // No `Account` row is written — Credentials sign-ins bypass the
    // PrismaAdapter's OAuth-linkage path (see database-schema.md).
    Credentials({
      id: "imap",
      name: "IMAP",
      credentials: {
        emailAddress: { label: "Email", type: "email" },
        password: { label: "App password", type: "password" },
        imapHost: { label: "IMAP host", type: "text" },
        smtpHost: { label: "SMTP host", type: "text" },
        imapPort: { label: "IMAP port", type: "number" },
        smtpPort: { label: "SMTP port", type: "number" },
      },
      async authorize(raw) {
        const parsed = ImapCredentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const c = parsed.data;

        // 1. SSRF guard on both hosts (literals and DNS-resolved alike).
        try {
          await assertHostAllowed(c.imapHost, c.imapPort);
          await assertHostAllowed(c.smtpHost, c.smtpPort);
        } catch (e) {
          // No host or username in the log — sanitized.
          console.warn("[auth.imap] host rejected", { name: (e as Error)?.name });
          return null;
        }

        // 2. TLS-required IMAP connect → noop → logout. Refuse plaintext.
        const client = new ImapFlow({
          host: c.imapHost,
          port: c.imapPort,
          secure: true,
          auth: { user: c.emailAddress, pass: c.password },
          logger: false,
        });
        try {
          await client.connect();
          await client.noop();
          await client.logout();
        } catch (e) {
          // Best-effort close — failed connect leaves no socket but logout
          // is idempotent on imapflow.
          try {
            await client.logout();
          } catch {
            /* ignore */
          }
          console.warn("[auth.imap] connection rejected", { name: (e as Error)?.name });
          return null;
        }

        // 3. Resolve User row (lookup → self-create — matches handleSignIn).
        try {
          const existing = await prisma.user.findUnique({ where: { email: c.emailAddress } });
          const user =
            existing ?? (await prisma.user.create({ data: { email: c.emailAddress } }));

          // 4. Encrypt and upsert MailAccount.
          const blob = JSON.stringify({
            kind: "imap",
            password: c.password,
            imapHost: c.imapHost,
            imapPort: c.imapPort,
            smtpHost: c.smtpHost,
            smtpPort: c.smtpPort,
          } satisfies ImapMailboxSecret);
          const sealed = encrypt(blob);
          await prisma.mailAccount.upsert({
            where: {
              userId_provider_emailAddress: {
                userId: user.id,
                provider: "imap",
                emailAddress: c.emailAddress,
              },
            },
            create: {
              userId: user.id,
              provider: "imap",
              emailAddress: c.emailAddress,
              encryptedSecret: sealed.ciphertext,
              secretIv: sealed.iv,
              secretTag: sealed.tag,
            },
            update: {
              encryptedSecret: sealed.ciphertext,
              secretIv: sealed.iv,
              secretTag: sealed.tag,
            },
          });

          return { id: user.id, email: c.emailAddress };
        } catch (e) {
          console.warn("[auth.imap] persistence failed", { name: (e as Error)?.name });
          return null;
        }
      },
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
