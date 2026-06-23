"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { isFaucetEnabled, requestDrip, useFaucetStatus } from "~~/utils/scaffold-eth";

// At most one auto-drip per (chain × address) across the session, tracked in a
// module-level Set so it survives component remounts.
const dripped = new Set<string>();

/**
 * Fire a best-effort drip when a wallet connects on the faucet's chain
 * (`NEXT_PUBLIC_FAUCET_CHAIN_ID`) and a faucet URL is configured. No-op otherwise
 * — on the local hardhat fork `DevnetAutoFund` handles funding instead. On a real
 * drip it sets the shared faucet status so the header shows a persistent
 * "Adding gas…" indicator until the ETH lands; failures update the shared faucet
 * status so the demo-wallet chip can tell users to retry or connect their own
 * wallet.
 */
export function useAutoFaucetDrip() {
  const { address, chainId } = useAccount();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!address || !isFaucetEnabled(chainId)) return;
    const key = `${chainId}:${address.toLowerCase()}`;
    if (dripped.has(key) || inFlight.current) return;

    dripped.add(key);
    inFlight.current = true;
    (async () => {
      const res = await requestDrip(address);
      const faucetStatus = useFaucetStatus.getState();
      if (res.ok && res.txHash) {
        faucetStatus.setPending(res.txHash);
      } else if (!res.ok) {
        faucetStatus.setError(res.message ?? "Faucet unreachable. Use Get test ETH or connect your own wallet.");
      }
      inFlight.current = false;
    })();
  }, [address, chainId]);
}
