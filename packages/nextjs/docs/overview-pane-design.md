# Design: per-item "Overview" markdown pane (v1, view-only)

**Date:** 2026-06-10
**Branch:** `markdown-for-items`
**Surface:** `packages/nextjs/` debug UI (Ephemeral) + a small demo-seed addition
in `packages/hardhat` (dev data only). No contract / schema / ADR changes.
**Status:** revised after 3-way review (feasibility / security / requirements);
awaiting James's review before implementation.

## Goal

When viewing any EFS item — folder, file, address, schema, or attestation — the
explorer shows a configured, rendered Markdown page for that item in a pane next
to the tree. Like GitHub's "a folder shows its README," generalized to every
item type, and expressive enough to approximate a Wikipedia-style article.

Three-pane layout: **tree | Overview pane | folder-contents / file-preview**.
The Overview pane is **optional** — it only renders when the current item
actually has a configured page; otherwise the view stays two-pane. (This is the
agreed resolution of the brief's "empty state when none": no passive empty pane.
Discoverability/authoring of a missing Overview is out of scope for view-only
v1 — authoring already works via the existing create-file + tag flows.)

## The model (settled — see planning/Decisions.md 2026-06-10)

A page is **a normal Markdown file** (DATA + MIRROR) that is a child of the item
and carries a `system` TAG. It is NOT a new schema or a special property.

Every item type works because the explorer already reduces each to a single
`bytes32` parent (`currentAnchorUID`): a folder anchor, a **file anchor** (a file
leaf is itself an anchor that can host children — confirmed in `ExplorerClient`
path resolution), an address-derived parent, or an alias anchor for
schema/attestation (ADR-0033). Listing children of that parent is uniform.

Resolution (lens-scoped):

1. List the item's children via `EFSFileView.getDirectoryPageBySchemaAndAddressList`.
2. Resolve the **`system` tag-set** for the active lenses (see "system tag
   convention" below) — the set of system-tagged child **anchor UIDs**.
3. **Select** the page, deterministically: first-lens-wins; within a lens, the
   system-tagged child named exactly `README.md`, else none. Anchor names are
   CASE-SENSITIVE on-chain (`README.md` ≠ `readme.md` ≠ `ReadMe.md` are distinct
   anchors), so we match one canonical name exactly — no case-folding, no
   precedence list, no markdown-ish fallback (simplified per James 2026-06-11).
   The `system` tag remains the separate, general hide-bucket for keeping the
   file list clean.
4. **Fetch** that child's bytes via the extracted router util.
5. **Sniff** the bytes (don't trust `contentType`); if markdown/text → sanitize
   and render; if binary → download card. (Order is pick → fetch → sniff, NOT
   sniff-to-select — we fetch only the single selected candidate.)

### `system` tag convention (chosen — resolves the review's critical finding)

A 3-way review found that reusing `FileBrowser.resolveTagSet` + its `matchesUID`
path would **silently fail**: that path returns a mixed set of DATA-UIDs and
anchor-UIDs and matches file items through a `dataUIDMap` that is only populated
when a tag filter is already active. So this feature does **not** piggyback on
that machinery.

Instead, we fix the convention: the **`system` TAG targets the file's ANCHOR
UID**, filed under **`anchorSchemaUID`** (the anchor's EAS schema, verified
on-chain — an anchor-targeted TAG files under the target anchor's EAS schema
bucket; querying `anchorSchemaUID` returns the seeded README anchor uids,
`dataSchemaUID` returns `[]`). The README **file** is separately *listed* under
**`dataSchemaUID`** via `EFSFileView.getDirectoryPageBySchemaAndAddressList`.
Both schemas are used, for different steps: listing = dataSchema, tag-query =
anchorSchema. Both the Overview resolver and the hidden-files filter match the
system set directly against a directory item's `uid` (the directory-item uid is
the ANCHOR uid). This is:
- simplest (no per-child DATA-UID round-trip, no dependence on `dataUIDMap`),
- correct for "system/hidden is a placement role of this file at this path,"
- a deliberate, documented divergence from the `nsfw`-on-DATA convention; the
  SDK can normalize tag-target conventions later.

A small shared helper `resolveSystemAnchorSet(parentUID, lensAddresses, anchorSchemaUID)`
does: `resolvePath(fsRoot, "tags")` → `resolvePath(tagsRoot, "system")` →
`EdgeResolver.getActiveTargetsByAttesterAndSchema(systemDef, lens, anchorSchemaUID)`
per lens, unioned into a `Set<anchorUID>`. Used by both the hook and the
hidden-files filter. Degrades to empty (feature simply absent) if `/tags/system`
doesn't exist.

## Architecture

Three new well-bounded units, one shared helper, plus targeted edits.

### 1. `lib/efs/fetchFileContent.ts` (extracted util)

Today `fetchFileContent` is a closure in `FileBrowser.tsx` (~L533-693) entangled
with component state. Extract a **pure async** function:

```
fetchFileContent({ routerAddress, routerAbi, publicClient, lensAddresses, resourcePath })
  -> Promise<{ bytes: Uint8Array; contentType: string | null; source: "onchain" | "mirror" }>
```

It keeps the existing logic: `EFSRouter.request(resourcePath, queryParams)`,
on-chain SSTORE2 chunk reassembly (EIP-7617 `web3-next-chunk` pagination),
external-mirror delegation (`message/external-body` → `resolveGatewayUrl` →
`fetch`), lens-scoped `contentType` extraction. The cancellation guard
(`fetchIdRef`) and all `setState` calls **stay in the callers** — the util is
side-effect-free and returns a promise. `FileBrowser` is refactored to call it
and apply results to its own state; this is the one existing path we touch, so
it gets explicit before/after regression checking (the `fetchIdRef` guard must
remain intact).

### 2. `hooks/efs/useItemOverview.ts`

`useItemOverview({ anchorUID, lensAddresses, resourcePathNames, dataSchemaUID, anchorSchemaUID, indexerInfo, routerInfo, edgeResolverAddress })`

Returns a discriminated state:
`loading | none | { kind:"markdown", text, source } | { kind:"binary", contentType, bytes, fileName, size, source } | { kind:"too-large", size } | { kind:"error", message }`.

Steps: list children (lens-scoped) → `resolveSystemAnchorSet` → select candidate
(§model step 3) → `fetchFileContent` with `resourcePathNames` + selected name →
**size cap** before decode → **sniff** → return state. Cancel-guarded against
rapid navigation. Needs `resourcePathNames` (the router path prefix for the
current item, i.e. the equivalent of `currentPathNames`) so it can address the
selected child — threaded from `ExplorerClient`.

### 3. `components/explorer/OverviewPane.tsx`

Presentational; consumes `useItemOverview`. Renders: `markdown` →
`<MarkdownView>` in a themed panel; `binary`/`too-large` → a **safe download
card** (see Security M2); `error` → inline error; `none` → parent renders no
pane. Labeled **"Overview."** Collapsible, with a small provenance line when
`source === "mirror"` ("served from an external mirror"). Collapsed state
persisted in localStorage under a single global key (not per-item). Given a
readable measure for long-form prose, the column has a sensible default/max
width between the tree and the contents pane.

### 4. `components/markdown/MarkdownView.tsx` (~40-60 lines)

Single sanitized render path. No raw-HTML injection sink (no `rehype-raw`, no
HTML-string escape hatch).

```
remarkPlugins:  [remarkGfm]
rehypePlugins:  [rehypeSlug, [rehypeAutolinkHeadings, { behavior: "wrap" }], [rehypeSanitize, efsSchema]]  // sanitize LAST
components:     { a: <EfsLink>, img: <EfsImage> }                                                          // future-EFS seam
```

- `behavior: "wrap"` is **pinned** (review M1): it wraps heading text in the
  anchor and injects no extra span/svg/aria/tabindex nodes — nothing the tight
  schema would strip, so anchors don't break and the schema needn't widen.
- Wrapped in `<article className="prose prose-efs max-w-none">` (a dedicated
  class so the dark-theme `!important` `bg-base-200` rules and the global
  monospace `body` font don't bleed in; prose font set explicitly).
- `components.a`/`components.img` are the reserved seams for future `efs://`
  link → in-app navigation and image → async EFS-blob resolution. In v1:
  `EfsLink` opens absolute http/https in a new tab with
  `rel="noopener noreferrer"`, and renders relative / non-allowlisted hrefs as
  **inert text** (no navigation — see M3); `EfsImage` renders an inert
  placeholder + alt only (see Images).

### 5. Layout + hidden-files toggle

- Insert `<OverviewPane>` as a middle column between the tree `<aside>` and the
  file `<section>` in `ExplorerClient.tsx`, rendered only when the hook state is
  renderable. Below `lg` it stacks above the file browser / is toggleable.
- Add a "show hidden / system files" toggle in `FileActionsBar`; thread
  `showSystemFiles` into `FileBrowser`, which hides items whose `uid` is in the
  `resolveSystemAnchorSet` result unless the flag is set. This is a **dedicated**
  filter using the anchor-targeted set above — independent of the existing
  `drawerTagFilters`/`matchesUID` DATA-targeted path. Toggle persisted in
  localStorage.

## Markdown stack (assemble, not adopt)

Build a thin wrapper over `react-markdown`; do not adopt a batteries-included
viewer (`@uiw/react-markdown-preview` bundles v9 + unsanitized GitHub CSS that
fights daisyUI; Streamdown targets AI streaming; MDX executes JSX — unsafe for
untrusted input).

Dependencies (Tier-2 courtesy flag; substance of the approved feature, on the
Ephemeral debug UI):

| Package | Version | Role |
|---|---|---|
| `react-markdown` | ^10 | renderer (React elements, not an HTML string) |
| `remark-gfm` | ^4 | tables, footnotes, task lists, strikethrough, autolinks |
| `rehype-sanitize` | ^6 | sanitize — **last** rehype plugin |
| `rehype-slug` | ^6 | stable heading `id`s |
| `rehype-autolink-headings` | ^7 | clickable heading anchors (`behavior:"wrap"`) |
| `@tailwindcss/typography` | ^0.5 (dev) | `prose` classes |

Wikipedia-style richness: headings-with-anchors, tables, footnotes, blockquotes,
fenced code, task lists, autolinks. Auto-TOC deferred (anchors suffice for v1).

### Styling (Tailwind v3.4 + daisyUI v4.12 — verified repo reality)

Add `require("@tailwindcss/typography")` to `tailwind.config.js` plugins; add a
`prose-efs` mapping in `styles/globals.css` so prose follows the active daisyUI
theme via its oklch vars, and so the dark-theme global `!important` surface rules
and monospace `body` font don't override the pane:

```css
.prose-efs {
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
  /* explicit readable family for long-form, overriding the global mono body */
  font-family: ui-sans-serif, system-ui, sans-serif;
}
```

(Exact var list finalized in implementation.)

## Security & integrity (hard requirements — adversarially reviewed)

**MUST hold in v1:**

1. **Sanitize last, explicit allowlist (M3/M4).** Extend `defaultSchema` and make
   the sanitize schema the source of truth (do NOT rely on react-markdown's
   `urlTransform`, whose default allows `irc/ircs/xmpp` + relative). Set
   `protocols.href: ['http','https','mailto']` explicitly; **`img` is removed from
   `tagNames` (and its `src`/`srcset`/`loading`/`referrerpolicy` stripped)** so no
   network image request can fire (A1). Keep `defaultSchema`'s built-in
   `clobberPrefix: 'user-content'` + `clobber: ['name','id']` for DOM-clobber
   defense — do **not** hand-roll an `id` regex (M4). Allow table `align`,
   task-list checkboxes, fenced-code `language-*`. **Never** allow
   `svg`/`iframe`/`math`/`style`/`script`/`on*`. No `rehype-raw`.
2. **Single render path** — React elements only; no raw-HTML sink anywhere.
3. **`behavior:"wrap"` on autolink-headings (M1)** so no injected node needs the
   schema widened.
4. **Don't trust `contentType`** (attester-controlled). Independently sniff:
   `TextDecoder('utf-8',{fatal:true})` over the head + NUL/control-byte and
   magic-number checks (`%PDF`, PNG/JPEG/GIF, zip `PK`, gzip `1F 8B`). Binary →
   download card, never inline.
5. **Size cap (1 MB) AND a structural guard (A2).** Cap bytes before parse; after
   parse, reject if hast node-count > ~50k or blockquote/list nesting depth > 32
   (mirrors ADR-0021 `MAX_ANCHOR_DEPTH`). Either → "too large / too complex" +
   download card. Pure byte-cap alone is insufficient (structural amplification).
6. **Safe download card (M2).** Build the blob with a **neutral type only**
   (`application/octet-stream`), offer **download only — never open/navigate to
   the blob URL**, **sanitize the filename** (strip path separators, control
   chars, bidi/zero-width `‪-‮`/`⁦-⁩`/`​-‏`; clamp
   to `[A-Za-z0-9._-]` + length; `.bin` if a dangerous ext was stripped), and
   **revoke the object URL on unmount/navigation**.
7. **Link policy (M3).** Absolute `http/https` → new tab + `rel="noopener
   noreferrer"`. `mailto` allowed. **Relative and protocol-relative (`//host`,
   `/path`) hrefs are rendered inert (non-navigating) in v1** — lenses are the
   trust boundary, and a bare relative link could smuggle a lens-swap. In-app
   navigation arrives with the future `efs://` seam, resolving to a typed route.

### Images (v1: block external loading)

Per James: don't load external images (viewer-IP-leak / privacy). v1 strips `img`
in the sanitize schema AND renders an inert placeholder + alt via the `img`
override (defense in depth, A1). The override is the seam where future EFS-blob
image resolution plugs in.

### contentHash / provenance (deferred verification — judgment call)

Two reviewers split: security wanted a mandatory "unverified" badge; requirements
wanted the optional keccak badge cut as a half-feature. Resolution honoring
James's "ignore contentHash unless needed": **build no hash verification at all**,
but show a small, honest **provenance line when `source === "mirror"`** ("served
from an external mirror") — this is just labeling the fetch source we already
track, not a hashing feature, and it avoids rendering mirror-served prose with
zero provenance signal. On-chain content carries no such line (it's trusted chain
state). The `bytes32`-keccak vs. spec'd-multihash discrepancy is recorded in
`docs/decisions.md` and surfaced to James (a contracts spec-vs-impl item, Tier 2,
pre-existing — out of scope for this client feature).

## SDK boundary (keep EFS machinery thin)

An EFS SDK is in progress (`efs-project/sdk`, `chore/scaffold`). This feature
doesn't depend on it but must not hand-roll robust versions of what it will own.

- **EFS machinery (thin, delegate-ready):** mirror/router fetch
  (`fetchFileContent`), lens/`system`-tag/README resolution (`useItemOverview` +
  `resolveSystemAnchorSet`), content addressing/hashing. **No** multihash/CID
  verifier or canonical-hashing logic — SDK territory (must hash identically
  cross-client); this is why `contentHash` verification is deferred. Reuse the
  existing router path as-is.
- **Client-only (build properly):** the sanitized renderer + schema, sniffing,
  `OverviewPane`, layout, hidden-files toggle.

Litmus: "would the SDK make this trivial?" If yes, keep it minimal and isolated.

## Future-proofing (designed-for, not built)

The `components={{ a, img }}` overrides **plus the sanitize schema's `protocols`
allowlist** are the seam for later `efs://` links → typed in-app navigation and
`efs`-ref images → async blob resolution. (Note for the future implementer: the
schema, not just the overrides, must be extended to admit `efs://`, or sanitize
strips it first.) Invariants pinned now: a single gateway-allowlist config
constant; blob URLs always revoked on unmount and never navigated to (download
only); in-app navigation resolves to a typed route, never a raw attacker string.

## Holistic review (2026-06-10) inputs + branch base

The all-repo holistic review (`planning/Reviews/2026-06-10-holistic-review.md`)
touched this feature at five points:

- **SEC-1 / UX-6 (validates the design):** the router emits the attester-set
  `contentType` *unsanitized* (header-injection capable), confirming it is
  attacker-controlled — so the independent byte-sniff (not trusting
  `contentType`) is the right call. Magic-bytes sniffing is explicitly endorsed.
- **DX-4 (no exposure):** EdgeResolver emits no events; this read-only,
  `eth_call`-based feature doesn't depend on the event surface.
- **DX-2 (fold in):** the SDK's intended-but-stubbed shape exposes
  `fetch(ref, opts) -> bytes` and `hashContent`. Shape `lib/efs/fetchFileContent.ts`
  to converge with that signature so the eventual SDK swap is clean.
- **UX-5 (flag):** the review rates "verify bytes against `contentHash`" as High
  for the hackathon, but explicitly as **SDK read-path** work — consistent with
  our deferral. The provenance line stays; the verified/mismatch badge is a clean
  later add once the SDK owns hashing.

**Branch base:** built on `main`. Verified the `schema-freeze` worktree does
**not** modify the debug-UI files this feature reuses (`FileBrowser.tsx`,
`ExplorerClient.tsx`, `useLensesDirectoryPage.ts` are byte-identical to main), so
a later rebase onto the frozen schemas is trivial — the reused machinery matches
and all new code is additive. contentHash being deferred further insulates this
feature from ADR-0049's DATA-struct change.

## Non-goals (v1)

No editing/authoring affordance. No version history. No external image loading.
No `efs://` link/image resolution. No auto-TOC. No multihash/CID verification.
Client-only (plus demo-seed data).

## Demo-seed data (new — needed to test end-to-end)

No existing seed creates `/tags/system` or any system-tagged file. Add an
idempotent step (in `packages/hardhat` seed, dev-only, matching the existing
fail-soft/localhost-only guards): create `/tags/system`, and on a demo folder
(e.g. `/docs`) attest a `README.md` (ANCHOR + DATA + MIRROR + PIN +
`contentType="text/markdown"`) and a `TAG(definition=systemTagAnchor,
refUID=README_anchorUID, targetSchema=anchorSchema, weight=1)` from the demo
lens. ~6-8 attestations. Also seed one README on a **file** anchor and confirm an
**address** Overview path, so "any item type" is exercised, not just folders.

## File-change summary

- **New:** `lib/efs/fetchFileContent.ts`, `lib/efs/resolveSystemAnchorSet.ts`,
  `lib/markdown/schema.ts`, `lib/markdown/sniff.ts`,
  `hooks/efs/useItemOverview.ts`, `components/explorer/OverviewPane.tsx`,
  `components/markdown/MarkdownView.tsx`.
- **Edit:** `ExplorerClient.tsx` (middle column + thread `resourcePathNames`),
  `FileActionsBar.tsx` (toggle), `FileBrowser.tsx` (consume extracted util;
  `showSystemFiles` filter), `tailwind.config.js`, `styles/globals.css`,
  `package.json`, plus the hardhat demo-seed step + `docs/decisions.md` note.

## Testing

Repo test runner is **`node --test` over `utils/**/*.test.ts`** (not Jest).

- **Framework-light unit tests** (no react-markdown import, so they run under the
  existing runner): byte-sniff classifier (markdown/text vs PDF/PNG/zip/gzip/NUL),
  filename-precedence + fallback selection, size-cap + node-count/depth boundary,
  filename sanitization for the download card.
- **Sanitization tests** need the ESM remark/rehype graph; verify the test setup
  can import it (add a transform/allow-list or a tiny harness invoking the
  `unified` processor directly). Assert the XSS vector set is neutralized
  (`javascript:`/`data:` links, raw script/`onerror`/`iframe`/`svg onload`,
  protocol-relative `//host`, relative `/path` rendered inert) and that richness
  survives (footnotes, heading anchors with `id="user-content-…"`, tables,
  task lists). Include a DOM-clobber case (`## constructor` → prefixed id).
- `yarn next:check-types` clean.
- **Manual matrix** (after the new seed): a **folder**, a **file**, and an
  **address** each with a `system`-tagged `README.md` render in the Overview
  pane; the hidden-files toggle reveals/hides system files; a non-markdown
  `system` file shows the safe download card; an item with no page stays 2-pane.
