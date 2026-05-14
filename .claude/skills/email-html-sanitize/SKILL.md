---
name: email-html-sanitize
description: How to safely render an inbound email's HTML body. Read this before adding any feature that displays email content. Defends against XSS, tracking pixels, and CSS-based exfil.
---

# Email HTML sanitization

Email HTML is hostile by default. Render it only via this pipeline.

## Pipeline (server side)

1. **Strip dangerous nodes** with DOMPurify (server-side, `isomorphic-dompurify`):
   ```ts
   import DOMPurify from "isomorphic-dompurify";

   const cleaned = DOMPurify.sanitize(rawHtml, {
     ALLOWED_TAGS: [
       "a", "abbr", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4", "h5",
       "h6", "hr", "i", "img", "li", "ol", "p", "pre", "small", "span", "strong", "sub", "sup",
       "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
     ],
     ALLOWED_ATTR: ["href", "src", "alt", "title", "style", "width", "height", "align"],
     FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "link", "meta", "form", "input"],
     FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
     ALLOW_DATA_ATTR: false,
   });
   ```

2. **Strip tracking pixels** — any `<img>` whose `src` matches known analytics domains or is `1x1`:
   ```ts
   const TRACKER_DOMAINS = [
     /\bmailchimp\.com\b/i, /\bsendgrid\.net\b/i, /\bgodaddy\.com\b/i,
     /\bhubspot\.com\b/i, /\bsalesforce\.com\b/i, /\bmkt[\d]+\.com\b/i,
     /\bpixel\b/i, /\btrack\b/i, /\bbeacon\b/i, /\bemltrk\b/i,
   ];
   ```
   Walk the parsed DOM (`linkedom` or similar) and remove matching `<img>` elements before rendering.

3. **Render inside a sandboxed iframe with `srcdoc`** (client-side or RSC):
   ```tsx
   <iframe
     srcDoc={cleanedHtml}
     sandbox="allow-popups allow-popups-to-escape-sandbox"
     referrerPolicy="no-referrer"
     csp="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"
     className="w-full"
     style={{ height: computedHeight }}
   />
   ```
   - `sandbox` without `allow-scripts` blocks JS execution entirely.
   - `referrerPolicy="no-referrer"` denies sender any signal that you opened the mail.
   - The CSP forbids fetching anything except images over HTTPS or as data URLs.

4. **Click-through warning**: if a link's visible text disagrees with its `href` host, intercept the click and prompt the user.

## What this skill does NOT cover
- Rendering plain-text bodies — those go through `<pre>` with `white-space: pre-wrap` and need no sanitization beyond escaping.
- Outbound HTML composed in the app — that's TipTap output, which is already structured.

## Test fixture
Keep a phishing-style fixture in `tests/fixtures/email-html/phish.html` containing `<script>`, an inline `onerror`, a 1×1 tracker pixel, and a deceptive link. The sanitizer test asserts all of these are neutralized.
