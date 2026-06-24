type ChainLike = { id: number };

export const TARGET_NETWORK_STORAGE_KEY = "efs.targetNetworkId";

export function targetNetworkStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

export function readStoredTargetNetworkId(storage: Pick<Storage, "getItem"> | undefined): number | undefined {
  try {
    const raw = storage?.getItem(TARGET_NETWORK_STORAGE_KEY);
    if (!raw) return undefined;
    const chainId = Number(raw);
    return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredTargetNetworkId(
  storage: Pick<Storage, "setItem"> | undefined,
  chainId: number,
): void {
  try {
    storage?.setItem(TARGET_NETWORK_STORAGE_KEY, String(chainId));
  } catch {
    // Storage can be unavailable in private browsing or SSR-like shells.
  }
}

export function selectInitialTargetNetwork<TChain extends ChainLike>(
  chains: readonly TChain[],
  storedChainId: number | undefined,
): TChain {
  if (chains.length === 0) throw new Error("No target networks configured.");
  return chains.find(chain => chain.id === storedChainId) ?? chains[0];
}
