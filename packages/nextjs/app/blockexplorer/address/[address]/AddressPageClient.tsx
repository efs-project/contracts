"use client";

import { useParams } from "next/navigation";
import { AddressComponent } from "~~/app/blockexplorer/_components/AddressComponent";
import { isZeroAddress } from "~~/utils/scaffold-eth/common";

/**
 * Client-side shell for `/blockexplorer/address/<addr>`.
 *
 * Why this exists: in static export mode (`output: "export"`) Next.js bakes
 * exactly one HTML shell per dynamic route — here, `generateStaticParams`
 * returns a single dummy entry for the zero address. IPFS gateways then
 * rewrite any `/blockexplorer/address/*` URL to that single shell (see
 * `public/_redirects`). If the shell is a server component that reads
 * `params.address` at build time, every deep-link renders as the zero
 * address and `isZeroAddress` short-circuits to a blank page.
 *
 * The fix is to read the address from the URL at runtime via `useParams()`,
 * so the single shell can serve every address. Contract bytecode/assembly
 * (which required `fs`-reading hardhat build-info on the server) is dropped
 * here — that codepath was already degraded to `null` on the devnet / static
 * deployments, so nothing user-visible regresses.
 */
export function AddressPageClient() {
  const params = useParams();
  const rawAddress = params?.address;
  const address = Array.isArray(rawAddress) ? rawAddress[0] : rawAddress;

  if (!address || isZeroAddress(address)) {
    return <div className="m-10">Loading address…</div>;
  }

  return <AddressComponent address={address} contractData={null} />;
}
