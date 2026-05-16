import { test } from "@playwright/test";

// What this spec covers
// ---------------------
// All composer behaviors are auth-gated. The repo does not yet ship a
// test-only auth bypass (or a deterministic test-only seeder for threads /
// drafts), so every scenario from `sub-specs/tests.md` is registered here
// with `test.fixme` — matching the precedent set by `inbox.spec.ts`.
//
// Each scenario name lines up with the test plan so the future fixup is a
// straightforward `.fixme` → `.skip` → live conversion once the harness lands.
//
// Unit-level coverage that exercises the same behaviors today:
//   - lib/compose/headers.test.ts          (reply / forward header + subject derivation)
//   - lib/compose/upload-guard.test.ts     (attachment size + MIME guards)
//   - lib/compose/parse-addresses.test.ts  (recipient parsing)
//   - lib/compose/draft-queries.test.ts    (autosave persistence + ownership)
//   - app/inbox/compose/actions.test.ts    (Server Actions end-to-end with mocked provider)

test.describe("compose — deferred (need test-only seeder + auth bypass)", () => {
  test.fixme(
    "composer opens at /inbox/compose/new with empty fields and selected account",
    () => {},
  );
  test.fixme(
    "typing in the composer triggers autosave after 2s, save status flips to 'Saved'",
    () => {},
  );
  test.fixme("clicking Reply from a thread pre-fills To and Subject", () => {});
  test.fixme("clicking Reply all includes all original recipients minus self", () => {});
  test.fixme("clicking Forward includes the quoted body and Fwd: subject", () => {});
  test.fixme("subject de-double-prefix: replying to 'Re: Hello' keeps 'Re: Hello'", () => {});
  test.fixme("attaching a .exe shows an inline error and Send remains disabled", () => {});
  test.fixme("attaching a 30 MB file shows a size-exceeded error", () => {});
  test.fixme(
    "Send hits sendDraft, navigates to inbox/[threadId] on reply, /inbox on new",
    () => {},
  );
  test.fixme("Discard deletes the draft and navigates away", () => {});
  test.fixme("Closing the tab and reopening the same route restores the draft", () => {});
  test.fixme("mobile viewport: composer fills the screen, fields stack vertically", () => {});
});
