# ADR-0040: Read dynamic route params from `usePathname`, not `useParams`, in static-exported dynamic routes

**Status:** Accepted
**Date:** 2026-04-21
**Related:** PR (this change), ADR-0033 (root containers — where the bug surfaced)

## Context

The Next.js devtools UI (`packages/nextjs`) ships as a **pure static export**
(`output: "export"`) — one HTML tree in `out/`, no server, no ISR. All the
dynamic routes we care about are single-shell catch-alls:

- `/explorer/[[...path]]` — every address / schema / attestation / anchor URL
- `/blockexplorer/address/[address]` — every address
- `/blockexplorer/transaction/[txHash]` — every tx hash

For each, `generateStaticParams` returns exactly one entry (empty path, or a
dummy zero-address). `next build` writes one `index.html` per route. Real
deep-link routing happens at the reverse-proxy layer: IPFS gateways honor
`public/_redirects`, and the devnet Caddy mirrors those rules. Both use a
**transparent rewrite** (`status = 200`) — the browser URL bar still shows
the user's deep path, but the HTML served is the empty-path shell.

Inside the shell, every client component previously read its dynamic params
via `useParams()` from `next/navigation`. On Next dev this works: the hook
is URL-reactive, so `params.path` tracks whatever is in the address bar.

**In production static export it does not.** The shell was pre-rendered with
`params.path = undefined` (or the dummy zero-address). When the client
hydrates, `useParams()` returns the **pre-rendered** params — the URL is
ignored — and every deep link silently degrades to the shell's default.
Observed: `https://<devnet>/explorer/0x90F7…` renders the root anchor
listing with the wrong `ClaudeCodeBuddy.png` / `SatoshiNakamoto.jpg` files
instead of the address container the user asked for.

This is not a Next.js bug per se — it's the documented behavior of
`useParams` in a pre-rendered page. The bug was in our assumption that
`useParams` was URL-reactive in every mode.

The reproducer is trivial once you see it: `yarn workspace @se-2/nextjs
build`, serve `out/` with a minimal SPA-fallback server (rewrite
`/explorer/*` → `/explorer/index.html`, preserve URL), load
`/explorer/<address>`, observe the shell's empty-path content. A `curl -I`
confirms Caddy does the same: identical ETag for the slash and no-slash
variants.

## Decision

In every client component that participates in a dynamic static-exported
route, derive the dynamic segment(s) from `usePathname()` (URL-backed,
always reflects `window.location` after hydration). Keep `useParams()` as
a **secondary** fallback for dev-mode edge cases where router state leads
the pathname by one tick during `router.push`.

Concretely:

```tsx
const params = useParams();
const pathname = usePathname();

const fromPathname = pathname?.match(/^\/blockexplorer\/address\/([^/]+)/)?.[1];
const fromParams = Array.isArray(params?.address) ? params.address[0] : params?.address;
// Prefer pathname — it is URL-backed. Fall back to params only when pathname
// is absent or points at the pre-rendered dummy.
const address = fromPathname && !isZeroAddress(fromPathname) ? fromPathname : fromParams;
```

For the catch-all (`/explorer/[[...path]]`), the pathname-derived version
peels off the `/explorer/` prefix and splits the remainder:

```tsx
const fromPathname = (() => {
  if (!pathname) return [];
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (trimmed === "explorer") return [];
  if (!trimmed.startsWith("explorer/")) return [];
  return trimmed.slice("explorer/".length).split("/").map(decodeURIComponent).filter(Boolean);
})();
```

Use `pathname` (the string) as the `useEffect` dependency, not the derived
array — arrays change identity every render and thrash the effect.

## Consequences

- **Fixes:** every deep link on `app.efs.eth.limo`, the devnet VPS, and any
  IPFS-gateway-hosted copy of `out/`. Prior to this, `/explorer/<address>`,
  `/explorer/<schemaUID>`, `/explorer/<attestationUID>`, and all
  blockexplorer deep links silently rendered the pre-rendered default.
- **Dev mode unchanged.** `usePathname` is URL-reactive in dev too, so
  `yarn start` behavior is identical.
- **Cost:** a few extra lines of pathname-parsing per route shell. The parse
  is pure string work, no regex backtracking, no runtime cost in hot paths.
- **Caveat for future dynamic routes.** Any new static-exported dynamic
  route (e.g. `/schemas/[uid]`, `/attestations/[uid]` if we add them) must
  adopt the same `usePathname`-first pattern. Adding a route with only
  `useParams` is the trap that bit us here.

## Alternatives considered

- **Just use `usePathname` alone, drop `useParams`.** Cleaner, but
  `useParams` occasionally has lower latency than `pathname` during a
  `router.push` transition. Keeping it as a fallback costs nothing and
  smooths over that one-frame window.
- **Disable static export on the dynamic routes.** Would require a Node
  server on `app.efs.eth.limo`, which eth.limo doesn't run. Non-starter
  given the IPFS-first hosting target.
- **Redirect (302) deep URLs to the shell and read from a query param.**
  Breaks the URL — every shared link would bounce through a redirect —
  and defeats the whole point of deep-linkable, cacheable static HTML.
- **Use `window.location.pathname` directly.** Works, but skips the
  React-y hook path and would need a manual mount-re-render dance to avoid
  hydration mismatch warnings. `usePathname` does exactly this for us.
