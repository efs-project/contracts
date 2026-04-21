"use client";

import { useParams, usePathname } from "next/navigation";
import TransactionComp from "../_components/TransactionComp";
import { Hash } from "viem";

const ZERO_HASH = "0x" + "0".repeat(64);
const isZeroHash = (h: string | undefined): boolean => !!h && h.toLowerCase() === ZERO_HASH;

/**
 * Client-side shell for `/blockexplorer/transaction/<txHash>`.
 *
 * Same story as {@link AddressPageClient}: static export bakes a single
 * dummy shell for the zero hash and IPFS gateways (plus Caddy on the
 * devnet VPS) rewrite every deep link to it. `useParams()` alone is
 * insufficient — it returns the pre-rendered dummy in static export —
 * so we derive the hash from `usePathname()` (URL-backed) and only fall
 * back to `params` for dev-mode edge cases.
 */
export function TransactionPageClient() {
  const params = useParams();
  const pathname = usePathname();

  const fromParams = (() => {
    const raw = params?.txHash;
    return Array.isArray(raw) ? raw[0] : raw;
  })();
  const fromPathname = (() => {
    if (!pathname) return undefined;
    const match = pathname.match(/^\/blockexplorer\/transaction\/([^/]+)/);
    return match ? decodeURIComponent(match[1]) : undefined;
  })();
  const txHash = fromPathname && !isZeroHash(fromPathname) ? fromPathname : fromParams;

  if (!txHash || isZeroHash(txHash)) {
    return <div className="m-10">Loading transaction…</div>;
  }

  return <TransactionComp txHash={txHash as Hash} />;
}
