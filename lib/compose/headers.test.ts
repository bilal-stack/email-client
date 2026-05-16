// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  type ParentForForward,
  type ParentForHeaders,
  buildForwardQuote,
  buildReplyHeaders,
  prefixForwardSubject,
  prefixReplySubject,
} from "./headers";

function makeParent(overrides: Partial<ParentForHeaders> = {}): ParentForHeaders {
  return {
    providerMessageId: "msg-current",
    inReplyTo: null,
    references: [],
    ...overrides,
  };
}

describe("buildReplyHeaders", () => {
  it("appends the parent's message id when parent has both inReplyTo and references", () => {
    const result = buildReplyHeaders(
      makeParent({
        providerMessageId: "msg-3",
        inReplyTo: "msg-2",
        references: ["msg-1", "msg-2"],
      }),
    );
    expect(result.inReplyTo).toBe("msg-3");
    expect(result.references).toEqual(["msg-1", "msg-2", "msg-3"]);
  });

  it("falls back to [inReplyTo, providerMessageId] when references is empty but inReplyTo present", () => {
    const result = buildReplyHeaders(
      makeParent({
        providerMessageId: "msg-2",
        inReplyTo: "msg-1",
        references: [],
      }),
    );
    expect(result.inReplyTo).toBe("msg-2");
    expect(result.references).toEqual(["msg-1", "msg-2"]);
  });

  it("returns [providerMessageId] when parent has neither references nor inReplyTo", () => {
    const result = buildReplyHeaders(
      makeParent({
        providerMessageId: "msg-1",
        inReplyTo: null,
        references: [],
      }),
    );
    expect(result.inReplyTo).toBe("msg-1");
    expect(result.references).toEqual(["msg-1"]);
  });

  it("inReplyTo is always exactly the parent's providerMessageId", () => {
    const result = buildReplyHeaders(
      makeParent({
        providerMessageId: "the-parent-id",
        inReplyTo: "different-prior-id",
        references: ["root", "different-prior-id"],
      }),
    );
    expect(result.inReplyTo).toBe("the-parent-id");
  });
});

describe("prefixReplySubject", () => {
  it("adds 'Re: ' to a plain subject", () => {
    expect(prefixReplySubject("Hello")).toBe("Re: Hello");
  });

  it("does not double-prefix when subject already starts with 'Re: '", () => {
    expect(prefixReplySubject("Re: Hello")).toBe("Re: Hello");
  });

  it("handles lowercase 're:' prefix and normalizes to 'Re: '", () => {
    expect(prefixReplySubject("re: hello")).toBe("Re: hello");
  });

  it("handles 'RE:' without a trailing space", () => {
    expect(prefixReplySubject("RE:Hello")).toBe("Re: Hello");
  });

  it("returns 'Re:' for an empty subject", () => {
    expect(prefixReplySubject("")).toBe("Re:");
  });
});

describe("prefixForwardSubject", () => {
  it("adds 'Fwd: ' to a plain subject", () => {
    expect(prefixForwardSubject("Update")).toBe("Fwd: Update");
  });

  it("does not double-prefix when subject already starts with 'Fwd: '", () => {
    expect(prefixForwardSubject("Fwd: Update")).toBe("Fwd: Update");
  });

  it("normalizes 'FW: ' to 'Fwd: '", () => {
    expect(prefixForwardSubject("FW: Update")).toBe("Fwd: Update");
  });

  it("normalizes 'forward: ' to 'Fwd: ' (case-insensitive)", () => {
    expect(prefixForwardSubject("forward: stuff")).toBe("Fwd: stuff");
  });
});

describe("buildForwardQuote", () => {
  function makeForwardParent(overrides: Partial<ParentForForward> = {}): ParentForForward {
    return {
      from: { name: "Alice", email: "alice@example.com" },
      receivedAt: new Date("2026-05-10T12:00:00Z"),
      subject: "Hello",
      to: [{ name: "Bob", email: "bob@example.com" }],
      bodyHtml: "<p>Original body</p>",
      bodyText: null,
      ...overrides,
    };
  }

  it("emits a div with a 'Forwarded message' header marker", () => {
    const html = buildForwardQuote(makeForwardParent());
    expect(html).toContain("<div");
    expect(html).toContain("Forwarded message");
  });

  it("includes labeled From / Date / Subject / To rows", () => {
    const html = buildForwardQuote(makeForwardParent());
    expect(html).toContain("<strong>From:</strong>");
    expect(html).toContain("<strong>Date:</strong>");
    expect(html).toContain("<strong>Subject:</strong>");
    expect(html).toContain("<strong>To:</strong>");
  });

  it("HTML-escapes <, >, &, \", ' in subject and sender name", () => {
    const html = buildForwardQuote(
      makeForwardParent({
        from: { name: "Hacker <script>alert(1)</script>", email: "h@example.com" },
        subject: "A&B \"C\" 'D' <e>",
      }),
    );
    // Raw <script> must NOT survive.
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toMatch(/<script\b/);
    // The escaped form is present.
    expect(html).toContain("&lt;script&gt;");
    // Subject special chars are escaped.
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;");
    expect(html).toContain("&#39;");
    expect(html).toContain("&lt;e&gt;");
  });

  it("falls back to <pre>{bodyText}</pre> when bodyHtml is null", () => {
    const html = buildForwardQuote(makeForwardParent({ bodyHtml: null, bodyText: "plain body" }));
    expect(html).toContain("<pre>plain body</pre>");
  });

  it("returns a string starting with <br><br> so it concatenates safely with prior content", () => {
    const html = buildForwardQuote(makeForwardParent());
    expect(html.startsWith("<br><br>")).toBe(true);
  });
});
