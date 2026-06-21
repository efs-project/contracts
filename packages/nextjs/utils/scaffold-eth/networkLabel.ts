import { Chain } from "viem";

/**
 * Human-facing name for the three EFS environments. The hardhat chain (31337) is reused for BOTH the
 * developer's local fork and the shared devnet VPS fork — they differ only by RPC URL, so the label is
 * inferred from the RPC, not the chain id:
 *   - hardhat (31337) + localhost/127.0.0.1 RPC → "Local"   (a dev's `yarn preview` fork)
 *   - hardhat (31337) + any other RPC           → "Devnet"  (the community-testing VPS fork)
 *   - any other chain id                        → chain.name (e.g. "Sepolia")
 *
 * Single source of truth for NetworkChip, NetworkSwitcher, and the explorer's unreachable-network state,
 * so all three environments are named consistently across the UI.
 *
 * (When the devnet eventually runs contracts ahead of frozen Sepolia, give it its own chain id so it is a
 * distinct wagmi chain with its own deployedContracts block — see docs/FUTURE_WORK.md. Until then they
 * share 31337 and this RPC split is the only distinction.)
 */
export type NetworkFlavor = "local" | "devnet" | "other" | "unknown";

export const HARDHAT_CHAIN_ID = 31337;

const FLAVOR_LABELS: Record<NetworkFlavor, string> = {
  local: "Local",
  devnet: "Devnet",
  other: "", // derived from chain.name
  unknown: "?",
};

export function inferNetworkFlavor(rpcUrl: string | undefined, chainId: number | undefined): NetworkFlavor {
  if (!rpcUrl || !chainId) return "unknown";
  if (chainId === HARDHAT_CHAIN_ID) {
    if (rpcUrl.startsWith("http://127.0.0.1") || rpcUrl.startsWith("http://localhost")) return "local";
    return "devnet";
  }
  return "other";
}

/** Local | Devnet | <chain.name> (e.g. Sepolia) for a chain, by the rule above. */
export function networkLabel(chain: Chain | undefined): string {
  if (!chain) return "Unknown";
  const rpcUrl = chain.rpcUrls?.default?.http?.[0];
  const flavor = inferNetworkFlavor(rpcUrl, chain.id);
  return flavor === "other" ? (chain.name ?? "Unknown") : FLAVOR_LABELS[flavor];
}
