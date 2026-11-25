/**
 * hashRoute — the explorer's location lives in the URL fragment:
 *
 *   #<chain>/<path…>?<options>      e.g.  #/whitepapers/bitcoin.pdf
 *                                         #sep/whitepapers/bitcoin.pdf?lenses=alice.eth
 *
 * The fragment never reaches the host, so every static host (IPFS gateways,
 * GitHub Pages, a laptop's `python -m http.server`) serves the same HTML page
 * for every explorer link, with no `_redirects`, rewrite or 404 tricks; the
 * app reads the route itself. A path-based link (`/explorer/docs/bitcoin.pdf`)
 * can't do that: gateways label the response by the URL's extension, so the
 * page arrives as a PDF.
 *
 * Grammar: `<chain>` is the fragment's text between the `#` and the first `/`
 * (empty = the viewer's chain); the page's own path never enters into it, so a top-level folder named like a chain (`#/sep/…`) stays a folder.
 * Path segments are URL-encoded names, decoded once when read — the same
 * encoding the explorer used in path URLs. Options follow the first `?`
 * (`?` inside a name is always encoded).
 */

export type HashRoute = {
  /** The fragment's chain token, between `#` and the first `/`; "" means the viewer's chain. */
  chain: string;
  /** Path segments, decoded once (anchor names / container ids). */
  segments: string[];
  /** The same segments as written in the URL, for rebuilding a link unchanged. */
  rawSegments: string[];
  /** Options after `?`: `lenses`, `sort`, `tags`. */
  params: URLSearchParams;
};

/**
 * True when `hash` is an explorer route (a `/` after the optional chain).
 * Self-contained: its source is inlined as MARK_HASH_ROUTE_SCRIPT.
 */
export function isHashRoute(hash: string): boolean {
  return /^#[^/?#]*\//.test(hash);
}

/**
 * Inline `<head>` script: marks `<html data-efs-route>` before first paint when
 * the fragment is an explorer route, so the root page's static landing HTML is
 * hidden (styles/globals.css) until the explorer renders instead of flashing.
 */
export const MARK_HASH_ROUTE_SCRIPT = `try{if((${isHashRoute.toString()})(location.hash))document.documentElement.setAttribute("data-efs-route","")}catch(e){}`;

/** The route in `hash` (`location.hash`), or `null` when it isn't one. */
export function parseHashRoute(hash: string): HashRoute | null {
  if (!isHashRoute(hash)) return null;
  const body = hash.slice(1);
  const slash = body.indexOf("/");
  const q = body.indexOf("?", slash);
  const path = q === -1 ? body.slice(slash + 1) : body.slice(slash + 1, q);
  const decodeOnce = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const rawSegments = path.split("/").filter(Boolean);
  return {
    chain: body.slice(0, slash),
    segments: rawSegments.map(decodeOnce),
    rawSegments,
    params: new URLSearchParams(q === -1 ? "" : body.slice(q + 1)),
  };
}

/**
 * The fragment for a route. `segments` are already URL-encoded (`PathItem.urlSegment`
 * or `encodeURIComponent(name)`), so they're joined as given.
 */
export function formatHashRoute(route: {
  chain?: string;
  segments: readonly string[];
  params?: URLSearchParams | string;
}): string {
  const query = route.params === undefined ? "" : route.params.toString();
  return `#${route.chain ?? ""}/${route.segments.join("/")}${query ? `?${query}` : ""}`;
}

/** Fired after `replaceHashRoute`, which (unlike a hash assignment) fires no `hashchange`. */
export const HASH_ROUTE_EVENT = "efs:hashroute";

/** Opens `hash` as a new history entry (fires `hashchange`). */
export function pushHashRoute(hash: string): void {
  if (window.location.hash !== hash) window.location.hash = hash;
}

/** Replaces the current history entry with `hash` (gallery stepping, canonicalization). */
export function replaceHashRoute(hash: string): void {
  if (window.location.hash === hash) return;
  window.history.replaceState(window.history.state, "", hash);
  window.dispatchEvent(new Event(HASH_ROUTE_EVENT));
}
