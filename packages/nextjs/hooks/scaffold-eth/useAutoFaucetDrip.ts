"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { isFaucetEnabled, requestDrip, useFaucetStatus } from "~~/utils/scaffold-eth/faucet";
import {
  BURNER_WALLET_CONNECTOR_ID,
  consumeInstantBurnerDripRequest,
  shouldAutoDripInstantBurner,
  shouldBlockFaucetDripRecipient,
} from "~~/utils/scaffold-eth/instantBurner";
import { HARDHAT_ACCOUNTS } from "~~/utils/scaffold-eth/hardhatAccounts";

// At most one editing-wallet drip per (chain × address) across the current page,
// tracked in a module-level Set so it survives component remounts but not reloads.
const dripped = new Set<string>();
const hardhatAddresses = HARDHAT_ACCOUNTS.map(account => account.address);

/**
 * Fire one best-effort drip after the visitor explicitly clicks "Enable
 * editing" on the faucet's chain. No-op for page-load reconnects and real-wallet
 * connects — the manual "Get test ETH" menu item remains available there. On a
 * real drip it sets the shared faucet status so the header shows a persistent
 * "Adding gas…" indicator until the ETH lands; failures update the shared faucet
 * status so the editing wallet chip can tell users to retry or connect their own wallet.
 */
export function useAutoFaucetDrip() {
  const { address, chainId, connector } = useAccount();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!address) return;
    const faucetEnabled = isFaucetEnabled(chainId);
    if (!faucetEnabled || connector?.id !== BURNER_WALLET_CONNECTOR_ID) return;

    const dripRequested = consumeInstantBurnerDripRequest();
    if (
      !shouldAutoDripInstantBurner({
        faucetEnabled,
        activeConnectorId: connector?.id,
        dripRequested,
      })
    ) {
      return;
    }
    const key = `${chainId}:${address.toLowerCase()}`;
    if (dripped.has(key) || inFlight.current) return;
    if (shouldBlockFaucetDripRecipient({ recipientAddress: address, hardhatAddresses })) {
      useFaucetStatus.getState().setError("This is a public local-dev address. Enable editing again to create a private wallet.");
      return;
    }

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
