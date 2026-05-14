import { describe, expect, it } from "vitest";
import {
  AuthError,
  NotFoundError,
  ProviderError,
  RateLimitError,
  TransientError,
  UnknownProviderError,
} from "./errors";

describe("provider error taxonomy", () => {
  it("each canonical error extends ProviderError and carries its name", () => {
    const cases: Array<[new (...a: never[]) => ProviderError, string]> = [
      [AuthError, "AuthError"],
      [NotFoundError, "NotFoundError"],
      [RateLimitError, "RateLimitError"],
      [TransientError, "TransientError"],
      [UnknownProviderError, "UnknownProviderError"],
    ];
    for (const [Ctor, name] of cases) {
      const err = new (Ctor as new (m: string) => ProviderError)("boom");
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.name).toBe(name);
      expect(err.message).toBe("boom");
    }
  });

  it("RateLimitError carries retryAfterSeconds", () => {
    const err = new RateLimitError("slow down", 30);
    expect(err.retryAfterSeconds).toBe(30);
  });
});
