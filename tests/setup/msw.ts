// MSW v2 server used by all unit tests that need to intercept HTTP calls
// (Gmail API + Google OAuth refresh endpoint). The server lifecycle is wired
// into `vitest.setup.ts`. Per-test handlers go inline via `server.use(...)`.

import { setupServer } from "msw/node";

export const server = setupServer();
