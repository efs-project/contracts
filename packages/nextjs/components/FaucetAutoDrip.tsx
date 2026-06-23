"use client";

import { useAutoFaucetDrip } from "~~/hooks/scaffold-eth";

/**
 * Mounts the explicit editing-wallet faucet drip. Renders nothing; no-op unless
 * the visitor clicked "Enable editing", `NEXT_PUBLIC_FAUCET_URL` is set, and the
 * burner wallet is on the faucet's chain (`NEXT_PUBLIC_FAUCET_CHAIN_ID`).
 * Sibling to `DevnetAutoFund`, which covers the fork chains through the unlocked
 * node account.
 */
export const FaucetAutoDrip = () => {
  useAutoFaucetDrip();
  return null;
};
