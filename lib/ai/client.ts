// Anthropic SDK singleton + the retry wrapper every AI feature shares.
//
// Server-only: this module imports `@anthropic-ai/sdk`, which carries the API
// key via `env.ANTHROPIC_API_KEY`. Never reach this from a client component.
// CLAUDE.md rule #3 — the key never crosses to the browser.
//
// `ANTHROPIC_API_KEY` is optional in `lib/env.ts` so the app boots without a
// key during the foundation phase. The Server Actions that depend on it
// surface a clear runtime error if it's missing at call time.

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

export const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY ?? "",
});

export const MODEL_FAST = "claude-haiku-4-5-20251001";
export const MODEL_BEST = "claude-sonnet-4-6";

/**
 * Retry-on-overload wrapper. Retries 503/529 responses with exponential
 * backoff + jitter; surfaces every other error to the caller untouched.
 */
export async function callWithRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isOverload =
        e instanceof Anthropic.APIError && (e.status === 503 || e.status === 529);
      if (!isOverload || i === attempts - 1) throw e;
      const delayMs = 500 * 2 ** i + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
