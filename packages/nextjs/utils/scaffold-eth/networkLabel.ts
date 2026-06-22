import { Chain } from "viem";

/**
 * Human-facing name for the EFS environments, keyed off the CHAIN ID (ADR-0062). Each environment
 * is now its own chain, so the label is unambiguous — no RPC sniffing, no probing:
 *   - 31337   → "Local"   (a developer's `yarn fork`)
 *   - 5318008 → "Devnet"  (the shared community fork on the VPS)
 *   - anything else → chain.name (e.g. "Sepolia")
 *
 * Single source of truth for NetworkChip, NetworkSwitcher, and the explorer's unreachable-network
 * state, so all environments are named consistently across the UI.
 */
export type NetworkFlavor = "local" | "devnet" | "other" | "unknown";

export const HARDHAT_CHAIN_ID = 31337;
export const DEVNET_CHAIN_ID = 5318008;

const FLAVOR_LABELS: Record<NetworkFlavor, string> = {
  local: "Local",
  devnet: "Devnet",
  other: "", // derived from chain.name
  unknown: "?",
};

export function inferNetworkFlavor(chainId: number | undefined): NetworkFlavor {
  if (!chainId) return "unknown";
  if (chainId === HARDHAT_CHAIN_ID) return "local";
  if (chainId === DEVNET_CHAIN_ID) return "devnet";
  return "other";
}

/** Local | Devnet | <chain.name> (e.g. Sepolia) for a chain, by chain id. */
export function networkLabel(chain: Chain | undefined): string {
  if (!chain) return "Unknown";
  const flavor = inferNetworkFlavor(chain.id);
  return flavor === "other" ? (chain.name ?? "Unknown") : FLAVOR_LABELS[flavor];
}

/**
 * Display order for the network switcher: live chains (Sepolia) first, then Devnet, then Local.
 * Sepolia leads because it's the durable, always-reachable environment; Local trails because it's
 * the most ephemeral and only present on a dev's machine. This is a SORT for the dropdown only — it
 * must not be confused with the default-selected network (scaffold.config's `targetNetworks[0]`).
 */
const FLAVOR_SORT_RANK: Record<NetworkFlavor, number> = {
  other: 0, // live chains (Sepolia, mainnet later)
  devnet: 1,
  local: 2,
  unknown: 3,
};

export function networkSortRank(chain: Chain | undefined): number {
  return FLAVOR_SORT_RANK[inferNetworkFlavor(chain?.id)];
}
