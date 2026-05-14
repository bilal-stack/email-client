# Tests — Foundation

`test-author` agent writes these alongside the build. `pnpm test:run` and `pnpm test:e2e` must both be green before this spec is marked done.

## Unit (Vitest)

### `lib/auth/crypto.test.ts`
- `encrypt(p)` then `decrypt(c, iv, tag)` round-trips to the original plaintext.
- Two calls to `encrypt(p)` produce different IVs and different ciphertexts.
- Tampering with `ciphertext` causes `decrypt` to throw.
- Tampering with `tag` causes `decrypt` to throw.
- `encrypt` throws if `ENCRYPTION_KEY` is missing or wrong length.

### `lib/providers/types.test.ts`
- `NotImplementedProvider` throws `NotImplementedError` for every `IEmailProvider` method.
- Error message includes the method name.

### `lib/auth/index.test.ts`
- The `signIn` callback writes a `MailAccount` row when a Google account is linked. (Prisma mocked.)
- The `signIn` callback updates an existing `MailAccount` row on subsequent sign-ins (same `userId + provider + emailAddress`).
- Encrypted token is not equal to the plaintext.

## E2E (Playwright)

### `tests/e2e/foundation.spec.ts`
- **Unauthenticated landing**: navigate to `/`, see hero copy and three sign-in CTAs.
- **Inbox is guarded**: navigate to `/inbox` while unauthenticated → redirected to `/signin`.
- **Sign-in flow (mocked)**: stub the Google OAuth callback to return a signed-in session → land on `/inbox` with the empty state visible.
- **Mobile viewport** (390 × 844 — iPhone 14): the layout is single column, no horizontal scroll, sign-in buttons are at least 44 × 44 px tap targets.

### `tests/e2e/inngest-wiring.spec.ts`
- `GET /api/inngest` returns 200 with the Inngest introspection payload (proves the route is wired).

## Mocking strategy
- Auth.js OAuth callbacks: use the Auth.js test helpers + MSW to fake provider token endpoints.
- No real Google / Microsoft calls in any test run.
- Prisma uses a separate `DATABASE_URL=file:./test.db` per test runner, migrated fresh before the suite.
