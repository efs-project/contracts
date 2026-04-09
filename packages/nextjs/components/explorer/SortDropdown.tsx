"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { zeroHash } from "viem";
import { usePublicClient, useWalletClient } from "wagmi";
import { ArrowsUpDownIcon, BarsArrowDownIcon, BarsArrowUpIcon, ChevronDownIcon } from "@heroicons/react/24/outline";
import { useSortDiscovery } from "~~/hooks/efs/useSortDiscovery";
import { SortOverlayInfo, SORT_OVERLAY_ABI, formatSyncPercent } from "~~/utils/efs/sortOverlay";
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
  /** Increment to auto-process the active sort (e.g. after file upload) */
  autoProcessKey?: number;
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
}: SortDropdownProps) => {
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [isOpen, setIsOpen] = useState(false);
  // Lazily-fetched staleness: sortInfoUID → fraction (0–1) or null
  const [stalenessMap, setStalenessMap] = useState<Map<string, number | null>>(new Map());
  const [isFetchingStaleness, setIsFetchingStaleness] = useState(false);
  // Which sort is currently being processed (null = none)
  const [processingUID, setProcessingUID] = useState<string | null>(null);

  const { availableSorts, isLoading } = useSortDiscovery({
    parentAnchor,
    indexerAddress,
    easAddress,
    editionAddresses,
    filterBySchema,
  });

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

  // ── Process a batch of items into the sorted list ──────────────────────────
  const processSort = useCallback(
    async (sortInfoUID: string, { silent = false }: { silent?: boolean } = {}) => {
      if (!sortOverlayAddress || !indexerAddress || !parentAnchor || !publicClient || !walletClient?.account) {
        if (!silent) notification.error("Wallet not connected or missing addresses.");
        return;
      }
      setProcessingUID(sortInfoUID);
      try {
        // 1. Get current position and total kernel count
        const [expectedStartIndex, totalCount] = await Promise.all([
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

        const remaining = totalCount - expectedStartIndex;
        if (remaining <= 0n) {
          if (!silent) notification.info("Sort is already fully processed.");
          setProcessingUID(null);
          return;
        }

        // 2. Fetch the next batch of items from the kernel
        const batchCount = remaining < BigInt(BATCH_SIZE) ? Number(remaining) : BATCH_SIZE;
        // NOTE: fetching one-by-one is fine for small dirs; use multicall for large dirs
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

        // 3. Compute insertion hints (free view call — uses binary search on-chain)
        const [leftHints, rightHints] = (await publicClient.readContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "computeHints",
          args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`, items],
        })) as [`0x${string}`[], `0x${string}`[]];

        // 4. Send processItems transaction
        const { request } = await publicClient.simulateContract({
          address: sortOverlayAddress,
          abi: SORT_OVERLAY_ABI,
          functionName: "processItems",
          args: [sortInfoUID as `0x${string}`, parentAnchor as `0x${string}`, expectedStartIndex, items, leftHints, rightHints],
          account: walletClient.account,
        });

        let toastId: string | undefined;
        if (!silent) toastId = notification.loading(`Processing ${batchCount} item${batchCount !== 1 ? "s" : ""}...`);
        const txHash = await walletClient.writeContract(request);
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        if (toastId) notification.remove(toastId);

        if (!silent) {
          const stillRemaining = remaining - BigInt(batchCount);
          if (stillRemaining > 0n) {
            notification.success(`Processed ${batchCount}. ${stillRemaining} remaining.`);
          } else {
            notification.success("Sort fully processed!");
          }
        }

        // Refresh staleness display and notify FileBrowser to re-fetch sorted data
        await fetchStaleness();
        onProcessComplete?.();
      } catch (e: any) {
        console.error("processItems failed:", e);
        notification.error(e?.shortMessage ?? e?.message ?? "Processing failed. See console.");
      } finally {
        setProcessingUID(null);
      }
    },
    [sortOverlayAddress, indexerAddress, parentAnchor, publicClient, walletClient, fetchStaleness, onProcessComplete],
  );

  // Auto-process all sorts when autoProcessKey increments (e.g. after file upload)
  const autoProcessKeyRef = useRef(autoProcessKey);
  useEffect(() => {
    if (autoProcessKey > autoProcessKeyRef.current && availableSorts.length > 0) {
      autoProcessKeyRef.current = autoProcessKey;
      (async () => {
        for (const sort of availableSorts) {
          await processSort(sort.sortInfoUID, { silent: true });
        }
      })();
    }
  }, [autoProcessKey, availableSorts, processSort]);

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

            {isLoading && (
              <div className="px-4 py-2.5 text-sm text-base-content/50">Loading sorts...</div>
            )}

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
                      {!sort.isLocal && <span className="text-xs text-base-content/40" title="Global sort">&#9678;</span>}
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

                  {/* Process button — shown when sort is not fully synced */}
                  {(isStale || hasNoData) && !isFetchingStaleness && (
                    <button
                      className="btn btn-xs btn-primary btn-outline flex-shrink-0"
                      title={`Process next ${BATCH_SIZE} items into sorted list`}
                      disabled={isProcessing || !walletClient?.account}
                      onClick={e => {
                        e.stopPropagation();
                        processSort(sort.sortInfoUID);
                      }}
                    >
                      {isProcessing ? (
                        <span className="loading loading-spinner loading-xs" />
                      ) : (
                        "Process"
                      )}
                    </button>
                  )}
                </div>
              );
            })}

            {!isLoading && availableSorts.length === 0 && parentAnchor && parentAnchor !== zeroHash && (
              <div className="px-4 py-2.5 text-sm text-base-content/50">No sorts configured</div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
