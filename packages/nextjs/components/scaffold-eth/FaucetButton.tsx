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
import { useMemo, useState } from "react";
import { createWalletClient, http, parseEther } from "viem";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { BanknotesIcon } from "@heroicons/react/24/outline";
import { useTransactor } from "~~/hooks/scaffold-eth";
import { isFundableForkChainId } from "~~/utils/scaffold-eth";

const NUM_OF_ETH = "1";
const FAUCET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Funding works on BOTH fork chains (ADR-0062): the local fork (31337) and the devnet (5318008),
// which have different RPC URLs. Build the wallet client from the CONNECTED wagmi chain (already
// patched with the right RPC in scaffold.config.ts) so it targets the correct node per chain. The
// env var is only the vanilla-hardhat fallback. See also `DevnetAutoFund.tsx`.
const HARDHAT_RPC_URL = process.env.NEXT_PUBLIC_HARDHAT_RPC_URL || "http://127.0.0.1:8545";

export const FaucetButton = ({ hidden = false }: { hidden?: boolean } = {}) => {
  const { address, chain: ConnectedChain } = useAccount();
  const [loading, setLoading] = useState(false);

  const fundable = isFundableForkChainId(ConnectedChain?.id);
  // Pin a wallet client to the connected fork's chain + RPC. Built unconditionally (hooks can't be
  // conditional); only used when `fundable`, and defaults to the hardhat chain otherwise.
  const walletClient = useMemo(
    () =>
      createWalletClient({
        chain: ConnectedChain && fundable ? ConnectedChain : hardhat,
        transport: http(ConnectedChain?.rpcUrls?.default?.http?.[0] ?? HARDHAT_RPC_URL),
      }),
    [ConnectedChain, fundable],
  );
  const faucetTxn = useTransactor(walletClient);

  // Only meaningful on a fork chain (local 31337 / devnet 5318008) — on any other chain the button
  // disappears entirely (no placeholder, no greyed-out state).
  if (!fundable) {
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
