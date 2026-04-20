import { Suspense } from "react";
import ExplorerClient from "./ExplorerClient";

/**
 * `output: "export"` in `next.config.js` requires every dynamic route — including
 * optional catch-alls like `[[...path]]` — to pre-enumerate the paths it will
 * emit at build time via `generateStaticParams`. We can't know the user's
 * anchor / address / schema URLs ahead of time, so we emit a single shell at
 * `/explorer/` (the empty-path case) and rely on the hosting layer
 * (`public/_redirects` → `/explorer/* /explorer/index.html 200`, honored by
 * IPFS gateways incl. eth.limo / eth.link and by most proxies) to serve that
 * shell for any deeper URL. The shell reads `useParams()` at runtime and
 * renders the real path — see `./ExplorerClient.tsx`.
 *
 * This wrapper is a Server Component (no `"use client"`) purely so Next.js
 * lets us export `generateStaticParams` — that directive is disallowed inside
 * `"use client"` files. The wrapper renders zero logic of its own.
 *
 * The `<Suspense>` boundary is required because `ExplorerClient` reads
 * `useSearchParams()`. Under static export, any component that touches search
 * params must be wrapped in Suspense so Next.js can prerender a static shell
 * and hydrate the search-param-dependent subtree on the client. Without the
 * boundary the whole page falls into CSR-bailout and fails `next build`. See
 * https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout.
 */
export function generateStaticParams() {
  return [{ path: [] }];
}

export default function ExplorerPage() {
  return (
    <Suspense fallback={null}>
      <ExplorerClient />
    </Suspense>
  );
}
