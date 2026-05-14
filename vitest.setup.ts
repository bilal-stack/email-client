import "@testing-library/jest-dom/vitest";

process.env.ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.DATABASE_URL ??= "file:./test.db";
process.env.AUTH_SECRET ??= "test-secret";
