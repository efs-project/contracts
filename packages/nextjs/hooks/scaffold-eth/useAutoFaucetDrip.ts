"use client";

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { notification } from "~~/utils/scaffold-eth";
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
 * promptless edits" on the faucet's chain. No-op for page-load reconnects and real-wallet
 * connects — the manual "Get test ETH" menu item remains available there. On a
 * real drip it sets the shared faucet status so the header shows a persistent
 * "Adding gas…" indicator until the ETH lands; failures update the shared faucet
 * status and a toast can tell users to retry or connect their own wallet.
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
      const message = "Public local-dev address. Enable promptless edits again to create a private wallet.";
      useFaucetStatus.getState().setError(message);
      notification.warning(message, { position: "bottom-center" });
      return;
    }

    inFlight.current = true;
    (async () => {
      try {
        const res = await requestDrip(address);
        const faucetStatus = useFaucetStatus.getState();
        if (res.ok && res.txHash) {
          dripped.add(key);
          faucetStatus.setPending(res.txHash);
        } else if (!res.ok) {
          const message = res.message ?? "Faucet unreachable. Try Get test ETH or use your wallet.";
          faucetStatus.setError(message);
          notification.error(message, { position: "bottom-center" });
        }
      } finally {
        inFlight.current = false;
      }
    })();
  }, [address, chainId, connector?.id]);
}
