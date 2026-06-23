"use client";

import { useAutoFaucetDrip } from "~~/hooks/scaffold-eth";

/**
 * Mounts the HTTP-faucet auto-drip. Renders nothing; no-op unless
 * `NEXT_PUBLIC_FAUCET_URL` is set and the wallet is on the faucet's chain
 * (`NEXT_PUBLIC_FAUCET_CHAIN_ID`). Sibling to `DevnetAutoFund`, which covers the
 * local hardhat fork via the unlocked node account.
 */
export const FaucetAutoDrip = () => {
  useAutoFaucetDrip();
  return null;
};
