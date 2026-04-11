/**
 * useSortDiscovery — Discover available sort concepts for a parent anchor.
 *
 * Resolution model:
 *   1. Local sorts: naming anchors with anchorSchema == SORT_INFO_SCHEMA_UID
 *      that are direct children of parentAnchor
 *   2. Global sorts: naming anchors under /sorts/ (indexer.sortsAnchorUID)
 *      with the same schema
 *   3. Merge: local names override global names (same-name match)
 *   4. For each naming anchor, resolve the best SORT_INFO attestation via
 *      the editions address list (first match wins)
 *
 * Returns: { availableSorts, isLoading, refetch }
 */
import { useCallback, useEffect, useState } from "react";
import { zeroAddress, zeroHash } from "viem";
import { usePublicClient } from "wagmi";
import { SortOverlayInfo, getSortOverlayAddress } from "~~/utils/efs/sortOverlay";

// ── Minimal ABI fragments needed for discovery ────────────────────────────────

const INDEXER_SORT_ABI = [
  {
    inputs: [],
    name: "SORT_INFO_SCHEMA_UID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "sortsAnchorUID",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "anchorUID", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
      { internalType: "bool", name: "reverseOrder", type: "bool" },
      { internalType: "bool", name: "showRevoked", type: "bool" },
    ],
    name: "getAnchorsBySchema",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "targetUID", type: "bytes32" },
      { internalType: "bytes32", name: "schemaUID", type: "bytes32" },
      { internalType: "address", name: "attester", type: "address" },
      { internalType: "uint256", name: "start", type: "uint256" },
      { internalType: "uint256", name: "length", type: "uint256" },
      { internalType: "bool", name: "reverseOrder", type: "bool" },
    ],
    name: "getReferencingBySchemaAndAttester",
    outputs: [{ internalType: "bytes32[]", name: "", type: "bytes32[]" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "isRevoked",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const EAS_GET_ATTESTATION_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "uid", type: "bytes32" }],
    name: "getAttestation",
    outputs: [
      {
        components: [
          { internalType: "bytes32", name: "uid", type: "bytes32" },
          { internalType: "bytes32", name: "schema", type: "bytes32" },
          { internalType: "uint64", name: "time", type: "uint64" },
          { internalType: "uint64", name: "expirationTime", type: "uint64" },
          { internalType: "uint64", name: "revocationTime", type: "uint64" },
          { internalType: "bytes32", name: "refUID", type: "bytes32" },
          { internalType: "address", name: "recipient", type: "address" },
          { internalType: "address", name: "attester", type: "address" },
          { internalType: "bool", name: "revocable", type: "bool" },
          { internalType: "bytes", name: "data", type: "bytes" },
        ],
        internalType: "struct Attestation",
        name: "",
        type: "tuple",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SORT_CONFIG_ABI = [
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
] as const;

// ── Hook ──────────────────────────────────────────────────────────────────────

interface UseSortDiscoveryOptions {
  parentAnchor: string | undefined;
  indexerAddress: `0x${string}` | undefined;
  easAddress: `0x${string}` | undefined;
  /** Editions addresses for SORT_INFO resolution (ordered, first match wins) */
  editionAddresses: string[];
  /** Only return sorts where targetSchema matches (bytes32(0) matches everything) */
  filterBySchema?: string;
}

interface UseSortDiscoveryResult {
  availableSorts: SortOverlayInfo[];
  isLoading: boolean;
  refetch: () => void;
}

export function useSortDiscovery({
  parentAnchor,
  indexerAddress,
  easAddress,
  editionAddresses,
  filterBySchema,
}: UseSortDiscoveryOptions): UseSortDiscoveryResult {
  const publicClient = usePublicClient();
  const [availableSorts, setAvailableSorts] = useState<SortOverlayInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey(k => k + 1), []);

  // Serialize to a stable string so array reference churn doesn't retrigger discovery
  const editionsKey = editionAddresses.join(",");

  useEffect(() => {
    if (!parentAnchor || !indexerAddress || !easAddress || !publicClient) return;
    if (parentAnchor === zeroHash) return;

    let cancelled = false;

    async function discover() {
      if (!publicClient || !indexerAddress || !easAddress) return;

      setIsLoading(true);
      try {
        const chainId = publicClient.chain.id;
        const sortOverlayAddress = await getSortOverlayAddress(chainId);
        if (!sortOverlayAddress) return;

        // 1. Fetch SORT_INFO_SCHEMA_UID and sortsAnchorUID from indexer
        const [sortInfoSchemaUID, sortsAnchorUID] = await Promise.all([
          publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_SORT_ABI,
            functionName: "SORT_INFO_SCHEMA_UID",
          }),
          publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_SORT_ABI,
            functionName: "sortsAnchorUID",
          }),
        ]);

        if (cancelled) return;

        // Detect the system deployer from the /sorts/ anchor attestation so global system sorts
        // (ByName, ByDate) are always discoverable even when the connected wallet is not the deployer.
        // The deployer is the attester of the sortsAnchorUID attestation.
        let systemDeployer: `0x${string}` | null = null;
        if (sortsAnchorUID && sortsAnchorUID !== zeroHash && easAddress) {
          try {
            const sortsAtt = await publicClient.readContract({
              address: easAddress,
              abi: EAS_GET_ATTESTATION_ABI,
              functionName: "getAttestation",
              args: [sortsAnchorUID as `0x${string}`],
            });
            if (sortsAtt.attester && sortsAtt.attester !== zeroAddress) {
              systemDeployer = sortsAtt.attester as `0x${string}`;
            }
          } catch {
            // Non-critical — global sorts just won't auto-include system defaults
          }
        }

        // Resolution chain for global sorts: user editions first, deployer as final fallback.
        const globalResolutionChain: string[] = [
          ...editionAddresses,
          ...(systemDeployer && !editionAddresses.map(a => a.toLowerCase()).includes(systemDeployer.toLowerCase())
            ? [systemDeployer]
            : []),
        ];

        // 2. Fetch local naming anchors (children of parentAnchor with anchorSchema = SORT_INFO_SCHEMA_UID)
        const localNamingAnchors = (await publicClient.readContract({
          address: indexerAddress,
          abi: INDEXER_SORT_ABI,
          functionName: "getAnchorsBySchema",
          args: [parentAnchor as `0x${string}`, sortInfoSchemaUID, 0n, 100n, false, false],
        })) as readonly `0x${string}`[];

        // 3. Fetch global naming anchors from /sorts/
        let globalNamingAnchors: readonly `0x${string}`[] = [];
        if (sortsAnchorUID !== zeroHash) {
          globalNamingAnchors = (await publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_SORT_ABI,
            functionName: "getAnchorsBySchema",
            args: [sortsAnchorUID as `0x${string}`, sortInfoSchemaUID, 0n, 100n, false, false],
          })) as readonly `0x${string}`[];
        }

        if (cancelled) return;

        // 4. Resolve anchor names for all naming anchors
        const allNamingAnchors = [...localNamingAnchors, ...globalNamingAnchors];
        const names = await Promise.all(
          allNamingAnchors.map(async uid => {
            try {
              const att = await publicClient.readContract({
                address: easAddress!,
                abi: EAS_GET_ATTESTATION_ABI,
                functionName: "getAttestation",
                args: [uid],
              });
              if (!att.data || att.data === "0x") return "";
              // Decode anchor data: (string name, bytes32 anchorSchema)
              const { decodeAbiParameters, parseAbiParameters } = await import("viem");
              const [name] = decodeAbiParameters(parseAbiParameters("string, bytes32"), att.data as `0x${string}`);
              return name as string;
            } catch {
              return "";
            }
          }),
        );

        if (cancelled) return;

        // 5. Build name → naming anchor maps (local and global kept separate).
        //    Do NOT pre-strip globals that also exist locally — the local name may
        //    fail to resolve to a usable SORT_INFO for the current editions chain,
        //    in which case we fall back to the global entry rather than lose the name.
        const localMap = new Map<string, `0x${string}`>();
        for (let i = 0; i < localNamingAnchors.length; i++) {
          const name = names[i];
          if (name) localMap.set(name, localNamingAnchors[i]);
        }
        const globalMap = new Map<string, `0x${string}`>();
        for (let i = 0; i < globalNamingAnchors.length; i++) {
          const name = names[localNamingAnchors.length + i];
          if (name && !globalMap.has(name)) globalMap.set(name, globalNamingAnchors[i]);
        }

        // Resolve a single naming anchor's best SORT_INFO by walking an editions chain.
        // Returns null if no non-revoked SORT_INFO is found.
        async function resolveSortInfo(
          namingUID: `0x${string}`,
          chain: string[],
        ): Promise<`0x${string}` | null> {
          for (const attester of chain) {
            try {
              const uids = (await publicClient!.readContract({
                address: indexerAddress!,
                abi: INDEXER_SORT_ABI,
                functionName: "getReferencingBySchemaAndAttester",
                args: [namingUID, sortInfoSchemaUID, attester as `0x${string}`, 0n, 1n, false],
              })) as readonly `0x${string}`[];
              if (!uids || uids.length === 0) continue;
              const uid = uids[0];
              if (uid === zeroHash) continue;
              const revoked = await publicClient!.readContract({
                address: indexerAddress!,
                abi: INDEXER_SORT_ABI,
                functionName: "isRevoked",
                args: [uid],
              });
              if (!revoked) return uid;
            } catch {
              // Attester has no SORT_INFO for this naming anchor — keep walking
            }
          }
          return null;
        }

        // 6. For each unique sort name, prefer a resolvable local SORT_INFO; if the
        //    local naming anchor has no resolvable attester match, fall back to the
        //    global naming anchor (if any) so users don't lose valid global sorts.
        const uniqueNames = new Set<string>([...localMap.keys(), ...globalMap.keys()]);
        const resolvedSorts: SortOverlayInfo[] = (
          await Promise.all(
            Array.from(uniqueNames).map(async name => {
              const localUID = localMap.get(name);
              const globalUID = globalMap.get(name);

              let namingUID: `0x${string}` | null = null;
              let sortInfoUID: `0x${string}` | null = null;
              let isLocal = false;

              if (localUID) {
                const resolved = await resolveSortInfo(localUID, editionAddresses);
                if (resolved) {
                  namingUID = localUID;
                  sortInfoUID = resolved;
                  isLocal = true;
                }
              }
              if (!sortInfoUID && globalUID) {
                const resolved = await resolveSortInfo(globalUID, globalResolutionChain);
                if (resolved) {
                  namingUID = globalUID;
                  sortInfoUID = resolved;
                  isLocal = false;
                }
              }

              if (!sortInfoUID || !namingUID) return null;

              // Fetch sort config
              try {
                const config = await publicClient!.readContract({
                  address: sortOverlayAddress,
                  abi: SORT_CONFIG_ABI,
                  functionName: "getSortConfig",
                  args: [sortInfoUID],
                });

                // Filter by targetSchema if requested (bytes32(0) means "all schemas")
                if (filterBySchema && filterBySchema !== zeroHash) {
                  if (config.targetSchema !== zeroHash && config.targetSchema !== filterBySchema) return null;
                }

                const sort: SortOverlayInfo = {
                  namingAnchorUID: namingUID as string,
                  name,
                  sortInfoUID: sortInfoUID as string,
                  config: {
                    sortFunc: config.sortFunc as `0x${string}`,
                    targetSchema: config.targetSchema as `0x${string}`,
                    sourceType: config.sourceType,
                  },
                  isLocal,
                };
                return sort;
              } catch {
                // Sort config unavailable — skip
                return null;
              }
            }),
          )
        ).filter((s): s is SortOverlayInfo => s !== null);

        if (!cancelled) {
          setAvailableSorts(resolvedSorts);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    discover();
    return () => {
      cancelled = true;
    };
  // editionsKey: serialize array so array reference changes don't retrigger the effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentAnchor, indexerAddress, easAddress, publicClient, editionsKey, filterBySchema, refreshKey]);

  return { availableSorts, isLoading, refetch };
}
