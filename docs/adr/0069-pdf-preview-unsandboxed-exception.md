# ADR-0069: PDF preview is rendered unsandboxed (narrow exception to ADR-0056 render isolation)

**Status:** Accepted
**Date:** 2026-10-26
**Related:** Amends ADR-0056 in part (its "sandboxed iframe" mechanism, for PDFs only); PR #50; commit `61afaee` (the sandbox this reverses); `specs/overview.md` § Load-bearing invariants
**Permanence-tier:** Ephemeral (client render path; changeable in any client release)

## Context

ADR-0056 moved render safety to the client: rendered mirror content must be isolated, by default in a sandboxed iframe. Commit `61afaee` applied that to the debug UI's PDF preview (`sandbox="allow-scripts"`). From then on every PDF in the explorer showed Chrome's "blocked" icon. Chromium never starts its built-in PDF viewer in a sandboxed frame, and no sandbox token turns it back on, so a sandboxed PDF frame is always blank in Chrome. Reproduced on app.efs.eth.limo on 2026-10-26: the same blob URL showed all 9 pages of `bitcoin.pdf` unsandboxed and stayed blank sandboxed.

## Decision

The client renders a PDF preview in an **unsandboxed** iframe, and only when all three guards hold:

1. The frame source is a blob the client typed exactly `application/pdf`. The type is never copied from the mirror, so the browser hands the bytes to its PDF viewer and never parses them as a document in the app's origin.
2. The bytes carry a real `%PDF-` header in the first 1 KiB (`looksLikePdf`). Mislabeled bytes fall back to the binary placeholder.
3. The browser has a built-in PDF viewer (`navigator.pdfViewerEnabled !== false`). Without one, an unsandboxed frame would download the file as soon as it was selected, so the client shows the Download button instead.

Isolation for PDFs comes from the browser's PDF viewer, which runs PDF content (including PDF JavaScript) outside the embedding page's origin. Every other rendered type keeps ADR-0056's sandboxed-iframe rule unchanged. HTML in particular stays `sandbox="allow-scripts"` without `allow-same-origin`.

James chose this on 2026-10-26 over the two alternatives below.

## Consequences

- PDFs preview again in Chromium, Firefox and Safari.
- The client's PDF safety now depends on the browser's PDF viewer staying isolated, not on a sandbox the client controls. A browser that rendered PDFs in the embedder's origin would break that; none of the major engines do.
- Any future client (the v2 client, the SDK) that renders PDFs must apply the same three guards or use a sandboxed pdf.js renderer.

## Alternatives considered

- **pdf.js inside a sandboxed iframe.** Keeps the sandbox, but adds a large dependency to a legacy v1 client and makes the client responsible for patching pdf.js parser bugs.
- **No inline PDF preview** (Download only). Safe and trivial, but drops a core explorer feature for the most common document type in the corpus.
