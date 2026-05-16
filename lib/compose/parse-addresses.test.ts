// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseAddressList } from "./parse-addresses";

describe("parseAddressList", () => {
  it("parses a single bare email", () => {
    expect(parseAddressList("alice@example.com")).toEqual([{ email: "alice@example.com" }]);
  });

  it("parses a single Name <email> entry and captures the display name", () => {
    expect(parseAddressList("Alice <alice@example.com>")).toEqual([
      { name: "Alice", email: "alice@example.com" },
    ]);
  });

  it("parses two comma-separated bare emails into two entries", () => {
    expect(parseAddressList("alice@example.com, bob@example.com")).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
  });

  it("parses a mix of named + bare addresses into two entries with names preserved", () => {
    expect(parseAddressList("Alice <alice@example.com>, bob@example.com")).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
  });

  it("returns an empty array for an empty string", () => {
    expect(parseAddressList("")).toEqual([]);
  });

  it("returns an empty array when the input is not a parseable address", () => {
    // Lock the contract: an unparseable token (no `@`, no angle brackets) is
    // dropped silently rather than thrown. The Server Action still validates
    // with `z.string().email()`, so this is safe.
    expect(parseAddressList("not-an-email")).toEqual([]);
  });

  it("tolerates a trailing comma and surrounding whitespace", () => {
    expect(parseAddressList("alice@example.com, bob@example.com,  ")).toEqual([
      { email: "alice@example.com" },
      { email: "bob@example.com" },
    ]);
  });

  it("treats a quoted display name with an embedded comma as a single entry", () => {
    expect(parseAddressList('"Smith, Alice" <a@x.com>')).toEqual([
      { name: "Smith, Alice", email: "a@x.com" },
    ]);
  });
});
