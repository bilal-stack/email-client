// Email HTML sanitization pipeline — server-side only.
//
// We use `sanitize-html` (pure Node, no DOM dependency) rather than DOMPurify.
// DOMPurify is a browser library that requires a DOM; running it in Node means
// pulling in JSDOM, which at runtime tries to read a default stylesheet from
// disk and crashes with `ENOENT: ... default-stylesheet.css` in the bundled
// Next.js layout. sanitize-html avoids all of that — it uses htmlparser2
// streaming and rewrites the HTML directly.
//
// After sanitize-html strips dangerous tags/attrs/schemes, we use linkedom to
// walk the cleaned DOM one more time and remove tracker images (1×1 pixels +
// known analytics-domain hosts). This is the same two-stage pipeline described
// in the `email-html-sanitize` skill, with a different sanitizer engine.

import { parseHTML } from "linkedom";
import sanitizeHtml from "sanitize-html";

const TRACKER_DOMAINS = [
  /\bmailchimp\.com\b/i,
  /\bsendgrid\.net\b/i,
  /\bgodaddy\.com\b/i,
  /\bhubspot\.com\b/i,
  /\bsalesforce\.com\b/i,
  /\bmkt[\d]+\.com\b/i,
  /\bpixel\b/i,
  /\btrack\b/i,
  /\bbeacon\b/i,
  /\bemltrk\b/i,
];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "a",
    "abbr",
    "b",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "i",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
  ],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["align", "style"],
  },
  // Schemes for href on <a>: drop javascript:, vbscript:, file:, etc.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  // Images may also be inline data URIs.
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
  // Anything not in allowedTags is discarded entirely (not preserved as text).
  disallowedTagsMode: "discard",
  // Strip inline event handlers (`on*`) is the default for unlisted attributes
  // but make it explicit by leaving them out of allowedAttributes above.
};

export async function sanitizeEmailHtml(rawHtml: string): Promise<string> {
  const cleaned = sanitizeHtml(rawHtml, SANITIZE_OPTIONS);

  // Second pass: walk the cleaned DOM and strip tracker pixels — sanitize-html
  // would have kept them since they look like ordinary <img> tags.
  const { document } = parseHTML(`<!doctype html><html><body>${cleaned}</body></html>`);
  const images = Array.from(document.querySelectorAll("img"));
  for (const img of images) {
    const src = img.getAttribute("src") ?? "";
    const w = img.getAttribute("width");
    const h = img.getAttribute("height");
    const isTinyPixel = w === "1" && h === "1";
    const isTrackerHost = TRACKER_DOMAINS.some((re) => re.test(src));
    if (isTinyPixel || isTrackerHost) img.remove();
  }
  return document.body.innerHTML;
}
