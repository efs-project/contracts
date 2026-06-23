"use client";

/**
 * GasFaucetButton — manual "Get test ETH", backed by the HTTP faucet service.
 * Renders null unless `NEXT_PUBLIC_FAUCET_URL` is set and the wallet is on the
 * faucet's chain (`NEXT_PUBLIC_FAUCET_CHAIN_ID` — live Sepolia by default).
 * Sibling to `FaucetButton` (hardhat-only, which funds the
 * burner from the unlocked node account). Rendered as an `<li>` in
 * `AddressInfoDropdown`, matching the other wallet-menu rows.
 */
import { useState } from "react";
import { useAccount } from "wagmi";
import { BanknotesIcon } from "@heroicons/react/24/outline";
import { isFaucetEnabled, notification, requestDrip, useFaucetStatus } from "~~/utils/scaffold-eth";

export const GasFaucetButton = ({ hidden = false }: { hidden?: boolean } = {}) => {
  const { address, chainId } = useAccount();
  const [loading, setLoading] = useState(false);

  // Only on the faucet's chain with a configured faucet; otherwise the button is gone.
  if (!isFaucetEnabled(chainId)) return null;

  const getETH = async () => {
    if (!address) return;
    setLoading(true);
    const res = await requestDrip(address);
    // On a real drip, hand off to the header's "Adding gas…" indicator (persists
    // until the ETH lands); only surface a toast for non-drip outcomes.
    if (res.ok && res.txHash) {
      useFaucetStatus.getState().setPending(res.txHash);
    } else if (!res.ok) {
      const message = res.message ?? "Faucet request failed. Try again shortly.";
      useFaucetStatus.getState().setError(message);
      notification.error(message);
    }
    setLoading(false);
  };

  return (
    <li className={hidden ? "hidden" : ""}>
      <button
        className="menu-item btn-sm !rounded-xl flex gap-3 py-3"
        type="button"
        onClick={getETH}
        disabled={loading}
      >
        {loading ? (
          <span className="loading loading-spinner loading-xs h-6 w-4 ml-2 sm:ml-0" />
        ) : (
          <BanknotesIcon className="h-6 w-4 ml-2 sm:ml-0" />
        )}
        <span className="whitespace-nowrap">Get test ETH</span>
      </button>
    </li>
  );
};
