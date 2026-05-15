// Email HTML sanitization pipeline.
//
// `isomorphic-dompurify` pulls in jsdom and reads a default-stylesheet.css from
// disk at module init, which webpack tries to bundle and fails on. We load
// DOMPurify lazily inside the function so the import never appears in webpack's
// static graph for app routes. Pure Node only — never bundled to the client.

import { parseHTML } from "linkedom";

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

let purifierPromise: Promise<typeof import("isomorphic-dompurify").default> | null = null;
function getPurifier() {
  if (!purifierPromise) {
    purifierPromise = import("isomorphic-dompurify").then((m) => m.default);
  }
  return purifierPromise;
}

export async function sanitizeEmailHtml(rawHtml: string): Promise<string> {
  const DOMPurify = await getPurifier();
  const cleaned = DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [
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
    ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "width", "height", "align"],
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    ALLOW_DATA_ATTR: false,
  });

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
