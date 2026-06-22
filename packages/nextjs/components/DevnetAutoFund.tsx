"use client";

/**
 * DevnetAutoFund — when a wallet connects to the hardhat fork with a zero
 * balance, silently send it 1 ETH so the user can immediately start
 * attesting. No UI; this component returns null and does its work in an
 * effect.
 *
 * Why this exists: on the devnet, most users will have no Sepolia ETH, and
 * every on-chain action requires gas. The "click the faucet button" step is
 * friction most visitors won't discover — so we do it for them the one time
 * it matters: on their first connection.
 *
 * Scope / guards:
 *   - fork chains only: the local fork (31337) and the devnet (5318008), via
 *     `isFundableForkChainId`. On mainnet / Sepolia / anywhere else, a no-op.
 *   - Only when `balance.value === 0n`. A wallet that already has funds is
 *     left alone.
 *   - Once per (address × browser-session). Tracked in a `Set` ref so the
 *     funding fires at most once even if the balance effect re-renders.
 *   - Single-flight via `inFlight` ref so overlapping balance updates can't
 *     issue two concurrent sends.
 *
 * Why this bypasses `useTransactor` and uses viem directly:
 *   `useTransactor` awaits the receipt via `getPublicClient(wagmiConfig)`,
 *   which resolves to whatever chain wagmi currently thinks the user is on.
 *   If the user swaps wallets (e.g. burner → MetaMask on mainnet) *after* the
 *   send but *before* the receipt arrives, the receipt poll would switch to
 *   mainnet and hang forever searching for a hardhat tx hash.
 *   Here we pin both send and receipt to a dedicated local client so the
 *   whole flow is chain-independent, and we skip the toast lifecycle so
 *   there's no stuck-toast failure mode.
 *
 * The fork-chain guard (`isFundableForkChainId`, an explicit allowlist of 31337/5318008) is
 * load-bearing. This component must never, ever fire on mainnet — auto-sending 1 ETH to any
 * connecting address would be ruinous.
 */
import { useEffect, useRef } from "react";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { useAccount } from "wagmi";
import { useWatchBalance } from "~~/hooks/scaffold-eth/useWatchBalance";
import { isFundableForkChainId } from "~~/utils/scaffold-eth";

const FAUCET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NUM_OF_ETH = "1";

export const DevnetAutoFund = () => {
  const { address, chain } = useAccount();
  const { data: balance } = useWatchBalance({ address });

  // Mutable bookkeeping kept in refs so re-renders don't reset the state.
  const fundedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!address) return;
    if (!chain || !isFundableForkChainId(chain.id)) return;
    // `balance` is undefined until the first query resolves; wait for a real
    // reading before deciding "zero" (otherwise we'd fire on the loading
    // state, which returns no data but also not yet a zero value).
    if (!balance) return;
    if (balance.value !== 0n) return;
    if (inFlightRef.current) return;
    if (fundedRef.current.has(address)) return;

    fundedRef.current.add(address);
    inFlightRef.current = true;

    // Pin a client to THIS fork's chain + RPC for the whole send→receipt flow, captured now (not a
    // module singleton) so it targets the correct fork — local (31337) or devnet (5318008) — and a
    // mid-flight wallet swap can't redirect the receipt poll to another chain (see component doc).
    const rpcUrl = chain.rpcUrls.default.http[0];
    const forkWalletClient = createWalletClient({ chain, transport: http(rpcUrl) });
    const forkPublicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    (async () => {
      try {
        const hash = await forkWalletClient.sendTransaction({
          account: FAUCET_ADDRESS,
          to: address,
          value: parseEther(NUM_OF_ETH),
        });
        // Wait against the SAME pinned client, not wagmi's config-wide public
        // client — avoids a chain-swap race (see component doc).
        await forkPublicClient.waitForTransactionReceipt({ hash });
      } catch (err) {
        // Roll back the funded-set entry so a retry path exists on the next
        // balance update or reconnect.
        fundedRef.current.delete(address);
        console.error("[DevnetAutoFund] auto-funding failed:", err);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [address, balance, chain]);

  return null;
};
