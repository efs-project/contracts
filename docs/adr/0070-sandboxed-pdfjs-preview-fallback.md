# ADR-0070: Sandboxed pdf.js preview where the browser has no PDF viewer

**Status:** Accepted
**Date:** 2026-11-04
**Related:** Amends ADR-0069 in part (its third guard: no built-in viewer → Download only); ADR-0056 (render isolation); `specs/overview.md` § Load-bearing invariants
**Permanence-tier:** Ephemeral (client render path; changeable in any client release)

## Context

ADR-0069 renders PDF previews in the browser's own viewer, unsandboxed, and shows only a Download button when `navigator.pdfViewerEnabled === false`. Chrome on Android is that case. Since Chrome 135 it can open a PDF full-screen on a top-level navigation, but it still can't show one inside a frame and still reports `pdfViewerEnabled === false`. So phones, a large share of visitors, saw no preview for the most common document type in the corpus. ADR-0069 rejected pdf.js because of its size, but its Consequences already name "a sandboxed pdf.js renderer" as the acceptable alternative. On 2026-11-04 James asked for pdf.js on the devices that need it, with native rendering kept everywhere else.

## Decision

When ADR-0069's first two guards hold (client-typed `application/pdf`, real `%PDF-` header) but the browser reports `navigator.pdfViewerEnabled === false`, the client draws the PDF with pdf.js (`pdfjs-dist`, pinned exactly) inside a sandboxed iframe instead of offering only Download. Browsers with a viewer keep ADR-0069's native path unchanged.

The pdf.js frame keeps ADR-0056's isolation:

1. `sandbox="allow-scripts"` with no `allow-same-origin`, so the frame has an opaque origin and can't reach the app's DOM, cookies or storage.
2. A CSP inside the frame: `default-src 'none'`, scripts only inline or from the frame's own `blob:` URLs, no `connect-src`, no `unsafe-eval`. pdf.js makes no requests and can't `eval`. The CSP is defence in depth, not the boundary: script that escaped pdf.js could still navigate the frame itself or open WebRTC, which leaks the viewer's IP, exactly as in the sandboxed HTML preview. The boundary is the opaque origin.
3. The app posts the pdf.js code and the PDF bytes in. The frame imports pdf.js from its own blob URLs, because an opaque origin can't load the app's module files. Chromium won't start a Worker from a blob in an opaque origin, so pdf.js parses on the frame's main thread.
4. Pages are drawn to canvases only. There's no annotation or text layer, so a PDF can't place a live link and the frame has nothing to navigate.
5. Page count and page size are attacker-chosen, and on Android the frame shares the app's main thread. The frame lays out at most 300 pages (then points to Download), caps each canvas at 16 MP, and clears pages that scroll far out of view.

pdf.js is fetched only when this fallback runs. Browsers with a native viewer never download it.

## Consequences

- PDF previews work on Chrome for Android and any other browser without a built-in viewer.
- The client now carries a ~1.7 MB dependency (served as two static files, never in the main bundle), and pdf.js parser bugs become the client's to track. The sandbox bounds what a parser bug can reach: script in an opaque-origin frame with no access to the app, the same as the HTML preview already allows.
- No text selection, search or clickable links in the fallback view; Download remains for that. Fonts or images that pdf.js loads from external data (standard-font files, CJK CMaps, JPX/JBIG2 wasm decoders) fall back to its built-in substitutes or render blank.
- Parsing on the frame's main thread can stall the preview on a very large PDF. On Android the frame usually shares the app's renderer, so a heavy PDF can stall the app too; the page and pixel caps bound rendering, not parsing.
- Any future client rendering PDFs must use either ADR-0069's guarded native viewer or an equally isolated renderer.

## Alternatives considered

- **Open in Chrome's own viewer** (an "Open" button that navigates to the PDF). Works only on Android 15+, leaves the page, and needs a top-level navigation to attester-controlled bytes, which ADR-0056 forbids.
- **pdf.js in the app's own origin.** Simplest and allows a Worker, but parses untrusted bytes with the app's privileges (CVE-2024-4367 was arbitrary script in exactly that position).
- **Keep Download only.** No new dependency, but leaves phones without a preview.
