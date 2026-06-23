"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { isFaucetEnabled, requestDrip, useFaucetStatus } from "~~/utils/scaffold-eth/faucet";
import { consumeInstantBurnerDripRequest, shouldAutoDripInstantBurner } from "~~/utils/scaffold-eth/instantBurner";

// At most one auto-drip per (chain × address) across the session, tracked in a
// module-level Set so it survives component remounts.
const dripped = new Set<string>();

/**
 * Fire one best-effort drip after the visitor explicitly clicks "Use demo
 * wallet" on the faucet's chain. No-op for page-load reconnects and real-wallet
 * connects — the manual "Get test ETH" menu item remains available there. On a
 * real drip it sets the shared faucet status so the header shows a persistent
 * "Adding gas…" indicator until the ETH lands; failures update the shared faucet
 * status so the demo-wallet chip can tell users to retry or connect their own wallet.
 */
export function useAutoFaucetDrip() {
  const { address, chainId, connector } = useAccount();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!address) return;
    const dripRequested = consumeInstantBurnerDripRequest();
    if (
      !shouldAutoDripInstantBurner({
        faucetEnabled: isFaucetEnabled(chainId),
        activeConnectorId: connector?.id,
        dripRequested,
      })
    ) {
      return;
    }
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
  }, [address, chainId, connector?.id]);
}
