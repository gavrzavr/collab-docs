"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// ─── Interactive HTML block ──────────────────────────────────────────
//
// Sandboxed iframe that runs Claude-generated visualizations (charts,
// workout plans, dashboards, diagrams). The iframe is origin-less
// (sandbox="allow-scripts" without allow-same-origin), so:
//   - it cannot read the parent DOM, cookies, localStorage
//   - network requests to any origin fail CORS (origin is null)
//   - a malicious block author can still render anything visually, so
//     we frame the iframe with a visible "Interactive block" badge so
//     users can't mistake it for real app chrome.
//
// We inject a small height-reporter script into every srcdoc so the
// parent can grow/shrink to the content height. The CSP meta tag inside
// srcdoc is belt-and-braces: the sandbox already blocks network, but
// a CSP of `default-src 'none'` also blocks any future regression
// (e.g. if a browser relaxes sandbox semantics) and documents intent.

// Absolute max rendered by the client (matches the MCP server cap).
// Blocks over this become a "too large" placeholder — never silently
// ship a half-rendered visualization.
const MAX_HTML_BYTES = 200_000;

export function HtmlVizBlock(props: {
  html: string;
  createdAt?: string;
  createdBy?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(120);

  const srcdoc = useMemo(() => wrapHtmlForIframe(props.html), [props.html]);
  const tooLarge = props.html.length > MAX_HTML_BYTES;

  // Lazy-load: only boot the iframe when the block scrolls near view.
  // A page with 20 visualizations would otherwise spin up 20 JS contexts
  // on render, which makes editing laggy.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setVisible(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(container);
    return () => io.disconnect();
  }, [visible]);

  // Listen for height reports from the iframe. The ResizeObserver inside
  // the srcdoc pings us as content changes.
  useEffect(() => {
    const handler = (ev: MessageEvent) => {
      if (!iframeRef.current) return;
      if (ev.source !== iframeRef.current.contentWindow) return;
      const data = ev.data as unknown;
      if (typeof data !== "object" || data === null) return;
      const msg = data as { type?: unknown; height?: unknown };
      if (msg.type !== "pp-height") return;
      const h = Number(msg.height);
      if (Number.isFinite(h) && h > 0 && h < 5000) setHeight(h);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const badgeParts: string[] = ["Interactive block"];
  if (props.createdBy) badgeParts.push(`by ${shortenEmail(props.createdBy)}`);
  if (props.createdAt) badgeParts.push(formatShortDate(props.createdAt));

  return (
    <div
      ref={containerRef}
      className="pp-html-viz relative my-2 w-full border border-gray-200 rounded-lg overflow-hidden bg-white"
      contentEditable={false}
      suppressContentEditableWarning
    >
      {tooLarge ? (
        <div className="px-3 py-4 text-sm text-gray-500">
          Block exceeds {MAX_HTML_BYTES.toLocaleString()} bytes and was not rendered.
          Ask Claude to simplify or split it.
        </div>
      ) : visible ? (
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          style={{
            width: "100%",
            height: `${height}px`,
            border: "none",
            display: "block",
          }}
          title="Interactive block"
        />
      ) : (
        <div
          style={{ height: 120 }}
          className="flex items-center justify-center text-sm text-gray-400"
        >
          Interactive block — loading when in view…
        </div>
      )}
      <div className="absolute bottom-1 right-2 text-[10px] text-gray-400 pointer-events-none select-none bg-white/80 backdrop-blur px-1.5 py-0.5 rounded">
        {badgeParts.join(" · ")}
      </div>
    </div>
  );
}

// Wrap the caller's HTML in a full document with:
//   - a strict CSP (no network, no forms)
//   - a base system font so the common case looks ok without work
//   - a small script that postMessages content height to the parent
function wrapHtmlForIframe(html: string): string {
  return `<!doctype html>
<html>
<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #111; line-height: 1.4; }
  body > * { max-width: 100%; }
</style>
</head>
<body>
${html}
<script>
(function(){
  function report(){
    try {
      var h = Math.max(
        document.documentElement.scrollHeight || 0,
        document.body.scrollHeight || 0,
        document.body.offsetHeight || 0
      );
      parent.postMessage({ type: "pp-height", height: h }, "*");
    } catch (_) {}
  }
  // Initial + a few delayed reports to catch layout after deferred paints
  // (charts, fonts, images loading).
  report();
  window.addEventListener("load", report);
  [50, 200, 600, 1500].forEach(function(ms){ setTimeout(report, ms); });
  try {
    var ro = new ResizeObserver(report);
    ro.observe(document.body);
  } catch (_) {}
})();
</script>
</body>
</html>`;
}

function shortenEmail(e: string): string {
  const at = e.indexOf("@");
  if (at <= 0) return e;
  const name = e.slice(0, at);
  if (name.length <= 3) return e;
  return name[0] + "…" + name.slice(-1) + e.slice(at);
}

function formatShortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
  } catch {
    return "";
  }
}
