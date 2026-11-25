# ADR-0071: The file explorer routes in the URL fragment (`/#<chain>/<path>`)

**Status:** Accepted
**Date:** 2026-11-24
**Related:** ADR-0040 (superseded in part — the explorer no longer uses a dynamic route), ADR-0031 (lenses stay a URL option), ADR-0070 (the PDF preview whose links prompted this)

## Context

The explorer lived at the static-exported dynamic route `/explorer/[[...path]]`. With no server, deep links relied on each host rewriting `/explorer/*` to the one exported shell (`public/_redirects`, ADR-0040). That broke in practice:

- IPFS gateways (eth.limo, Kubo/boxo) label a `_redirects` 200 rewrite with a Content-Type guessed from the **request** path's extension, plus `nosniff`. `/explorer/whitepapers/bitcoin.pdf` arrived as `application/pdf`: the app never ran, and Android Chrome downloaded the HTML as a "PDF". `.png`, `.md` and `.txt` links failed the same way.
- A 302-and-restore workaround worked on IPFS gateways but leaned on gateway internals (splat decoding, Go re-escaping, Cloudflare's rule order) and broke Next's `router.push` in a static export.
- Hosts without `_redirects` (GitHub Pages, S3, `python -m http.server`) 404ed every deep link.

EFS is meant to run from any static host, including someone's laptop, and its file links are meant to be posted publicly.

## Decision

The explorer's location lives in the URL fragment, on the site root page:

```
/#<chain>/<path…>?<options>      /#/whitepapers/bitcoin.pdf
                                 /#sep/whitepapers/bitcoin.pdf?lenses=alice.eth
```

- **Fragment, not path.** The host never sees the fragment, so every host serves the same HTML for every explorer link and the app reads the route itself (`utils/efs/hashRoute.ts`). No `_redirects` rule, rewrite or 404 fallback is involved. Plain `/` (no route) stays the landing page.
- **Chain prefix (ERC-3770 style).** `<chain>` is the fragment's text between the `#` and the first `/` after it (the page's own path, wherever the app is hosted, plays no part): a short name from the ethereum-lists chain registry (`sep`, `eth`) or a chain id (`11155111`). Chains without a registered short name (EFS devnet 26001993; local Hardhat 31337, which the registry assigns to GoChain Testnet as `got`) are named by number. An empty chain (`#/…`) means the viewer's current chain, so a top-level folder named like a chain (`#/sep/…`) stays a folder. A chain the app isn't set up for, or a token that isn't a chain, shows an "Unsupported chain" notice — never another chain's content (`utils/efs/routeChain.ts`).
- **Per view.** A link's chain applies to that view only: it is never saved as the viewer's preference, and leaving the view puts the viewer's previous chain back. With no wallet connected the app reads that chain; the app's own burner wallet (Easy Edits) is moved to it and back; a viewer's real wallet on another chain gets a notice with a switch button, never an automatic switch. Choosing a network in the header overrides the link and drops its chain prefix (with a wallet, once the wallet has switched).
- **Path and options.** Path segments are the URL-encoded names (`encodeURIComponent(<canonical on-chain name>)`), decoded once when read — the encoding the explorer already used. Options (`lenses`, `sort`, `tags`) follow the first `?` inside the fragment.
- **Navigation.** The explorer pushes and replaces fragment entries itself; links into it from other pages are plain anchors, because `next/link` changes only the fragment with `pushState`, which fires no `hashchange`. Fragment navigation keeps the explorer mounted, so per-folder UI (sidebar overlay, info band, filter drawer, scroll, create dialogs) is reset on folder change, and markdown same-page links scroll instead of setting the fragment. `/explorer/…` is removed with no redirect (no links were in the wild).

## Consequences

- File links work on every static host that serves the root `index.html`, including eth.limo, subdomain IPFS gateways, GitHub Pages, S3 and `python -m http.server`; verified in emulated Android Chrome on Kubo, a 404.html-style host and `python -m http.server`.
- Link unfurlers and crawlers see the root page for every explorer link (they ignore fragments), as before; there were no per-file previews to lose.
- The root page now carries the explorer's JavaScript. An inline head script marks explorer routes before first paint so the landing page's static HTML never flashes.
- ADR-0040's `usePathname` rule still governs the remaining static-exported dynamic routes (`/blockexplorer/**`, `/lists/[listUID]`), which keep their `_redirects` rules; it no longer applies to the explorer.
- **v1 limit: the bundle must be served from the root of a domain** (eth.limo, a subdomain IPFS gateway, efs.com, `localhost:8000`). A subfolder (`<user>.github.io/<repo>/`) or an IPFS **path** gateway (`/ipfs/<cid>/…`) doesn't load: the export's asset paths are absolute, and making them relative would break the other pages. Accepted for v1; client-v2 builds with relative URLs (`base: './'`) and runs under any path prefix. Details in `docs/FUTURE_WORK.md`.
- client-v2 routes shareable links as `#/r/<realm>/<link>`. The explorer deliberately uses the shorter `#<chain>/<path>`; if both ever share an origin, the two grammars need reconciling.

## Alternatives considered

- **Keep path URLs with a `_redirects` 302 into a fragment, restored by script.** Worked on Kubo/eth.limo, but depended on gateway escaping details, broke `router.push`, and needed a separate 404 bounce for other hosts.
- **`?file=` query links.** Avoided the extension guess for files but kept host-dependent rewrites for folders, and made file links less readable.
- **client-v2's `#/r/<realm>/<path>`.** Consistent with client-v2, but longer and not the ERC-3770 short names the owner preferred.
