// @vitest-environment node
//
// Focused unit tests for the in-memory rate limiter. The contract that matters
// here: a regression silently bills the Anthropic API at unbounded volume
// (or, the reverse, silently blocks legitimate traffic). The four cases below
// pin the four properties the call-sites depend on.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetRateLimit, checkRateLimit } from "./rate-limit";

beforeEach(() => {
  _resetRateLimit();
});

afterEach(() => {
  vi.useRealTimers();
  _resetRateLimit();
});

describe("checkRateLimit", () => {
  it("allows up to max (30 default) successive calls in the window", () => {
    for (let i = 0; i < 30; i++) {
      const r = checkRateLimit("u1", "summarize");
      expect(r.ok).toBe(true);
    }
  });

  it("blocks the 31st call with a retryAfterSeconds in [1, 60]", () => {
    for (let i = 0; i < 30; i++) {
      checkRateLimit("u1", "summarize");
    }
    const r = checkRateLimit("u1", "summarize");
    expect(r.ok).toBe(false);
    expect(r.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(r.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("resets after the window — next call passes once windowMs + 1 has elapsed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T00:00:00Z"));

    for (let i = 0; i < 30; i++) {
      checkRateLimit("u1", "summarize");
    }
    expect(checkRateLimit("u1", "summarize").ok).toBe(false);

    // Advance past the 60 s window. Default windowMs is 60_000.
    vi.advanceTimersByTime(60_001);

    const r = checkRateLimit("u1", "summarize");
    expect(r.ok).toBe(true);
  });

  it("isolates per user — user A's 30 calls do not affect user B's first call", () => {
    for (let i = 0; i < 30; i++) {
      const r = checkRateLimit("userA", "summarize");
      expect(r.ok).toBe(true);
    }
    // User A is now blocked.
    expect(checkRateLimit("userA", "summarize").ok).toBe(false);
    // User B's first call should still pass.
    expect(checkRateLimit("userB", "summarize").ok).toBe(true);
  });

  it("isolates per key — `ai-draft` and `summarize` are independent buckets for the same user", () => {
    // Exhaust the "summarize" bucket for u1.
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("u1", "summarize").ok).toBe(true);
    }
    // 31st `summarize` call would block; the first `ai-draft` call must pass
    // (different bucket key), proving the two operations don't share quota.
    expect(checkRateLimit("u1", "summarize").ok).toBe(false);
    expect(checkRateLimit("u1", "ai-draft").ok).toBe(true);
  });

  it("isolates per key across all three AI keys — summarize / ai-draft / prioritize each hold their own quota", () => {
    // Each of the three keys can spend its full 30 in the window without
    // affecting the others. Adding `prioritize` here pins the third bucket
    // alongside the two existing ones — a regression where any pair shared
    // a counter would block one of these three arms early.
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("user1", "summarize").ok).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("user1", "ai-draft").ok).toBe(true);
    }
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("user1", "prioritize").ok).toBe(true);
    }

    // The 31st `summarize` is blocked, but the other two keys' first call
    // after the burst still passes — each holds its own quota.
    expect(checkRateLimit("user1", "summarize").ok).toBe(false);
    expect(checkRateLimit("user1", "ai-draft").ok).toBe(false);
    expect(checkRateLimit("user1", "prioritize").ok).toBe(false);
  });
});
