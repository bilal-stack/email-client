"use client";

interface SandboxIframeProps {
  html: string;
}

// CSP applied two ways for defense-in-depth:
//   1. Inline `<meta http-equiv="Content-Security-Policy">` inside the iframe's
//      srcdoc — enforced by ALL modern browsers when the iframe parses the
//      document.
//   2. The `csp` iframe attribute (Chrome/Edge only as of 2026) — a redundant
//      enforcement layer for Chromium users. React doesn't type `csp`, so we
//      spread it from a plain Record.
const CSP = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'";
const cspAttr: Record<string, string> = { csp: CSP };

function wrapWithCsp(rawHtml: string): string {
  // The sanitizer already strips <meta> tags, so we can prepend our own
  // safely. The iframe's srcdoc treats this as the full document.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body>${rawHtml}</body></html>`;
}

export function SandboxIframe({ html }: SandboxIframeProps) {
  return (
    <iframe
      title="Email body"
      srcDoc={wrapWithCsp(html)}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="w-full border-0"
      style={{ minHeight: "min(80vh, 1200px)", width: "100%" }}
      {...cspAttr}
    />
  );
}
