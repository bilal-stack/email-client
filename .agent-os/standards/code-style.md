# Code Style

## TypeScript
- `strict: true`. No `any` without an adjacent comment explaining why.
- `type` for shapes that compose; `interface` for shapes that get implemented (e.g., `IEmailProvider`).
- No default exports except for Next.js page / layout / route files. Named exports otherwise.
- Discriminated unions for state machines:
  ```ts
  type FetchState<T> =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; error: Error }
    | { status: "ok"; data: T };
  ```

## Naming
- Components: `PascalCase.tsx`.
- Utility / module files: `kebab-case.ts`.
- Server actions: file `actions.ts`; functions `verbNoun` (`sendDraft`, `archiveThread`).
- Prisma models: `PascalCase`, singular.
- DB columns: `camelCase`.

## React (Next.js App Router)
- Server components by default. `"use client"` only when needed (state, effects, browser APIs, event handlers).
- Co-locate `loading.tsx`, `error.tsx`, `not-found.tsx` with routes.
- Data fetched in server components or via Server Actions. No `fetch` from client components for our own API.
- Forms use React Hook Form + Zod; submit via Server Action.

## Imports
- Order: external modules → `@/...` → relative.
- Type-only imports use `import type`.

## Comments
- Default: none. Names should be self-explanatory.
- Explain *why*, not *what*. Use a comment when:
  - There's a non-obvious invariant.
  - A workaround exists for a specific upstream bug (link it).
  - The reader would be surprised by the behavior.
- No "what the code does" comments. No tombstone comments (`// removed X`).

## Tests
- Co-locate unit tests next to source: `foo.ts` + `foo.test.ts`.
- E2E tests in `tests/e2e/` named after the spec.
- One `describe` per unit; one `test` per behavior. No shared state across tests.
- Network mocked with MSW; never call real Anthropic / provider APIs in test runs.

## Errors
- Throw typed errors from `lib/errors.ts` at boundaries.
- Map provider-specific errors to a small canonical set: `AuthError`, `RateLimitError`, `NotFoundError`, `TransientError`, `UnknownError`.
- Server Actions return `{ ok: true; data } | { ok: false; error }` — no throws across the action boundary.
