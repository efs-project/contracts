"use client";

import { CSSProperties, useRef } from "react";

// PDF preview for browsers with no built-in PDF viewer (Chrome on Android
// reports `navigator.pdfViewerEnabled === false` and can't show a PDF in a
// frame). pdf.js draws the pages onto canvases inside a sandboxed iframe
// (ADR-0070), so the untrusted PDF is parsed in an opaque origin, never in
// the app's: `allow-scripts` only, no `allow-same-origin`, plus a CSP that
// allows no network and no eval. No annotation or text layer is drawn, so a
// PDF can't put a live link in front of the viewer.
//
// The opaque frame can't load the app's own pdf.js files (they'd be
// cross-origin module loads), so the parent fetches them as text and posts
// them in with the bytes; the frame imports them from its own blob: URLs.
// Chromium won't start a Worker from a blob in an opaque origin, so pdf.js
// runs its parser on the frame's main thread (`globalThis.pdfjsWorker`).
// With no network, pdf.js can't load its wasm image decoders, standard-font
// files or CJK CMaps: JPEG2000/JBIG2 images may render blank and missing fonts
// fall back to built-in substitutes. Download still gets the real file.

// Emitted by webpack as hashed static files and fetched only when a fallback
// preview is shown, so browsers with a native viewer never download pdf.js.
const pdfJsUrls = () => [
  new URL("pdfjs-dist/build/pdf.min.mjs", import.meta.url).href,
  new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href,
];

let pdfJsSources: Promise<string[]> | null = null;
const loadPdfJsSources = () => {
  pdfJsSources ??= Promise.all(
    pdfJsUrls().map(async url => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`pdf.js fetch failed: ${res.status}`);
      return res.text();
    }),
  ).catch(err => {
    pdfJsSources = null; // let the next preview retry
    throw err;
  });
  return pdfJsSources;
};

// Runs inside the sandboxed frame. Kept as plain JS: it never shares the
// app's bundle or globals. Pages render as they near the viewport and are
// cleared again once far away, so a long PDF doesn't pin every page's bitmap.
const FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:">
<style>
html,body{margin:0;background:#525659}
#pages{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px}
canvas{display:block;width:100%;max-width:1000px;height:auto;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.4)}
#msg,#more{color:#eee;font:14px system-ui,sans-serif;padding:16px;text-align:center}
</style></head>
<body><div id="msg">Loading PDF…</div><div id="pages"></div>
<script type="module">
const msg = document.getElementById("msg");
const pagesEl = document.getElementById("pages");
// Page count and page size are attacker-chosen, and on Android this frame
// shares the app's main thread: bound both so a hostile PDF can't hang the tab.
const MAX_PAGES = 300;
const MAX_CANVAS_PIXELS = 16e6;
const fail = () => { msg.hidden = false; msg.textContent = "Couldn't render this PDF here. Use Download to open it."; };
let started = false;
addEventListener("message", async e => {
  if (started || e.source !== parent || !e.data || e.data.type !== "efs-pdf") return;
  started = true;
  if (!e.data.lib) return fail();
  try {
    const blobUrl = src => URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const pdfjs = await import(blobUrl(e.data.lib));
    globalThis.pdfjsWorker = await import(blobUrl(e.data.worker));
    const doc = await pdfjs.getDocument({ data: e.data.bytes, enableXfa: false, useWorkerFetch: false }).promise;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const first = (await doc.getPage(1)).getViewport({ scale: 1 });
    const tasks = new Map();
    let anyRendered = false;
    const show = async canvas => {
      if (canvas.dataset.state) return;
      canvas.dataset.state = "rendering";
      try {
        const page = await doc.getPage(Number(canvas.dataset.page));
        if (canvas.dataset.state !== "rendering") return; // scrolled away meanwhile
        const base = page.getViewport({ scale: 1 });
        const fit = ((canvas.clientWidth || 800) * dpr) / base.width;
        const viewport = page.getViewport({ scale: Math.min(fit, Math.sqrt(MAX_CANVAS_PIXELS / (base.width * base.height))) });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.aspectRatio = base.width + " / " + base.height;
        const task = page.render({ canvas, viewport });
        tasks.set(canvas, task);
        await task.promise;
        canvas.dataset.state = "done";
        anyRendered = true;
        msg.hidden = true;
      } catch (err) {
        if (err && err.name === "RenderingCancelledException") return;
        canvas.dataset.state = "failed";
        if (!anyRendered) fail();
      } finally {
        tasks.delete(canvas);
      }
    };
    const hide = canvas => {
      if (canvas.dataset.state === "failed") return;
      tasks.get(canvas)?.cancel();
      delete canvas.dataset.state;
      canvas.width = canvas.height = 0; // frees the bitmap; aspect-ratio keeps the layout
    };
    // root: document, because rootMargin is ignored for the implicit root in a cross-origin frame.
    const observer = new IntersectionObserver(
      entries => entries.forEach(e => (e.isIntersecting ? show(e.target) : hide(e.target))),
      { root: document, rootMargin: "200% 0px" },
    );
    for (let n = 1; n <= Math.min(doc.numPages, MAX_PAGES); n++) {
      const canvas = document.createElement("canvas");
      canvas.dataset.page = String(n);
      canvas.style.aspectRatio = first.width + " / " + first.height; // until the page renders
      pagesEl.append(canvas);
      observer.observe(canvas);
    }
    if (doc.numPages > MAX_PAGES) {
      const more = document.createElement("div");
      more.id = "more";
      more.textContent = "Showing the first " + MAX_PAGES + " of " + doc.numPages + " pages. Use Download for the rest.";
      pagesEl.append(more);
    }
  } catch {
    fail();
  }
});
</script></body></html>`;

// A fresh frame per file: the frame renders only the first PDF it's sent.
let frameSeq = 0;
const frameKeys = new WeakMap<Uint8Array, number>();
const frameKeyFor = (bytes: Uint8Array) => {
  let key = frameKeys.get(bytes);
  if (key === undefined) frameKeys.set(bytes, (key = ++frameSeq));
  return key;
};

type PdfJsFrameProps = {
  bytes: Uint8Array;
  title: string;
  className?: string;
  style?: CSSProperties;
};

export const PdfJsFrame = ({ bytes, title, className, style }: PdfJsFrameProps) => {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sentTo = useRef<Window | null>(null);
  // Sent on load: the frame's module script has run by then, so its message
  // listener is in place. Sent once per frame, so a frame that navigates
  // itself can't make the app re-post pdf.js and the bytes in a loop.
  const handleLoad = async () => {
    const win = frameRef.current?.contentWindow;
    if (!win || sentTo.current === win) return;
    sentTo.current = win;
    let sources: string[] | null = null;
    try {
      sources = await loadPdfJsSources();
    } catch (err) {
      console.error("pdf.js load failed", err);
    }
    if (frameRef.current?.contentWindow !== win) return; // replaced while fetching
    const data = bytes.slice();
    // "*" because the sandboxed frame's origin is opaque; nothing here is secret.
    win.postMessage({ type: "efs-pdf", lib: sources?.[0], worker: sources?.[1], bytes: data }, "*", [data.buffer]);
  };

  return (
    <iframe
      key={frameKeyFor(bytes)}
      ref={frameRef}
      sandbox="allow-scripts"
      srcDoc={FRAME_HTML}
      onLoad={handleLoad}
      title={title}
      className={className}
      style={style}
    />
  );
};
