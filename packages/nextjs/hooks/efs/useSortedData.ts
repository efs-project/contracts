/**
 * useSortedData — Cursor-paginated sorted data from EFSSortOverlay.
 *
 * When sortInfoUID is null, returns null (caller falls back to kernel order).
 * When sortInfoUID is set, fetches sorted UIDs from the shared sorted list,
 * filtered by the editions address list.
 *
 * Usage:
 *   const { sortedUIDs, isLoading, hasMore, loadMore, reset } = useSortedData({
 *     sortInfoUID,
 *     parentAnchor,
 *     sortOverlayAddress,
 *     editionAddresses,
 *     pageSize: 50,
 *   });
 *
 * When sortInfoUID is null, sortedUIDs is null — the caller should use the
 * standard getDirectoryPage / getDirectoryPageByAddressList APIs instead.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { zeroHash } from "viem";
import { usePublicClient } from "wagmi";
import { DEFAULT_MAX_TRAVERSAL, SORT_OVERLAY_ABI } from "~~/utils/efs/sortOverlay";

interface UseSortedDataOptions {
  sortInfoUID: string | null;
  parentAnchor: string | undefined;
  sortOverlayAddress: `0x${string}` | undefined;
  editionAddresses: string[];
  pageSize?: number;
  showRevoked?: boolean;
  /** Increment to force a full re-fetch from the start (e.g. after processItems completes) */
  refreshKey?: number;
}

interface UseSortedDataResult {
  /** Sorted UIDs accumulated across pages, or null if no active sort */
  sortedUIDs: string[] | null;
  isLoading: boolean;
  /** True if there are more pages to load */
  hasMore: boolean;
  /** Load the next page */
  loadMore: () => void;
  /** Reset to empty state (call when sort or anchor changes) */
  reset: () => void;
}

export function useSortedData({
  sortInfoUID,
  parentAnchor,
  sortOverlayAddress,
  editionAddresses,
  pageSize = 50,
  showRevoked = false,
  refreshKey = 0,
}: UseSortedDataOptions): UseSortedDataResult {
  const publicClient = usePublicClient();
  const [sortedUIDs, setSortedUIDs] = useState<string[] | null>(null);
  const [cursor, setCursor] = useState<string>(zeroHash);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadTrigger, setLoadTrigger] = useState(0);

  // Track the current sort/anchor to detect changes
  const currentSortRef = useRef<string | null>(null);
  const currentAnchorRef = useRef<string | undefined>(undefined);
  const currentEditionsRef = useRef<string>("");
  const currentRefreshKeyRef = useRef<number>(0);

  const editionsKey = editionAddresses.join(",");

  // Reset when sort, anchor, editions, or refreshKey change
  useEffect(() => {
    const changed =
      currentSortRef.current !== sortInfoUID ||
      currentAnchorRef.current !== parentAnchor ||
      currentEditionsRef.current !== editionsKey ||
      currentRefreshKeyRef.current !== refreshKey;

    if (changed) {
      currentSortRef.current = sortInfoUID;
      currentAnchorRef.current = parentAnchor;
      currentEditionsRef.current = editionsKey;
      currentRefreshKeyRef.current = refreshKey;

      setSortedUIDs(sortInfoUID ? [] : null);
      setCursor(zeroHash);
      setHasMore(!!sortInfoUID);
      setLoadTrigger(0);
    }
  }, [sortInfoUID, parentAnchor, editionsKey, refreshKey]);

  const reset = useCallback(() => {
    setSortedUIDs(sortInfoUID ? [] : null);
    setCursor(zeroHash);
    setHasMore(!!sortInfoUID);
    setLoadTrigger(0);
  }, [sortInfoUID]);

  const loadMore = useCallback(() => {
    setLoadTrigger(t => t + 1);
  }, []);

  // Load next page when trigger fires
  useEffect(() => {
    if (!sortInfoUID || !parentAnchor || !sortOverlayAddress || !publicClient) return;
    if (parentAnchor === zeroHash) return;
    // Don't re-fetch if we're at the end (cursor = zeroHash and we already loaded something)
    if (loadTrigger > 0 && cursor === zeroHash) return;

    let cancelled = false;

    async function fetchPage() {
      if (!publicClient || !sortOverlayAddress) return;

      setIsLoading(true);
      try {
        let result: readonly [readonly `0x${string}`[], `0x${string}`];

        if (editionAddresses.length > 0) {
          result = await publicClient.readContract({
            address: sortOverlayAddress,
            abi: SORT_OVERLAY_ABI,
            functionName: "getSortedChunkByAddressList",
            args: [
              sortInfoUID as `0x${string}`,
              parentAnchor as `0x${string}`,
              cursor as `0x${string}`,
              BigInt(pageSize),
              DEFAULT_MAX_TRAVERSAL,
              editionAddresses as `0x${string}`[],
              showRevoked,
            ],
          });
        } else {
          result = await publicClient.readContract({
            address: sortOverlayAddress,
            abi: SORT_OVERLAY_ABI,
            functionName: "getSortedChunk",
            args: [
              sortInfoUID as `0x${string}`,
              parentAnchor as `0x${string}`,
              cursor as `0x${string}`,
              BigInt(pageSize),
              showRevoked,
            ],
          });
        }

        if (cancelled) return;

        const [items, nextCursor] = result;
        const newUIDs = items.map(uid => uid as string);

        setSortedUIDs(prev => [...(prev ?? []), ...newUIDs]);
        setCursor(nextCursor as string);
        setHasMore(nextCursor !== zeroHash);
      } catch (err) {
        console.error("useSortedData: fetch failed", err);
        if (!cancelled) setHasMore(false);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    fetchPage();
    return () => {
      cancelled = true;
    };
  }, [sortInfoUID, parentAnchor, sortOverlayAddress, publicClient, editionAddresses, showRevoked, pageSize, cursor, loadTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  return { sortedUIDs, isLoading, hasMore, loadMore, reset };
}
