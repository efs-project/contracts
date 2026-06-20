"use client";

/**
 * NetworkSwitcher — header dropdown that flips the debug UI between the configured
 * target networks (the hardhat Sepolia-fork and live Sepolia) at runtime.
 *
 * Why this exists: Scaffold-ETH only surfaces network switching inside the
 * "wrong network" dropdown, which (a) requires a connected wallet and (b) is
 * framed as an error. For a debug UI we want to read live Sepolia data without
 * connecting anything, and to deliberately point reads at one chain or the other.
 *
 * Two sources of truth, reconciled:
 *   - No wallet connected → the Zustand `targetNetwork` IS the source of truth.
 *     Selecting a network sets it directly; reads (useScaffoldReadContract et al.)
 *     follow immediately. The choice is persisted so it survives reloads.
 *   - Wallet connected → the wallet's chain is the source of truth (useTargetNetwork
 *     mirrors it into the store, and a store/​wallet mismatch shows WrongNetwork).
 *     Selecting a network therefore asks the WALLET to switch via wagmi's
 *     switchChain; the store then syncs from the wallet. Setting the store alone
 *     would be snapped back by useTargetNetwork's effect, so we don't.
 */
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { useAccount, useSwitchChain } from "wagmi";
import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { getNetworkColor, useTargetNetwork } from "~~/hooks/scaffold-eth";
import { useGlobalState } from "~~/services/store/store";
import { getTargetNetworks } from "~~/utils/scaffold-eth";

const allowedNetworks = getTargetNetworks();

// Persist the no-wallet selection so a manual switch survives a reload. Only
// consulted when no wallet is connected (a connected wallet's chain wins).
const STORAGE_KEY = "efs.targetNetworkId";

export const NetworkSwitcher = () => {
  const { targetNetwork } = useTargetNetwork();
  const setTargetNetwork = useGlobalState(state => state.setTargetNetwork);
  const { isConnected, status } = useAccount();
  const { switchChain } = useSwitchChain();
  const { resolvedTheme } = useTheme();
  const isDarkMode = resolvedTheme === "dark";
  const [mounted, setMounted] = useState(false);

  const restoredRef = useRef(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Restore the persisted no-wallet selection once the wallet status has SETTLED
  // (not while connecting/reconnecting — reading isConnected mid-rehydration is racy).
  // Only applies when no wallet is connected; a connected wallet's chain is authoritative
  // (useTargetNetwork mirrors it), so we leave restore to that path.
  useEffect(() => {
    if (restoredRef.current) return;
    if (status === "connecting" || status === "reconnecting") return;
    restoredRef.current = true;
    if (isConnected || typeof window === "undefined") return;
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    const restored = allowedNetworks.find(n => n.id === stored);
    if (restored && restored.id !== targetNetwork.id) {
      setTargetNetwork(restored);
    }
  }, [status, isConnected, targetNetwork.id, setTargetNetwork]);

  // Only one configured network → nothing to switch to; render nothing.
  if (!mounted || allowedNetworks.length < 2) {
    return null;
  }

  const selectNetwork = (chainId: number) => {
    if (isConnected) {
      // Ask the wallet to switch; useTargetNetwork's effect syncs the store after.
      // Don't persist here: a connected wallet's chain is authoritative on reload
      // (the restore effect is skipped while connected), so persisting a not-yet-
      // confirmed switch would only leave a stale default if the user rejects it.
      switchChain?.({ chainId });
    } else {
      const next = allowedNetworks.find(n => n.id === chainId);
      if (next) {
        setTargetNetwork(next);
        // Persist only the no-wallet selection — it's the sole value the restore
        // effect ever reads back.
        if (typeof window !== "undefined") {
          window.localStorage.setItem(STORAGE_KEY, String(chainId));
        }
      }
    }
  };

  return (
    <div className="dropdown dropdown-end">
      <label
        tabIndex={0}
        className="btn btn-ghost btn-sm shadow-md rounded-full px-3 gap-1.5 normal-case"
        title="Switch the network the debug UI reads from"
      >
        <GlobeAltIcon className="h-4 w-4" style={{ color: getNetworkColor(targetNetwork, isDarkMode) }} />
        <span className="hidden sm:inline">{targetNetwork.name}</span>
      </label>
      <ul
        tabIndex={0}
        className="dropdown-content menu p-2 mt-2 shadow-center shadow-accent bg-base-200 rounded-box w-52 z-[100]"
      >
        <li className="menu-title px-3 py-1 text-xs">Network</li>
        {allowedNetworks.map(network => {
          const isActive = network.id === targetNetwork.id;
          return (
            <li key={network.id}>
              <button
                type="button"
                className={`flex items-center justify-between gap-2 rounded-lg text-sm ${
                  isActive ? "bg-secondary" : "hover:bg-base-300"
                }`}
                onClick={() => selectNetwork(network.id)}
              >
                <span style={{ color: getNetworkColor(network, isDarkMode) }}>{network.name}</span>
                <span className="text-xs opacity-50 font-mono">{network.id}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
