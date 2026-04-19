"use client";

import { useParams } from "next/navigation";
import TransactionComp from "../_components/TransactionComp";
import { Hash } from "viem";
import { isZeroAddress } from "~~/utils/scaffold-eth/common";

/**
 * Client-side shell for `/blockexplorer/transaction/<txHash>`.
 *
 * Same story as {@link AddressPageClient}: static export bakes a single
 * dummy shell for the zero hash and IPFS gateways rewrite every deep link
 * to it, so we read `txHash` at runtime via `useParams()` rather than from
 * the server-side `params` prop (which is always the zero hash).
 */
export function TransactionPageClient() {
  const params = useParams();
  const rawTxHash = params?.txHash;
  const txHash = Array.isArray(rawTxHash) ? rawTxHash[0] : rawTxHash;

  if (!txHash || isZeroAddress(txHash)) {
    return <div className="m-10">Loading transaction…</div>;
  }

  return <TransactionComp txHash={txHash as Hash} />;
}
