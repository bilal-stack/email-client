// Helper for the "add a mailbox to my existing session" flow.
//
// The pattern: the /signin?add=1 Server Actions, before kicking off OAuth,
// set a short-lived cookie containing the currently-signed-in user's id.
// The signin callback reads that cookie when the OAuth provider redirects
// back, and uses the captured id (NOT whichever User PrismaAdapter just
// resolved/created from the OAuth profile) as the target for the
// MailAccount upsert. This keeps the mailbox attached to the user who
// initiated the "add" — even if the new OAuth account has a different
// email and PrismaAdapter would otherwise have created a separate User.
//
// The cookie is server-only (HttpOnly), SameSite=Lax (must survive the
// cross-origin redirect chain through Google/Microsoft), Secure in prod,
// and expires after 5 minutes — long enough for an OAuth round trip on a
// slow connection, short enough that a stranded cookie can't cause damage.

import { cookies } from "next/headers";

const COOKIE_NAME = "ec.add-mailbox-uid";
const MAX_AGE_SECONDS = 5 * 60;

/**
 * Resolve the cookie store, returning null if Next.js's request context
 * isn't available. Outside a Next.js request (e.g. Vitest unit tests that
 * import the signin callback directly, or any code path that runs before
 * the request store is mounted) `cookies()` throws synchronously. The
 * callers in this file all want best-effort behavior: if there's no
 * cookie store, treat the cookie as absent / no-op the write.
 */
async function safeCookies() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/**
 * Set the cookie before redirecting to the OAuth provider. Caller must
 * already have validated that `userId` is the active session's user — we
 * don't double-check here (the page only reaches the Server Actions after
 * `await auth()` has confirmed the session).
 *
 * No-op outside a request scope (e.g. in tests).
 */
export async function setAddMailboxIntent(userId: string): Promise<void> {
  const store = await safeCookies();
  if (!store) return;
  store.set(COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: MAX_AGE_SECONDS,
    path: "/",
  });
}

/**
 * Read and consume the cookie in the signin callback. Returns the captured
 * userId if present (caller should still verify the User row exists). The
 * cookie is cleared as a side-effect — one-shot semantics so a stale value
 * from a prior aborted flow can't ride through into a later one.
 *
 * Returns null outside a request scope.
 */
export async function readAndClearAddMailboxIntent(): Promise<string | null> {
  const store = await safeCookies();
  if (!store) return null;
  const v = store.get(COOKIE_NAME)?.value;
  if (!v) return null;
  // Clear: maxAge:0 + same path tells the browser to drop it.
  store.set(COOKIE_NAME, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 0,
    path: "/",
  });
  return v;
}

/**
 * Read WITHOUT clearing — used by the jwt callback, which fires AFTER the
 * signin callback within the same OAuth callback request. Reading twice is
 * fine; the signin callback's clear above only takes effect on the NEXT
 * request, since cookie writes don't reflect into reads within the same
 * response.
 *
 * Returns null outside a request scope.
 */
export async function peekAddMailboxIntent(): Promise<string | null> {
  const store = await safeCookies();
  return store?.get(COOKIE_NAME)?.value ?? null;
}
