import { expect, test } from "@playwright/test";

// What this spec covers
// ---------------------
// The unified-inbox UI is auth-gated. Without a real OAuth flow (Google) and
// a production-grade seeder route — neither of which exist yet in this repo —
// we cover the two highest-signal scenarios available end-to-end:
//
//   1. The unauthenticated state at `/inbox` (the "Sign in required" card).
//   2. The not-found path at `/inbox/<id>` for any threadId the visitor does
//      not own (also the unauthenticated case, since the route delegates to
//      `getThread` which short-circuits on no session).
//
// Scenarios from `sub-specs/tests.md` that require a signed-in session
// (inbox list, account filter, open thread + auto-mark-read, real-time SSE,
// HTML sanitization rendered inside the iframe, mobile viewport) are deferred:
// they need either a test-only auth bypass or a test-only seeder route, both
// of which are gated by `NODE_ENV === "test"` hooks that the foundation /
// gmail-provider build did not ship. The unit tests cover the same surfaces
// at a tighter granularity — see:
//   - lib/email-html/sanitize.test.ts        (HTML sanitization)
//   - lib/realtime/inbox-events.test.ts      (SSE bus)
//   - lib/db/inbox-queries.test.ts           (list + ownership scoping)
//   - app/inbox/actions.test.ts              (Server Actions)
//   - app/api/inbox/events/route.test.ts     (SSE Route Handler)

test.describe("unified-inbox — unauthenticated surfaces", () => {
  test("/inbox renders the sign-in CTA when there is no session", async ({ page }) => {
    await page.goto("/inbox");
    await expect(page.getByRole("heading", { name: /sign in required/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /sign in/i })).toBeVisible();
  });

  test("/inbox/<id> for an unauthenticated visitor does not 500", async ({ page }) => {
    // The route's `getThread` short-circuits with `Unauthorized` before any DB
    // work. We only assert the route doesn't crash — the rendered copy can be
    // either the sign-in prompt or the not-found card depending on the order
    // of session vs. notFound() checks.
    const response = await page.goto("/inbox/c123456789012345678901234");
    expect(response?.status() ?? 500).toBeLessThan(500);
  });
});

test.describe("unified-inbox — deferred (need test-only seeder + auth bypass)", () => {
  // These scenarios from sub-specs/tests.md require helpers that don't exist
  // yet in this repo. They are listed here as `test.fixme` so they appear in
  // the report as known-deferred rather than silently missing.
  test.fixme(
    "inbox list — four seeded threads ordered by lastMessageAt desc (needs auth bypass + DB seeder)",
    () => {},
  );
  test.fixme("account filter chip toggles ?account= URL param (needs auth bypass)", () => {});
  test.fixme("open thread + auto-mark-read clears the unread badge (needs auth bypass)", () => {});
  test.fixme(
    "real-time SSE update appends a new thread without reload (needs test-only seeder route)",
    () => {},
  );
  test.fixme("thread not-found.tsx renders for an unknown threadId (needs auth bypass)", () => {});
  test.fixme(
    "HTML body sanitization — inside iframe no <script> / 1x1 tracker img (needs auth bypass)",
    () => {},
  );
  test.fixme(
    "mobile viewport — list-only on small screens; thread view fills the screen (needs auth bypass)",
    () => {},
  );
  test.fixme(
    "empty state — user with zero MailAccount rows sees the no-mailboxes card (needs auth bypass)",
    () => {},
  );
});
