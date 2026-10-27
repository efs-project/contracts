type ChainLike = { id: number };

export const LEGACY_TARGET_NETWORK_STORAGE_KEY = "efs.targetNetworkId";
export const TARGET_NETWORK_STORAGE_KEY = "efs.targetNetworkPreference.v2";

type ReadStoredTargetNetworkIdOptions = {
  ignoredLegacyChainIds?: readonly number[];
};

export function targetNetworkStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  return window.localStorage;
}

function parseStoredChainId(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const chainId = Number(raw);
  return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : undefined;
}

export function readStoredTargetNetworkId(
  storage: Pick<Storage, "getItem"> | undefined,
  { ignoredLegacyChainIds = [] }: ReadStoredTargetNetworkIdOptions = {},
): number | undefined {
  try {
    const current = parseStoredChainId(storage?.getItem(TARGET_NETWORK_STORAGE_KEY));
    if (current !== undefined) return current;

    const legacy = parseStoredChainId(storage?.getItem(LEGACY_TARGET_NETWORK_STORAGE_KEY));
    if (legacy !== undefined && !ignoredLegacyChainIds.includes(legacy)) return legacy;
    return undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredTargetNetworkId(
  storage: (Pick<Storage, "setItem"> & Partial<Pick<Storage, "removeItem">>) | undefined,
  chainId: number,
): void {
  try {
    storage?.setItem(TARGET_NETWORK_STORAGE_KEY, String(chainId));
    storage?.removeItem?.(LEGACY_TARGET_NETWORK_STORAGE_KEY);
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
