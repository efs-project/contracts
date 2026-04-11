"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CreateSortModal } from "./CreateSortModal";
import { zeroHash } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import {
  ArrowsUpDownIcon,
  BarsArrowDownIcon,
  BarsArrowUpIcon,
  ChevronDownIcon,
  PlusIcon,
} from "@heroicons/react/24/outline";
import { useSortDiscovery } from "~~/hooks/efs/useSortDiscovery";
import { useDeployedContractInfo, useScaffoldReadContract } from "~~/hooks/scaffold-eth";
import { computeHintsLocally } from "~~/utils/efs/sortHints";
import { SORT_OVERLAY_ABI, SortOverlayInfo, formatSyncPercent } from "~~/utils/efs/sortOverlay";
import { notification } from "~~/utils/scaffold-eth";

// ABI for the sourceType-aware kernel accessors used during processItems batching.
// EFSSortOverlay.processItems validates each item against the kernel accessor that
// corresponds to the SortConfig's sourceType — so the batch loader must use the
// same accessor or the call reverts with InvalidItem.
const INDEXER_PROCESS_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "bytes32", name: "parentUID", type: "bytes32" },
      { internalType: "bytes32", name: "schema", type: "bytes32" },
      { internalType: "uint256", name: "index", type: "uint256" },
    ],
    name: "getChildBySchemaAt",
    outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ISortFunc.getSortKey — read-only, used to fetch sort keys for client-side hint computation.
const ISORT_FUNC_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "uid", type: "bytes32" },
      { internalType: "bytes32", name: "sortInfoUID", type: "bytes32" },
    ],
    name: "getSortKey",
    outputs: [{ internalType: "bytes", name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BATCH_SIZE = 100;

// Lists larger than this switch to client-side hint computation. The on-chain
// computeHints() simulates binary search over the linked list and allocates O(N)
// memory for the walk — beyond ~500 items on typical RPCs the eth_call will
// exceed the gas limit and reject. Below this threshold the on-chain path is
// simpler (no sort key multicall) and strictly cheaper in round-trips.
const LOCAL_HINT_THRESHOLD = 500;
// Matches EFSSortOverlay.MAX_PAGE_SIZE.
const SORTED_CHUNK_PAGE = 100;

interface SortDropdownProps {
  parentAnchor: string | undefined;
  indexerAddress: `0x${string}` | undefined;
  easAddress: `0x${string}` | undefined;
  sortOverlayAddress: `0x${string}` | undefined;
  editionAddresses: string[];
  activeSortInfoUID: string | null;
  onSortChange: (sortInfoUID: string | null) => void;
  onProcessComplete?: () => void;
  filterBySchema?: string;
  reverseOrder?: boolean;
  onReverseOrderChange?: (reverse: boolean) => void;
  /** Increment to trigger auto-processing (e.g. after file upload) */
  autoProcessKey?: number;
  /** UIDs to auto-process when autoProcessKey fires. Defaults to active sort only. */
  autoProcessSortUIDs?: string[];
  anchorSchemaUID?: string;
}

export const SortDropdown = ({
  parentAnchor,
  indexerAddress,
  easAddress,
  sortOverlayAddress,
  editionAddresses,
  activeSortInfoUID,
  onSortChange,
  onProcessComplete,
  filterBySchema,
  reverseOrder = false,
  onReverseOrderChange,
  autoProcessKey = 0,
  autoProcessSortUIDs,
  anchorSchemaUID,
}: SortDropdownProps) => {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [isOpen, setIsOpen] = useState(false);
  const [isCreateSortOpen, setIsCreateSortOpen] = useState(false);
  // Lazily-fetched staleness: sortInfoUID → fraction (0–1) or null
  const [stalenessMap, setStalenessMap] = useState<Map<string, number | null>>(new Map());
  const [isFetchingStaleness, setIsFetchingStaleness] = useState(false);
  // Which sort is currently being processed (null = none)
  const [processingUID, setProcessingUID] = useState<string | null>(null);

  const {
    availableSorts,
    isLoading,
    refetch: refetchSorts,
  } = useSortDiscovery({
    parentAnchor,
    indexerAddress,
    easAddress,
    editionAddresses,
    filterBySchema,
  });

  // Sort function contracts for CreateSortModal
  const { data: nameSortInfo } = useDeployedContractInfo({ contractName: "NameSort" });
  const { data: timestampSortInfo } = useDeployedContractInfo({ contractName: "TimestampSort" });
  const { data: sortInfoSchemaUID } = useScaffoldReadContract({
    contractName: "EFSSortOverlay",
    functionName: "SORT_INFO_SCHEMA_UID",
  });
  const { data: sortsAnchorUID } = useScaffoldReadContract({
    contractName: "Indexer",
    functionName: "sortsAnchorUID",
  });

  const sortFunctions = [
    ...(nameSortInfo ? [{ name: "NameSort (alphabetical)", address: nameSortInfo.address }] : []),
    ...(timestampSortInfo ? [{ name: "TimestampSort (by date)", address: timestampSortInfo.address }] : []),
  ];

  // Fetch staleness for all available sorts when dropdown opens
  const fetchStaleness = useCallback(async () => {
    if (!sortOverlayAddress || !publicClient || availableSorts.length === 0 || !parentAnchor) return;
    setIsFetchingStaleness(true);
    const newMap = new Map<string, number | null>();
    await Promise.all(
      availableSorts.map(async (sort: SortOverlayInfo) => {
        try {
          const [length, staleness] = await Promise.all([
            publicClient.readContract({
              address: sortOverlayAddress,
              abi: SORT_OVERLAY_ABI,
              functionName: "getSortLength",
              args: [sort.sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
            }),
            publicClient.readContract({
              address: sortOverlayAddress,
              abi: SORT_OVERLAY_ABI,
              functionName: "getSortStaleness",
              args: [sort.sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
            }),
          ]);
          const total = (length as bigint) + (staleness as bigint);
          const fraction = total === 0n ? null : Number(length as bigint) / Number(total);
          newMap.set(sort.sortInfoUID, fraction);
        } catch {
          newMap.set(sort.sortInfoUID, null);
        }
      }),
    );
    setStalenessMap(newMap);
    setIsFetchingStaleness(false);
  }, [sortOverlayAddress, publicClient, availableSorts, parentAnchor]);

  useEffect(() => {
    if (isOpen) fetchStaleness();
  }, [isOpen, fetchStaleness]);

  // Cache SortConfig lookups — each config is immutable once attested.
  const sortConfigCacheRef = useRef<Map<string, { sortFunc: string; targetSchema: string; sourceType: number }>>(
    new Map(),
  );

  const getSortConfig = useCallback(
    async (sortInfoUID: string) => {
      const cached = sortConfigCacheRef.current.get(sortInfoUID);
      if (cached) return cached;
      if (!sortOverlayAddress || !publicClient) throw new Error("SortOverlay not available");
      const cfg = (await publicClient.readContract({
        address: sortOverlayAddress,
        abi: SORT_OVERLAY_ABI,
        functionName: "getSortConfig",
        args: [sortInfoUID as `0x${string}`],
      })) as { sortFunc: string; targetSchema: string; sourceType: number };
      sortConfigCacheRef.current.set(sortInfoUID, cfg);
      return cfg;
    },
    [sortOverlayAddress, publicClient],
  );

  // Kernel total = lastProcessed + staleness. Universal across sourceTypes (0/1/2),
  // so callers don't need a sourceType-specific count query.
  const getKernelTotal = useCallback(
    async (sortInfoUID: string): Promise<{ lastProcessed: bigint; totalCount: bigint }> => {
      if (!sortOverlayAddress || !parentAnchor || !publicClient) throw new Error("Missing addresses");
      const [lastProcessed, staleness] = (await Promise.all([
        publicClient.readContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "getLastProcessedIndex",
          args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
        }),
        publicClient.readContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "getSortStaleness",
          args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
        }),
      ])) as [bigint, bigint];
      return { lastProcessed, totalCount: lastProcessed + staleness };
    },
    [sortOverlayAddress, parentAnchor, publicClient],
  );

  // ── Shared helper: fetch and submit a single processItems batch ─────────────
  // Returns the number of items in the batch, or 0 if already fully processed.
  // Throws StaleStartIndex (let callers handle retry) and other errors.
  const _processBatch = useCallback(
    async (sortInfoUID: string, expectedStartIndex: bigint, totalCount: bigint): Promise<number> => {
      if (!sortOverlayAddress || !indexerAddress || !parentAnchor || !publicClient || !walletClient?.account)
        throw new Error("Missing addresses or wallet.");

      const remaining = totalCount - expectedStartIndex;
      if (remaining <= 0n) return 0;

      const batchCount = remaining < BigInt(BATCH_SIZE) ? Number(remaining) : BATCH_SIZE;

      // Route kernel reads by sourceType. processItems on the contract validates each item
      // against the same accessor, so mismatches revert InvalidItem.
      //   0 → getChildAt(parentAnchor, idx)
      //   1 → getChildBySchemaAt(parentAnchor, targetSchema, idx)
      //   2+ → unsupported in this client yet (contract also reverts)
      const config = await getSortConfig(sortInfoUID);
      const items: `0x${string}`[] = [];
      for (let i = 0; i < batchCount; i++) {
        const idx = expectedStartIndex + BigInt(i);
        let uid: `0x${string}`;
        if (config.sourceType === 0) {
          uid = (await publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_PROCESS_ABI,
            functionName: "getChildAt",
            args: [parentAnchor as `0x${string}`, idx],
          })) as `0x${string}`;
        } else if (config.sourceType === 1) {
          uid = (await publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_PROCESS_ABI,
            functionName: "getChildBySchemaAt",
            args: [parentAnchor as `0x${string}`, config.targetSchema as `0x${string}`, idx],
          })) as `0x${string}`;
        } else {
          throw new Error(`Unsupported sort sourceType ${config.sourceType}`);
        }
        items.push(uid);
      }

      // Compute insertion hints. For small lists (< LOCAL_HINT_THRESHOLD) the on-chain
      // computeHints() view call is simpler and strictly cheaper in round-trips. For
      // larger lists the on-chain binary search allocates O(N) memory per eth_call and
      // will exceed the RPC gas cap (~50M on mainnet, much lower on some L2s / public
      // providers) — so we fetch the sorted linked list + sort keys via multicall and
      // run the same binary search in JS.
      const currentLength = (await publicClient.readContract({
        address: sortOverlayAddress,
        abi: SORT_OVERLAY_ABI,
        functionName: "getSortLength",
        args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
      })) as bigint;

      let leftHints: `0x${string}`[];
      let rightHints: `0x${string}`[];

      if (currentLength > BigInt(LOCAL_HINT_THRESHOLD)) {
        // 1. Walk the full linked list (showRevoked=true so we see every node — the
        //    membership structure is what hints reference, not the visibility filter).
        const sortedUIDs: `0x${string}`[] = [];
        let cursor: `0x${string}` = zeroHash as `0x${string}`;
        // Safety bound: cap pagination at 2x the reported length to avoid an infinite
        // loop if the list grows mid-iteration (another caller inserts while we page).
        const maxPages = Math.ceil((Number(currentLength) * 2) / SORTED_CHUNK_PAGE) + 1;
        for (let page = 0; page < maxPages; page++) {
          const [chunk, nextCursor] = (await publicClient.readContract({
            address: sortOverlayAddress,
            abi: SORT_OVERLAY_ABI,
            functionName: "getSortedChunk",
            args: [
              sortInfoUID as `0x${string}`,
              parentAnchor as `0x${string}`,
              cursor,
              BigInt(SORTED_CHUNK_PAGE),
              true,
            ],
          })) as [`0x${string}`[], `0x${string}`];
          sortedUIDs.push(...chunk);
          if (nextCursor === zeroHash || chunk.length === 0) break;
          cursor = nextCursor;
        }

        // 2. Fetch sort keys for the existing list + the new items in a single multicall.
        const allUIDs = [...sortedUIDs, ...items];
        const sortKeyResults = await publicClient.multicall({
          contracts: allUIDs.map(uid => ({
            address: config.sortFunc as `0x${string}`,
            abi: ISORT_FUNC_ABI,
            functionName: "getSortKey" as const,
            args: [uid, sortInfoUID as `0x${string}`] as const,
          })),
          allowFailure: false,
        });
        const sortKeys = sortKeyResults as unknown as `0x${string}`[];

        const currentList = sortedUIDs.map((uid, i) => ({ uid, sortKey: sortKeys[i] }));
        const newList = items.map((uid, i) => ({ uid, sortKey: sortKeys[sortedUIDs.length + i] }));

        // 3. Run the binary search locally.
        const local = computeHintsLocally(currentList, newList);
        leftHints = local.leftHints as `0x${string}`[];
        rightHints = local.rightHints as `0x${string}`[];
      } else {
        // Small list — on-chain computeHints is cheap and avoids the multicall round-trip.
        [leftHints, rightHints] = (await publicClient.readContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "computeHints",
          args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`, items],
        })) as [`0x${string}`[], `0x${string}`[]];
      }

      // Simulate + send transaction
      const { request } = await publicClient.simulateContract({
        address: sortOverlayAddress,
        abi: SORT_OVERLAY_ABI,
        functionName: "processItems",
        args: [
          sortInfoUID as `0x${string}`,
          parentAnchor as `0x${string}`,
          expectedStartIndex,
          items,
          leftHints,
          rightHints,
        ],
        account: walletClient.account,
      });
      const txHash = await walletClient.writeContract(request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      return batchCount;
    },
    [sortOverlayAddress, indexerAddress, parentAnchor, publicClient, walletClient, getSortConfig],
  );

  // ── Process ALL remaining batches — loops until fully synced ─────────────────
  // Shows progress toasts. Handles StaleStartIndex (another caller raced us) by
  // refreshing the index and retrying — no user action needed.
  const processSortAll = useCallback(
    async (sortInfoUID: string, sortName?: string) => {
      if (!sortOverlayAddress || !indexerAddress || !parentAnchor || !publicClient || !walletClient?.account) {
        notification.error("Wallet not connected or missing addresses.");
        return;
      }
      setProcessingUID(sortInfoUID);
      let toastId: string | undefined;
      let batchNum = 0;

      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Re-read index each iteration (handles StaleStartIndex retries + multi-batch progress).
          // getKernelTotal routes through getSortStaleness, so it is sourceType-agnostic.
          const { lastProcessed: currentIndex, totalCount } = await getKernelTotal(sortInfoUID);

          const remaining = totalCount - currentIndex;
          if (remaining <= 0n) {
            if (toastId) notification.remove(toastId);
            if (batchNum === 0) {
              notification.info("Sort is already fully processed.");
            } else {
              notification.success(`"${sortName ?? "Sort"}" fully processed!`);
              onProcessComplete?.();
            }
            break;
          }

          batchNum++;
          const estimatedBatches = Math.ceil(Number(totalCount) / BATCH_SIZE);
          const label = sortName ? `"${sortName}"` : "Sort";
          if (toastId) notification.remove(toastId);
          toastId = notification.loading(
            `Processing ${label}: batch ${batchNum} of ~${estimatedBatches} — approve in wallet...`,
          );

          try {
            await _processBatch(sortInfoUID, currentIndex, totalCount);
          } catch (batchErr: any) {
            // StaleStartIndex: another caller raced us — refresh index and retry this iteration
            const msg: string = batchErr?.shortMessage ?? batchErr?.message ?? "";
            if (msg.includes("StaleStartIndex")) {
              if (toastId) notification.remove(toastId);
              toastId = notification.loading(`${label}: refreshing after concurrent update...`);
              continue;
            }
            throw batchErr;
          }

          // Refresh staleness display after each successful batch
          await fetchStaleness();
          onProcessComplete?.();
        }
      } catch (e: any) {
        console.error("processSortAll failed:", e);
        if (toastId) notification.remove(toastId);
        notification.error(e?.shortMessage ?? e?.message ?? "Processing failed. See console.");
      } finally {
        setProcessingUID(null);
      }
    },
    [
      sortOverlayAddress,
      indexerAddress,
      parentAnchor,
      publicClient,
      walletClient,
      _processBatch,
      getKernelTotal,
      fetchStaleness,
      onProcessComplete,
    ],
  );

  // ── Single-batch silent process — used for auto-process after file upload ───
  // Processes exactly one batch of newly-added items without toasts.
  // The loop variant (processSortAll) is used for user-triggered "Process All".
  const processSort = useCallback(
    async (sortInfoUID: string, { silent = false }: { silent?: boolean } = {}) => {
      if (!sortOverlayAddress || !indexerAddress || !parentAnchor || !publicClient || !walletClient?.account) {
        if (!silent) notification.error("Wallet not connected or missing addresses.");
        return;
      }
      setProcessingUID(sortInfoUID);
      try {
        // sourceType-agnostic: getKernelTotal derives totalCount from staleness.
        const { lastProcessed: currentIndex, totalCount } = await getKernelTotal(sortInfoUID);

        const remaining = totalCount - currentIndex;
        if (remaining <= 0n) {
          if (!silent) notification.info("Sort is already fully processed.");
          return;
        }

        const batchCount = await _processBatch(sortInfoUID, currentIndex, totalCount);
        if (!silent) {
          const stillRemaining = totalCount - currentIndex - BigInt(batchCount);
          if (stillRemaining > 0n) {
            notification.success(
              `Processed ${batchCount}. ${stillRemaining} item${stillRemaining !== 1n ? "s" : ""} remaining.`,
            );
          } else {
            notification.success("Sort fully processed!");
          }
        }
        await fetchStaleness();
        onProcessComplete?.();
      } catch (e: any) {
        console.error("processSort failed:", e);
        if (!silent) notification.error(e?.shortMessage ?? e?.message ?? "Processing failed. See console.");
      } finally {
        setProcessingUID(null);
      }
    },
    [
      sortOverlayAddress,
      indexerAddress,
      parentAnchor,
      publicClient,
      walletClient,
      _processBatch,
      getKernelTotal,
      fetchStaleness,
      onProcessComplete,
    ],
  );

  // Auto-process sorts when autoProcessKey increments (e.g. after file upload).
  // Processes the UIDs listed in autoProcessSortUIDs (user-configured in upload modal),
  // falling back to just the active sort if none are specified.
  const autoProcessKeyRef = useRef(autoProcessKey);
  const autoProcessSortUIDsRef = useRef(autoProcessSortUIDs);
  autoProcessSortUIDsRef.current = autoProcessSortUIDs;
  useEffect(() => {
    if (autoProcessKey > autoProcessKeyRef.current) {
      autoProcessKeyRef.current = autoProcessKey;
      const uids = autoProcessSortUIDsRef.current;
      if (uids && uids.length > 0) {
        // Process each user-selected sort sequentially (each needs a wallet signature)
        (async () => {
          for (const uid of uids) {
            await processSort(uid, { silent: true });
          }
        })();
      } else if (activeSortInfoUID) {
        processSort(activeSortInfoUID, { silent: true });
      }
    }
  }, [autoProcessKey, activeSortInfoUID, processSort]);

  // Compute the label for the active sort
  const activeSortName = activeSortInfoUID
    ? (availableSorts.find(s => s.sortInfoUID === activeSortInfoUID)?.name ?? "Custom")
    : "By Added";

  return (
    <div className="relative flex items-center gap-1">
      <button
        className={`btn btn-sm gap-1 ${activeSortInfoUID ? "btn-primary" : "btn-ghost"}`}
        onClick={() => setIsOpen(o => !o)}
        title="Sort order"
      >
        <ArrowsUpDownIcon className="w-4 h-4" />
        {activeSortName}
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {/* Ascending/Descending toggle — only shown when a sort is active */}
      {activeSortInfoUID && onReverseOrderChange && (
        <button
          className="btn btn-sm btn-ghost px-2"
          onClick={() => onReverseOrderChange(!reverseOrder)}
          title={reverseOrder ? "Descending (click to reverse)" : "Ascending (click to reverse)"}
        >
          {reverseOrder ? <BarsArrowUpIcon className="w-4 h-4" /> : <BarsArrowDownIcon className="w-4 h-4" />}
        </button>
      )}

      {isOpen && (
        <>
          {/* Backdrop to close */}
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 bg-base-200 border border-base-300 rounded-lg shadow-xl min-w-[280px] py-2">
            {/* Default: insertion order */}
            <button
              className={`w-full text-left px-4 py-2.5 hover:bg-base-300 flex items-center justify-between ${!activeSortInfoUID ? "font-bold text-primary" : "text-base-content"}`}
              onClick={() => {
                onSortChange(null);
                setIsOpen(false);
              }}
            >
              <span className="text-sm">By Added</span>
              {!activeSortInfoUID && <span className="text-primary">&#10003;</span>}
            </button>

            {availableSorts.length > 0 && <div className="border-t border-base-300 my-1" />}

            {isLoading && <div className="px-4 py-2.5 text-sm text-base-content/50">Loading sorts...</div>}

            {availableSorts.map(sort => {
              const isActive = sort.sortInfoUID === activeSortInfoUID;
              const fractionRaw = stalenessMap.get(sort.sortInfoUID);
              const fraction: number | null = fractionRaw === undefined ? null : fractionRaw;
              const syncLabel = isFetchingStaleness ? "..." : formatSyncPercent(fraction);
              const isFullySynced = fraction === 1;
              const hasNoData = fraction === null && !isFetchingStaleness;
              const isStale = !isFetchingStaleness && fraction !== null && fraction < 1;
              const isProcessing = processingUID === sort.sortInfoUID;

              return (
                <div
                  key={sort.sortInfoUID}
                  className={`flex items-center gap-2 px-4 py-2.5 hover:bg-base-300 ${isActive ? "bg-base-300" : ""}`}
                >
                  {/* Sort selection button */}
                  <button
                    className={`flex-1 text-left text-sm flex items-center gap-2 ${isActive ? "font-bold text-primary" : "text-base-content"}`}
                    onClick={() => {
                      onSortChange(sort.sortInfoUID);
                      setIsOpen(false);
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      {sort.name}
                      {!sort.isLocal && (
                        <span className="text-xs text-base-content/40" title="Global sort">
                          &#9678;
                        </span>
                      )}
                    </span>
                    {isActive && <span className="text-primary ml-1">&#10003;</span>}
                  </button>

                  {/* Sync % label */}
                  <span
                    className={`text-xs font-mono flex-shrink-0 min-w-[3ch] text-right ${isFullySynced ? "text-success" : hasNoData ? "text-base-content/40" : "text-warning"}`}
                    title="Sorted / total items processed"
                  >
                    {syncLabel}
                  </span>

                  {/* Process All button — shown when sort is not fully synced.
                      Loops through all remaining batches sequentially with toast progress. */}
                  {(isStale || hasNoData) && !isFetchingStaleness && (
                    <button
                      className="btn btn-xs btn-primary btn-outline flex-shrink-0"
                      title="Save this sort on-chain as a public good. You already see the order locally for free — processing persists it so every other viewer loads the sorted list instantly without recomputing. Gas is paid once, shared by all."
                      disabled={isProcessing || !!processingUID || !walletClient?.account}
                      onClick={e => {
                        e.stopPropagation();
                        setIsOpen(false);
                        processSortAll(sort.sortInfoUID, sort.name);
                      }}
                    >
                      {isProcessing ? <span className="loading loading-spinner loading-xs" /> : "Process All"}
                    </button>
                  )}
                </div>
              );
            })}

            {!isLoading && availableSorts.length === 0 && parentAnchor && parentAnchor !== zeroHash && (
              <div className="px-4 py-2.5 text-sm text-base-content/50">No sorts configured</div>
            )}

            {/* New Sort button */}
            {parentAnchor && parentAnchor !== zeroHash && (
              <>
                <div className="border-t border-base-300 my-1" />
                <button
                  className="w-full text-left px-4 py-2.5 hover:bg-base-300 flex items-center gap-2 text-sm text-base-content/60"
                  onClick={() => {
                    setIsOpen(false);
                    setIsCreateSortOpen(true);
                  }}
                >
                  <PlusIcon className="w-4 h-4" />
                  New Sort...
                </button>
              </>
            )}
          </div>
        </>
      )}

      <CreateSortModal
        isOpen={isCreateSortOpen}
        parentAnchorUID={parentAnchor ?? null}
        sortsAnchorUID={sortsAnchorUID as string | undefined}
        anchorSchemaUID={anchorSchemaUID ?? ""}
        sortInfoSchemaUID={sortInfoSchemaUID as string | undefined}
        sortFunctions={sortFunctions}
        onCreated={() => refetchSorts()}
        onClose={() => setIsCreateSortOpen(false)}
      />
    </div>
  );
};
