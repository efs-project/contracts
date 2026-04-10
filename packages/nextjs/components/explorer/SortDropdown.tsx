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
import { SORT_OVERLAY_ABI, SortOverlayInfo, formatSyncPercent } from "~~/utils/efs/sortOverlay";
import { notification } from "~~/utils/scaffold-eth";

// ABI for getChildAt / getChildrenCount — used during processItems batching
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
    inputs: [{ internalType: "bytes32", name: "anchorUID", type: "bytes32" }],
    name: "getChildrenCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BATCH_SIZE = 100;

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

      // Fetch items from kernel (sequential; use multicall for very large dirs)
      const items: `0x${string}`[] = [];
      for (let i = 0; i < batchCount; i++) {
        const uid = (await publicClient.readContract({
          address: indexerAddress,
          abi: INDEXER_PROCESS_ABI,
          functionName: "getChildAt",
          args: [parentAnchor as `0x${string}`, expectedStartIndex + BigInt(i)],
        })) as `0x${string}`;
        items.push(uid);
      }

      // Compute insertion hints (free view call — on-chain binary search)
      const [leftHints, rightHints] = (await publicClient.readContract({
        address: sortOverlayAddress,
        abi: SORT_OVERLAY_ABI,
        functionName: "computeHints",
        args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`, items],
      })) as [`0x${string}`[], `0x${string}`[]];

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
    [sortOverlayAddress, indexerAddress, parentAnchor, publicClient, walletClient],
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
          // Re-read index each iteration (handles StaleStartIndex retries + multi-batch progress)
          const [currentIndex, totalCount] = await Promise.all([
            publicClient.readContract({
              address: sortOverlayAddress,
              abi: SORT_OVERLAY_ABI,
              functionName: "getLastProcessedIndex",
              args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: indexerAddress,
              abi: INDEXER_PROCESS_ABI,
              functionName: "getChildrenCount",
              args: [parentAnchor as `0x${string}`],
            }) as Promise<bigint>,
          ]);

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
        const [currentIndex, totalCount] = await Promise.all([
          publicClient.readContract({
            address: sortOverlayAddress,
            abi: SORT_OVERLAY_ABI,
            functionName: "getLastProcessedIndex",
            args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`],
          }) as Promise<bigint>,
          publicClient.readContract({
            address: indexerAddress,
            abi: INDEXER_PROCESS_ABI,
            functionName: "getChildrenCount",
            args: [parentAnchor as `0x${string}`],
          }) as Promise<bigint>,
        ]);

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
                      title="Process all remaining items into sorted list (loops all batches)"
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
