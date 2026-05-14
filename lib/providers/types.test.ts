import { describe, expect, it } from "vitest";
import { NotImplementedError, NotImplementedProvider } from "./types";

describe("NotImplementedProvider", () => {
  const provider = new NotImplementedProvider();

  const methods = [
    "listThreads",
    "getThread",
    "sendMessage",
    "reply",
    "archive",
    "trash",
    "markRead",
    "setLabels",
    "search",
    "syncDelta",
  ] as const;

  for (const method of methods) {
    it(`throws NotImplementedError for ${method}`, () => {
      expect(() => (provider as unknown as Record<string, () => unknown>)[method]?.()).toThrow(
        NotImplementedError,
      );
    });
  }

  it("includes the method name in the error message", () => {
    try {
      provider.listThreads();
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as Error).message).toContain("listThreads");
    }
  });
});
