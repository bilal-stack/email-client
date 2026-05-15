// @vitest-environment node
// `isomorphic-dompurify` pulls in jsdom which expects a Node environment.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeEmailHtml } from "./sanitize";

async function loadFixture(name: string): Promise<string> {
  return readFile(resolve(process.cwd(), "tests", "fixtures", "email-html", name), "utf8");
}

describe("sanitizeEmailHtml — phishing fixture", () => {
  it("preserves benign content, strips <script>, onerror, tracker pixel, and the tracker host", async () => {
    const raw = await loadFixture("phish.html");
    const cleaned = await sanitizeEmailHtml(raw);

    expect(cleaned).toContain("<p>Hello</p>");
    expect(cleaned).not.toContain("<script");
    expect(cleaned.toLowerCase()).not.toContain("onerror");
    expect(cleaned).not.toContain("emltrk.example");
    expect(cleaned).not.toContain('width="1"');
  });
});

describe("sanitizeEmailHtml — edge cases", () => {
  it("returns an empty string when given an empty string", async () => {
    expect(await sanitizeEmailHtml("")).toBe("");
  });

  it("preserves the structure of a clean HTML body", async () => {
    const raw = await loadFixture("clean.html");
    const cleaned = await sanitizeEmailHtml(raw);
    expect(cleaned).toContain("<p>Hi <strong>Alice</strong>,</p>");
    expect(cleaned).toContain("<ul>");
    expect(cleaned).toContain("<li>One</li>");
    expect(cleaned).toContain("<li>Two</li>");
    expect(cleaned).toContain("</ul>");
    expect(cleaned).toMatch(/<em>Bob<\/em>/);
  });

  it("removes <style> blocks", async () => {
    const cleaned = await sanitizeEmailHtml("<style>body { color: red; }</style><p>Body</p>");
    expect(cleaned).not.toContain("<style");
    expect(cleaned).not.toContain("color: red");
    expect(cleaned).toContain("<p>Body</p>");
  });

  it("removes <iframe>, <object>, and <embed> elements", async () => {
    const cleaned = await sanitizeEmailHtml(
      `<p>ok</p>
       <iframe src="https://evil.example"></iframe>
       <object data="https://evil.example"></object>
       <embed src="https://evil.example">`,
    );
    expect(cleaned).toContain("<p>ok</p>");
    expect(cleaned).not.toContain("<iframe");
    expect(cleaned).not.toContain("<object");
    expect(cleaned).not.toContain("<embed");
  });

  it("strips javascript: URLs from <a href>", async () => {
    const raw = await loadFixture("js-url.html");
    const cleaned = await sanitizeEmailHtml(raw);
    expect(cleaned.toLowerCase()).not.toContain("javascript:");
  });
});
