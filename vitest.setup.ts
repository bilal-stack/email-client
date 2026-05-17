// Per-worker setup. Runs once *per worker process* before that worker's tests.
// DB migration is handled in `tests/setup/global.ts` (vitest globalSetup), which
// runs ONCE before any worker starts.
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./tests/setup/msw";

process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL ??= "file:./test.db";
process.env.AUTH_SECRET ??= "test-secret";
process.env.GOOGLE_CLIENT_ID ??= "test-client-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";
process.env.AZURE_AD_CLIENT_ID ??= "test-azure-client-id";
process.env.AZURE_AD_CLIENT_SECRET ??= "test-azure-client-secret";
process.env.AZURE_AD_TENANT_ID ??= "common";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
