"use client";

/**
 * FaucetButton — sends 1 ETH from hardhat's default funded account to the
 * connected wallet. On hardhat only; returns null on any other chain.
 *
 * Rendered as a `<li>` inside `AddressInfoDropdown`'s menu (not a standalone
 * header button). Rationale: funding is wallet-related, so it belongs with
 * the other wallet actions (Copy address / QR / Block Explorer / Disconnect).
 * The header is less cluttered, and the Balance readout next to the wallet
 * chip already signals "0.0 ETH" loudly enough that users know where to look.
 *
 * Exported name preserved so the scaffold-eth barrel export stays stable.
 */
import { useState } from "react";
import { createWalletClient, http, parseEther } from "viem";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { BanknotesIcon } from "@heroicons/react/24/outline";
import { useTransactor } from "~~/hooks/scaffold-eth";

const NUM_OF_ETH = "1";
const FAUCET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// `scaffold.config.ts` patches an instance of the hardhat chain with the
// env-var URL, but we're importing the vanilla `hardhat` from `viem/chains`
// here — so `http()` with no argument would fall back to viem's default
// `http://127.0.0.1:8545`, which is wrong whenever a parallel worktree or the
// Claude Code Preview auto-port scan shifted hardhat to a different port.
// Read the env var directly so we always target the same node the rest of
// the app is using. See also `DevnetAutoFund.tsx` which has the same fix.
const HARDHAT_RPC_URL = process.env.NEXT_PUBLIC_HARDHAT_RPC_URL || "http://127.0.0.1:8545";
const localWalletClient = createWalletClient({
  chain: hardhat,
  transport: http(HARDHAT_RPC_URL),
});

export const FaucetButton = ({ hidden = false }: { hidden?: boolean } = {}) => {
  const { address, chain: ConnectedChain } = useAccount();
  const [loading, setLoading] = useState(false);
  const faucetTxn = useTransactor(localWalletClient);

  // Only meaningful on the local hardhat fork — on any other chain the button
  // disappears entirely (no placeholder, no greyed-out state).
  if (ConnectedChain?.id !== hardhat.id) {
    return null;
  }

  const sendETH = async () => {
    if (!address) return;
    try {
      setLoading(true);
      await faucetTxn({
        account: FAUCET_ADDRESS,
        to: address,
        value: parseEther(NUM_OF_ETH),
      });
    } catch (error) {
      console.error("⚡️ ~ file: FaucetButton.tsx:sendETH ~ error", error);
    } finally {
      setLoading(false);
    }
  };

  // Styling mirrors the other `<li>` rows in AddressInfoDropdown so the menu
  // reads as one coherent list. `btn-sm !rounded-xl` + the same icon/text
  // gap are lifted from those sibling rows.
  return (
    <li className={hidden ? "hidden" : ""}>
      <button
        className="menu-item btn-sm !rounded-xl flex gap-3 py-3"
        type="button"
        onClick={sendETH}
        disabled={loading}
      >
        {loading ? (
          <span className="loading loading-spinner loading-xs h-6 w-4 ml-2 sm:ml-0" />
        ) : (
          <BanknotesIcon className="h-6 w-4 ml-2 sm:ml-0" />
        )}
        <span className="whitespace-nowrap">Fund wallet (1 ETH)</span>
      </button>
    </li>
  );
};
