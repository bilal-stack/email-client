import { Inngest } from "inngest";

// Inngest signs requests with a key issued by Inngest cloud. When running
// locally (with `npm run dev` or `npm run start` against the Inngest dev
// server) we don't have that key — our `.env` carries a `local-dev`
// placeholder. Treating any non-real-looking key as dev mode disables
// signature validation, which would otherwise reject every cron firing with
// "No x-inngest-signature provided" under `npm run start`.
//
// The `deploy-vercel` spec will set a real signing key in Vercel's env, at
// which point `hasRealSigningKey` flips to true and signature validation kicks
// back in.
const sk = process.env.INNGEST_SIGNING_KEY ?? "";
const hasRealSigningKey =
  sk.length > 0 && sk !== "local-dev" && sk !== "placeholder" && !sk.startsWith("signkey-test-");

export const inngest = new Inngest({
  id: "email-client",
  isDev: !hasRealSigningKey,
});
