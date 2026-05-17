import { test } from "@playwright/test";

// What this spec covers
// ---------------------
// Search, label, archive, delete, and bulk-action behaviors are all auth-gated.
// The repo does not yet ship a test-only auth bypass (or deterministic test-only
// seeders for Threads / MailAccounts), so every scenario from
// `sub-specs/tests.md` is registered here with `test.fixme` — matching the
// precedent set by `inbox.spec.ts` and `compose.spec.ts`.
//
// Each scenario name lines up with the test plan so the future fixup is a
// straightforward `.fixme` → `.skip` → live conversion once the harness lands.
//
// Unit-level coverage that exercises the same behaviors today:
//   - lib/db/inbox-mutations.test.ts        (local label transforms + revert)
//   - lib/db/inbox-queries.test.ts          (INBOX filter; trashed excluded)
//   - lib/inbox/selection-store.test.ts     (bulk-select Zustand store)
//   - app/inbox/actions.test.ts             (searchThreads / archiveThreads /
//                                            trashThreads / setThreadLabels /
//                                            listAvailableLabels Server Actions
//                                            with mocked provider)

test.describe("inbox actions — deferred (need test-only seeder + auth bypass)", () => {
  test.fixme("search bar at top of /inbox navigates to /inbox/search?q=...", () => {});
  test.fixme("clicking Archive on a row removes it from the list optimistically", () => {});
  test.fixme("clicking Trash on a row removes it from the list optimistically", () => {});
  test.fixme("provider failure on archive reverts the row", () => {});
  test.fixme("bulk select via checkboxes shows the action toolbar", () => {});
  test.fixme("bulk archive removes all selected rows", () => {});
  test.fixme("Labels popover lists existing labels and applies on confirm", () => {});
  test.fixme(
    "keyboard: j/k moves focused row; e archives focused or selected; # trashes; / focuses search; Esc clears",
    () => {},
  );
  test.fixme("thread view header has Archive + Trash buttons that go back to /inbox", () => {});
});
