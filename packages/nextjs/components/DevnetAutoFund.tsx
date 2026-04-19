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
 *   - hardhat chain id only (31337). On mainnet / Sepolia / anywhere else,
 *     the component is a no-op.
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
 * The `hardhat.id` guard is hardcoded. This component must never, ever fire
 * on mainnet — auto-sending 1 ETH to any connecting address would be ruinous.
 */
import { useEffect, useRef } from "react";
import { createPublicClient, createWalletClient, http, parseEther } from "viem";
import { hardhat } from "viem/chains";
import { useAccount } from "wagmi";
import { useWatchBalance } from "~~/hooks/scaffold-eth/useWatchBalance";

const FAUCET_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const NUM_OF_ETH = "1";

// `scaffold.config.ts` builds a *patched* hardhat chain with the env-var URL,
// but we're importing the vanilla `hardhat` from `viem/chains` here (so the
// type stays simple). `http()` with no URL would therefore fall back to the
// viem default `http://127.0.0.1:8545`, which is wrong whenever another
// worktree or the Claude Code Preview auto-port scan shifted hardhat to a
// different port. Read the env var directly so we always target the same
// node the rest of the app is using.
const HARDHAT_RPC_URL = process.env.NEXT_PUBLIC_HARDHAT_RPC_URL || "http://127.0.0.1:8545";
const localWalletClient = createWalletClient({
  chain: hardhat,
  transport: http(HARDHAT_RPC_URL),
});
const localPublicClient = createPublicClient({
  chain: hardhat,
  transport: http(HARDHAT_RPC_URL),
});

export const DevnetAutoFund = () => {
  const { address, chain } = useAccount();
  const { data: balance } = useWatchBalance({ address });

  // Mutable bookkeeping kept in refs so re-renders don't reset the state.
  const fundedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!address) return;
    if (chain?.id !== hardhat.id) return;
    // `balance` is undefined until the first query resolves; wait for a real
    // reading before deciding "zero" (otherwise we'd fire on the loading
    // state, which returns no data but also not yet a zero value).
    if (!balance) return;
    if (balance.value !== 0n) return;
    if (inFlightRef.current) return;
    if (fundedRef.current.has(address)) return;

    fundedRef.current.add(address);
    inFlightRef.current = true;

    (async () => {
      try {
        const hash = await localWalletClient.sendTransaction({
          account: FAUCET_ADDRESS,
          to: address,
          value: parseEther(NUM_OF_ETH),
        });
        // Wait against the SAME local client, not wagmi's config-wide public
        // client — avoids a chain-swap race (see component doc).
        await localPublicClient.waitForTransactionReceipt({ hash });
      } catch (err) {
        // Roll back the funded-set entry so a retry path exists on the next
        // balance update or reconnect.
        fundedRef.current.delete(address);
        console.error("[DevnetAutoFund] auto-funding failed:", err);
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [address, balance, chain?.id]);

  return null;
};
