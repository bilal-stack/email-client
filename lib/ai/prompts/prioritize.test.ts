// @vitest-environment node
//
// Schema-only unit tests for the prioritizer's Zod parser. The integration
// test in `lib/ai/prioritize.test.ts` covers the "rejects missing fields"
// path through the SUT — here we pin the bounds-of-the-domain checks that
// the schema is supposed to enforce on its own.

import { describe, expect, it } from "vitest";
import { PrioritizeResultSchema } from "./prioritize";

describe("PrioritizeResultSchema", () => {
  it("accepts the canonical shape", () => {
    const parsed = PrioritizeResultSchema.parse({
      priority: 4,
      reason: "Reply expected today",
      suggestedActions: ["reply"],
      riskFlag: "ok",
    });
    expect(parsed).toEqual({
      priority: 4,
      reason: "Reply expected today",
      suggestedActions: ["reply"],
      riskFlag: "ok",
    });
  });

  it("rejects out-of-range priority (6)", () => {
    expect(() =>
      PrioritizeResultSchema.parse({
        priority: 6,
        reason: "Too high",
        suggestedActions: [],
        riskFlag: "ok",
      }),
    ).toThrowError(expect.objectContaining({ name: "ZodError" }));
  });

  it("rejects unknown riskFlag", () => {
    expect(() =>
      PrioritizeResultSchema.parse({
        priority: 3,
        reason: "Unknown flag",
        suggestedActions: [],
        riskFlag: "unknown",
      }),
    ).toThrowError(expect.objectContaining({ name: "ZodError" }));
  });
});
