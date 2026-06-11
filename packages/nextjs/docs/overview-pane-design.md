# Design: per-item "Overview" markdown pane (v1, view-only)

**Date:** 2026-06-10
**Branch:** `markdown-for-items`
**Surface:** `packages/nextjs/` debug UI only (Ephemeral). No contract / schema / ADR changes.
**Status:** awaiting James's review before implementation.

## Goal

When viewing any EFS item — folder, file, address, schema, or attestation — the
explorer shows a configured, rendered Markdown page for that item in a pane next
to the tree. Like GitHub's "a folder shows its README," generalized to every
item type, and expressive enough to approximate a Wikipedia-style article.

Three-pane layout: **tree | Overview pane | folder-contents / file-preview**.
The Overview pane is **optional** — it only renders when the current item
actually has a configured page; otherwise the view stays two-pane.

## The model (settled — see planning/Decisions.md 2026-06-10)

A page is **a normal Markdown file** (DATA + MIRROR) that is a child of the item
and carries a `system` TAG. It is NOT a new schema or a special property. The
client:

1. Lists the current item's children, lens-scoped.
2. Finds children carrying the active lens's `system` TAG.
3. Picks the page: first match by filename precedence
   `README.md` -> `index.md` -> `overview.md` -> `about.md` (case-insensitive),
   restricted to children that sniff as Markdown/text.
4. Fetches its bytes via the existing `EFSRouter.request()` path.
5. Sniffs -> (optionally) integrity-checks -> sanitizes -> renders.

The `system` TAG also drives a **"show hidden / system files" toggle**: system-
tagged files are hidden from the right-pane file list by default (OS-file-explorer
model), revealed by the toggle. `system` is the general hide-bucket for future
OS-ish files (thumbnails, indexes).

### Naming (researched)

- **Recognized filename:** `README.md` (with the precedence fallbacks above).
  Maximum author muscle-memory; the filename is a tie-breaker/intent signal on
  top of the `system` TAG, which is the real selector.
- **UI label:** **"Overview."** Reads naturally across every item type
  ("Overview" of an address / schema / attestation / folder), where "README"
  feels odd on a non-folder. "wiki" is reserved for a future aggregate
  interlinked graph, not the per-item unit.

## Architecture

Three new, well-bounded units plus one small refactor of code we touch.

### 1. `lib/efs/fetchFileContent.ts` (extracted util)

Today `fetchFileContent` is a closure inside `FileBrowser.tsx` (~L533-693). It
calls `EFSRouter.request(pathSegments, queryParams)` and already handles:
on-chain SSTORE2 chunk reassembly (EIP-7617 `web3-next-chunk` pagination),
external-mirror delegation (`message/external-body` -> `resolveGatewayUrl` ->
`fetch`), and lens-scoped `contentType` extraction.

Extract it into a shared, framework-light async util returning
`{ bytes: Uint8Array, contentType: string | null, source: "onchain" | "mirror" }`.
Reuse it from both `FileBrowser` (unchanged behavior) and the new hook. This is
the one justified tidy-up — code we're already working in, not a drive-by.

### 2. `hooks/efs/useItemOverview.ts`

`useItemOverview(anchorUID, lensAddresses, { dataSchemaUID, anchorSchemaUID, ... })`

Resolves the item's Overview, returning a discriminated state:
`loading | none | { kind: "markdown", text } | { kind: "binary", contentType, downloadUrl, size } | { kind: "error", message } | { kind: "too-large", size }`.

Steps:
- List children via `EFSFileView.getDirectoryPageBySchemaAndAddressList`
  (lens-scoped; first-lens-wins, same as file resolution).
- Resolve the `system` tag-set for the active lenses (reuse FileBrowser's
  existing `resolveTagSet` pattern — the same path that does `nsfw`).
- Choose the candidate by filename precedence among system-tagged children.
- Fetch bytes via the extracted util.
- **Size cap** (see Security) before decode.
- **Sniff** bytes to classify markdown/text vs binary.
- Return the appropriate state. Cancel-guarded against rapid navigation, like
  the existing path-resolution effects.

### 3. `components/explorer/OverviewPane.tsx`

Presentational. Consumes `useItemOverview`. Renders:
- `markdown` -> `<MarkdownView source={text} />` inside a themed panel.
- `binary` -> a download/open card (filename, detected type, size, source).
- `too-large` -> "Too large to preview (N MB)" + download link.
- `error` -> inline error.
- `none` -> the pane is not rendered at all (parent checks state first).

Collapsible; remembers collapsed state per session (localStorage). Labeled
"Overview."

### 4. `components/markdown/MarkdownView.tsx` (the ~40-60 line renderer)

The single sanitized render path. No raw-HTML injection sink (no `rehype-raw`,
no React HTML-string escape hatch).

```
remarkPlugins:  [remarkGfm]
rehypePlugins:  [rehypeSlug, rehypeAutolinkHeadings, [rehypeSanitize, efsSchema]]  // sanitize LAST
components:     { a: <override>, img: <override> }                                  // future-EFS seam
```

- Wrapped in `<article className="prose max-w-none">`.
- `components.a` / `components.img` are the reserved seams for future `efs://`
  link -> in-app navigation and image -> async EFS-blob resolution. **Built as
  thin pass-throughs in v1** (see Images), with full access to the parsed node.

### 5. Layout + toggle wiring (`ExplorerClient.tsx`, `FileActionsBar`, `FileBrowser`)

- Insert `<OverviewPane>` as a middle column between the tree `<aside>` and the
  file `<section>`. Rendered only when `useItemOverview` state is renderable.
  Below `lg`, it stacks above the file browser / is toggleable rather than
  crushing the columns.
- Add a "show hidden / system files" toggle in `FileActionsBar`; thread a
  `showSystemFiles` flag into `FileBrowser`, which filters out items in the
  `system` tag-set unless the flag is set. Toggle state persisted in
  localStorage.

## Markdown stack (assemble, not adopt)

Decisive research outcome: build a thin wrapper over `react-markdown`; do not
adopt a batteries-included viewer (`@uiw/react-markdown-preview` bundles v9 +
unsanitized GitHub CSS that fights daisyUI; Streamdown is for AI streaming; MDX
executes JSX — categorically unsafe for untrusted input).

Dependencies (Tier-2 courtesy flag — these are the substance of the approved
feature, on the Ephemeral debug UI):

| Package | Version | Role |
|---|---|---|
| `react-markdown` | ^10 | renderer (React elements, not an HTML string) |
| `remark-gfm` | ^4 | tables, footnotes, task lists, strikethrough, autolinks |
| `rehype-sanitize` | ^6 | sanitize — **last** rehype plugin |
| `rehype-slug` | ^6 | stable heading `id`s (anchors + `#fragment` links) |
| `rehype-autolink-headings` | ^7 | clickable heading anchors |
| `@tailwindcss/typography` | ^0.5 (dev) | `prose` classes |

Gives Wikipedia-style richness now: headings-with-anchors, tables, footnotes,
blockquotes, fenced code, task lists, autolinks. Auto-TOC is deferred (anchors
are enough for v1).

### Styling (Tailwind v3.4 + daisyUI v4.12 — repo reality)

The repo is **not** on Tailwind v4 / daisyUI v5, so `prose` is not auto-themed.
Add `require("@tailwindcss/typography")` to `tailwind.config.js` plugins, and add
a small mapping in `styles/globals.css` so `prose` follows the active daisyUI
theme via its oklch CSS vars:

```css
.prose {
  --tw-prose-body: oklch(var(--bc));
  --tw-prose-headings: oklch(var(--bc));
  --tw-prose-links: oklch(var(--p));
  --tw-prose-bold: oklch(var(--bc));
  --tw-prose-code: oklch(var(--bc));
  --tw-prose-quotes: oklch(var(--bc) / 0.8);
  --tw-prose-bullets: oklch(var(--bc) / 0.5);
  --tw-prose-hr: oklch(var(--b3));
  --tw-prose-th-borders: oklch(var(--b3));
  --tw-prose-td-borders: oklch(var(--b3));
  --tw-prose-pre-bg: oklch(var(--b2));
  --tw-prose-pre-code: oklch(var(--bc));
}
```

(Exact var list finalized during implementation; the app chrome stays its
monospace "terminal" aesthetic — the prose body may use a more readable family
for long-form, a polish detail.)

## Security & integrity (hard requirements, adversarially validated)

**MUST hold in v1:**

1. **Sanitize last, tightened schema.** Extend `defaultSchema`: link protocols
   `http/https/mailto` only; image `src` effectively disabled in v1 (see Images);
   allow regex-constrained `id` (`/^user-content-/`, keep `clobberPrefix`) so
   `rehype-slug` anchors and GFM footnotes survive; allow table `align`,
   task-list checkboxes, fenced-code `language-*`. **Never** allow
   `svg`/`iframe`/`math`/`style`/`script`/`on*`. No `rehype-raw`. Do not override
   react-markdown's `urlTransform` (keep its protocol gate as defense-in-depth).
2. **Single render path** — react-markdown builds React elements; no raw-HTML
   injection sink anywhere (no second sanitizer to drift).
3. **Don't trust `contentType`** (attester-controlled). Independently sniff:
   `TextDecoder('utf-8', { fatal: true })` over the head + NUL/control-byte and
   magic-number checks (`%PDF`, PNG/JPEG/GIF, zip `PK`, gzip `1F 8B`). Binary ->
   download card, never inline.
4. **Size cap ~1-2 MB** before parse; over cap -> "too large" + download link.
5. **`target="_blank"` links get `rel="noopener noreferrer"`** via the `a`
   override.

### Images (v1: block external loading)

Per James: do **not** load external `https://` images (viewer-IP-leak / privacy).
"Real" images mean EFS-native image resolution, which is the deferred complex
work. So v1: the `img` override renders an **inert placeholder + alt text** (no
network fetch). The override is the exact seam where future EFS-blob resolution
plugs in. Blocking is trivial; resolving is future work.

### contentHash (deferred — option (b))

The page is rendered safely regardless of byte integrity (sanitizer covers XSS),
and on-chain content comes straight from chain state, so a hash check only adds
*integrity* signal for external mirrors. v1 does **not** build the
multihash/CID verifier. Optionally, a non-blocking best-effort check reusing the
existing `keccak256` `verifyContentHash` when `source === "mirror"`, surfaced as
a small "unverified" badge — never blocking the render.

> Note for `docs/decisions.md`: the spec frames `contentHash` as a self-describing
> multihash/CID, but the live devnet reality is a raw `bytes32` written as bare
> `keccak256(bytes)` (seed/simulate scripts). The `bytes32` field can't hold a
> multibase string, so any future verifier must reconcile spec vs. on-chain
> encoding. Out of scope for this client feature; recorded so it isn't lost.

## Future-proofing (designed-for, not built)

The `components={{ a, img }}` seam + a `protocols` allowlist make later work a
localized change: `efs://` (or relative) links -> in-app navigation to other
items; `efs`-ref images -> async blob resolution. Pin these invariants now so we
don't repaint: a single gateway-allowlist config constant; blob URLs always
revoked on unmount and never navigated to (only `download`); in-app navigation
resolves to a typed route, never a raw attacker string.

## SDK boundary (keep EFS machinery thin)

An EFS SDK is in progress (`efs-project/sdk`, branch `chore/scaffold`). This
feature does not depend on it, but it must not hand-roll robust versions of
things the SDK will own — those stay thin and isolated behind one seam each, so
swapping to the SDK later is a localized change, not a rewrite.

- **EFS machinery the SDK will own — keep thin, delegate-ready:** fetching bytes
  from mirrors / the router (the single `lib/efs/fetchFileContent.ts` util),
  lens-scoped directory + `system`-tag + README resolution (centralized in
  `useItemOverview`), and content addressing / hashing. **Do not** build a
  multihash/CID verifier or any canonical-hashing logic — that is squarely SDK
  territory (it must hash identically across clients), which is exactly why
  `contentHash` is deferred above. Reuse the existing router path as-is; don't
  over-engineer mirror retrieval/fallback robustness the SDK will replace.
- **Client-only concerns — build properly now:** the sanitized Markdown renderer
  and schema, byte-sniffing, the `OverviewPane`, the 3-pane layout, and the
  hidden-files toggle. The SDK won't own web rendering/UX; these are ours.

Litmus test for any added complexity: "would the SDK make this trivial?" If yes,
keep it minimal and isolated rather than polishing it here.

## Non-goals (v1)

No editing / authoring affordance (existing create-file + tag-as-`system` flows
already work). No version history. No external image loading. No `efs://` link /
image resolution. No auto-TOC. No multihash/CID verification. Client-only.

## File-change summary

- **New:** `lib/efs/fetchFileContent.ts`, `hooks/efs/useItemOverview.ts`,
  `components/explorer/OverviewPane.tsx`, `components/markdown/MarkdownView.tsx`,
  `lib/markdown/schema.ts` (sanitize schema), a byte-sniff util.
- **Edit:** `ExplorerClient.tsx` (insert pane column), `FileActionsBar.tsx`
  (toggle), `FileBrowser.tsx` (consume extracted util; `showSystemFiles` filter),
  `tailwind.config.js` (+typography plugin), `styles/globals.css` (prose vars),
  `package.json` (deps).

## Testing

- Unit: byte-sniff classifier (markdown/text vs PDF/PNG/zip/NUL); filename
  precedence selection; size-cap boundary; sanitize schema rejects the markdown
  XSS vector set (`javascript:`/`data:` links, raw script/`onerror`/`iframe`/
  `svg onload`, allows footnotes/anchors/tables/task-lists).
- `yarn next:check-types` clean; Jest `transformIgnorePatterns` allow-lists the
  ESM remark/rehype graph.
- Manual: seed an item with a `system`-tagged `README.md`, confirm it renders in
  the Overview pane, the hidden-files toggle reveals/hides it, a non-markdown
  `system` file shows a download card, and an item with no page stays two-pane.
