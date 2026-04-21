"use client";

import { useParams, usePathname } from "next/navigation";
import { AddressComponent } from "~~/app/blockexplorer/_components/AddressComponent";
import { isZeroAddress } from "~~/utils/scaffold-eth/common";

/**
 * Client-side shell for `/blockexplorer/address/<addr>`.
 *
 * Why this exists: in static export mode (`output: "export"`) Next.js bakes
 * exactly one HTML shell per dynamic route — here, `generateStaticParams`
 * returns a single dummy entry for the zero address. IPFS gateways (and
 * Caddy on the devnet VPS) rewrite any `/blockexplorer/address/*` URL to
 * that single shell (see `public/_redirects`). If the shell is a server
 * component that reads `params.address` at build time, every deep-link
 * renders as the zero address and `isZeroAddress` short-circuits to a
 * blank page.
 *
 * The naive client-side fix is `useParams()` — but that *also* fails in
 * static export: the hook returns the params the shell was pre-rendered
 * with (the zero-address dummy), not the actual URL the user typed. The
 * reliable source is `usePathname()`, which is always URL-derived.
 * `useParams()` is kept as a secondary fallback for dev-mode edge cases
 * where router state leads the pathname briefly. Contract bytecode /
 * assembly (which required `fs`-reading hardhat build-info on the server)
 * is dropped here — that codepath was already degraded to `null` on the
 * devnet / static deployments, so nothing user-visible regresses.
 */
export function AddressPageClient() {
  const params = useParams();
  const pathname = usePathname();

  const fromParams = (() => {
    const raw = params?.address;
    return Array.isArray(raw) ? raw[0] : raw;
  })();
  const fromPathname = (() => {
    if (!pathname) return undefined;
    // /blockexplorer/address/<addr> — with or without trailing slash
    const match = pathname.match(/^\/blockexplorer\/address\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  })();
  // Prefer pathname — it reflects `window.location` reliably in static export.
  const address = fromPathname && !isZeroAddress(fromPathname) ? fromPathname : fromParams;

  if (!address || isZeroAddress(address)) {
    return <div className="m-10">Loading address…</div>;
  }

  return <AddressComponent address={address} contractData={null} />;
}
