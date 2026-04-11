/**
 * EFSSortOverlay utilities: address resolution, types, and ABI fragments.
 *
 * EFSSortOverlay, NameSort, and TimestampSort addresses are resolved at runtime
 * from deployedContracts so they work across local fork, Sepolia, and mainnet.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SortConfig {
  sortFunc: `0x${string}`;
  targetSchema: `0x${string}`;
  sourceType: number;
}

export interface SortOverlayInfo {
  /** UID of the naming anchor (the sort concept schelling point) */
  namingAnchorUID: string;
  /** Human-readable sort name from the naming anchor */
  name: string;
  /** UID of the SORT_INFO attestation (the per-attester implementation) */
  sortInfoUID: string;
  /** Resolved sort config */
  config: SortConfig;
  /** Whether the sort is local (child of this anchor) or global (/sorts/) */
  isLocal: boolean;
}

export interface SortStalenessInfo {
  sortInfoUID: string;
  parentAnchor: string;
  /** Items processed into the sorted list */
  processed: bigint;
  /** Total items in the kernel for this (sortInfoUID, parentAnchor) */
  total: bigint;
  /** processed / total as a fraction 0–1, or null if total == 0 */
  fraction: number | null;
}

// ── Address resolution ────────────────────────────────────────────────────────

export async function getSortOverlayAddress(chainId: number): Promise<`0x${string}` | undefined> {
  try {
    const deployedContracts = await import("~~/contracts/deployedContracts");
    const chainContracts = (deployedContracts.default as any)[chainId];
    return chainContracts?.EFSSortOverlay?.address as `0x${string}` | undefined;
  } catch {
    return undefined;
  }
}

export async function getNameSortAddress(chainId: number): Promise<`0x${string}` | undefined> {
  try {
    const deployedContracts = await import("~~/contracts/deployedContracts");
    const chainContracts = (deployedContracts.default as any)[chainId];
    return chainContracts?.NameSort?.address as `0x${string}` | undefined;
  } catch {
    return undefined;
  }
}

export async function getTimestampSortAddress(chainId: number): Promise<`0x${string}` | undefined> {
  try {
    const deployedContracts = await import("~~/contracts/deployedContracts");
    const chainContracts = (deployedContracts.default as any)[chainId];
    return chainContracts?.TimestampSort?.address as `0x${string}` | undefined;
  } catch {
    return undefined;
  }
}

// ── DEFAULT_MAX_TRAVERSAL ─────────────────────────────────────────────────────

/**
 * Default traversal limit for getSortedChunkByAddressList.
 * Calibrated for typical RPC eth_call gas limits (~50M gas on mainnet).
 * L2s may tolerate higher values. Benchmark on testnet before increasing.
 */
export const DEFAULT_MAX_TRAVERSAL = 10_000n;

// ── ABI fragments ─────────────────────────────────────────────────────────────

export const SORT_OVERLAY_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
      { internalType: "bytes32", name: "startNode", type: "bytes32" },
      { internalType: "uint256", name: "limit", type: "uint256" },
      { internalType: "bool", name: "showRevoked", type: "bool" },
    ],
    name: "getSortedChunk",
    outputs: [
      { internalType: "bytes32[]", name: "items", type: "bytes32[]" },
      { internalType: "bytes32", name: "nextCursor", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
      { internalType: "bytes32", name: "startNode", type: "bytes32" },
      { internalType: "uint256", name: "limit", type: "uint256" },
      { internalType: "uint256", name: "maxTraversal", type: "uint256" },
      { internalType: "address[]", name: "attesters", type: "address[]" },
      { internalType: "bool", name: "showRevoked", type: "bool" },
    ],
    name: "getSortedChunkByAddressList",
    outputs: [
      { internalType: "bytes32[]", name: "items", type: "bytes32[]" },
      { internalType: "bytes32", name: "nextCursor", type: "bytes32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
    ],
    name: "getSortStaleness",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
    ],
    name: "getSortLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
    ],
    name: "getLastProcessedIndex",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "sortInfoUID", type: "bytes32" }],
    name: "getSortConfig",
    outputs: [
      {
        components: [
          { internalType: "address", name: "sortFunc", type: "address" },
          { internalType: "bytes32", name: "targetSchema", type: "bytes32" },
          { internalType: "uint8", name: "sourceType", type: "uint8" },
        ],
        internalType: "struct EFSSortOverlay.SortConfig",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "sortInfoUID", type: "bytes32" }],
    name: "isSortRegistered",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
      { internalType: "bytes32[]", name: "newItems", type: "bytes32[]" },
    ],
    name: "computeHints",
    outputs: [
      { internalType: "bytes32[]", name: "leftHints", type: "bytes32[]" },
      { internalType: "bytes32[]", name: "rightHints", type: "bytes32[]" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
      { internalType: "bytes32", name: "parentAnchor", type: "bytes32" },
      { internalType: "uint256", name: "expectedStartIndex", type: "uint256" },
      { internalType: "bytes32[]", name: "items", type: "bytes32[]" },
      { internalType: "bytes32[]", name: "leftHints", type: "bytes32[]" },
      { internalType: "bytes32[]", name: "rightHints", type: "bytes32[]" },
    ],
    name: "processItems",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  // Custom errors — included so viem can decode revert data into named errors
  // during writeContract/simulateContract calls. Required for reliable retry
  // logic that branches on specific error names (e.g., StaleStartIndex).
  { inputs: [], name: "LimitTooLarge", type: "error" },
  { inputs: [], name: "InvalidSortInfo", type: "error" },
  { inputs: [], name: "ArrayLengthMismatch", type: "error" },
  { inputs: [], name: "InvalidPosition", type: "error" },
  { inputs: [], name: "InvalidItem", type: "error" },
  { inputs: [], name: "StaleStartIndex", type: "error" },
  { inputs: [], name: "UnnecessaryReposition", type: "error" },
  { inputs: [], name: "UnsupportedSourceType", type: "error" },
  { inputs: [], name: "Reentrant", type: "error" },
] as const;

// ── Staleness helpers ─────────────────────────────────────────────────────────

/**
 * Compute fraction synced (0–1) given total and processed counts.
 * Returns null if total is 0 (empty list, not meaningfully "synced").
 */
export function computeSyncFraction(processed: bigint, total: bigint): number | null {
  if (total === 0n) return null;
  return Number(processed) / Number(total);
}

/**
 * Format staleness as a human-readable percentage string.
 * e.g. "92%", "100%", "0%", or "—" for empty lists.
 */
export function formatSyncPercent(fraction: number | null): string {
  if (fraction === null) return "—";
  return `${Math.round(fraction * 100)}%`;
}
