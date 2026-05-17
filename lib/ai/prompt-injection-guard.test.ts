// @vitest-environment node
//
// The prompt-injection guard is the locked differentiator from `decisions.md`.
// These tests pin the three properties the call-sites and the system prompt
// depend on: (1) the wrap shape, (2) the literal-tag escape, (3) the
// case-insensitive variant covers the obvious bypass.

import { describe, expect, it } from "vitest";
import { wrapEmailBody } from "./prompt-injection-guard";

const ZWJ = "‍";

describe("wrapEmailBody", () => {
  it("wraps plain text in <email>...</email> with newlines (exact shape)", () => {
    expect(wrapEmailBody("hello")).toBe("<email>\nhello\n</email>");
  });

  it("escapes embedded <email> tags with a zero-width joiner so they cannot terminate the wrapper", () => {
    const out = wrapEmailBody("<email>nested</email>");
    // The outer wrapper tags still parse as <email> / </email>.
    expect(out.startsWith("<email>\n")).toBe(true);
    expect(out.endsWith("\n</email>")).toBe(true);
    // The inner sequences have a ZWJ between `<` and `email` / `/email`, so
    // a model scanning for the literal terminator no longer finds them.
    expect(out).toContain(`<${ZWJ}email>`);
    expect(out).toContain(`<${ZWJ}/email>`);
    // And the raw `<email>` / `</email>` sequence appears only at the wrapper
    // (once each — wrapper opens and closes).
    expect(out.match(/<email>/g)).toHaveLength(1);
    expect(out.match(/<\/email>/g)).toHaveLength(1);
  });

  it("escapes case-variant tags too (covers the case-flip bypass)", () => {
    // The replacement uses the lowercase literal `<ZWJemail>` for every
    // case-variant match — what matters is that NEITHER the raw `<EMAIL>`
    // (or `<Email>`) NOR the raw `</EMAIL>` (or `</Email>`) survives as a
    // parseable terminator sequence inside the wrapped body.
    const upper = wrapEmailBody("<EMAIL>nested</EMAIL>");
    const upperInner = upper.slice("<email>\n".length, -"\n</email>".length);
    expect(upperInner).not.toMatch(/<email>/i);
    expect(upperInner).not.toMatch(/<\/email>/i);
    expect(upperInner).toContain(ZWJ);

    const mixed = wrapEmailBody("<Email>nested</Email>");
    const mixedInner = mixed.slice("<email>\n".length, -"\n</email>".length);
    expect(mixedInner).not.toMatch(/<email>/i);
    expect(mixedInner).not.toMatch(/<\/email>/i);
    expect(mixedInner).toContain(ZWJ);
  });
});
