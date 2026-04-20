/**
 * useEditionDirectoryPage — Cursor-paginated edition-scoped directory listing.
 *
 * Wraps `EFSFileView.getDirectoryPageBySchemaAndAddressList` with ADR-0036
 * opaque-cursor iteration. The contract walks two phases — (0) tagged generic
 * folders and (1) direct-children-by-schema — and enforces a per-call scan
 * budget (`_FOLDER_SCAN_BUDGET_PER_CALL = 2048`). A phase-0 burn can return
 * zero items with a non-empty `nextCursor`; callers MUST replay that cursor
 * or the view appears permanently empty even when phase-1 has files.
 *
 * This hook handles that by auto-advancing the cursor on empty pages until
 * either the target page size is reached or the cursor is exhausted. Explicit
 * `loadMore()` reads the next page; `reset()` / `refresh()` start over from
 * the first cursor.
 *
 * Usage:
 *   const { items, isLoading, hasMore, loadMore, refresh } = useEditionDirectoryPage({
 *     parentAnchor,
 *     dataSchemaUID,
 *     editionAddresses,
 *     fileViewAddress,
 *     fileViewAbi,
 *     pageSize: 50n,
 *     enabled: useEditionsQuery,
 *   });
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Abi } from "viem";
import { usePublicClient } from "wagmi";

interface UseEditionDirectoryPageOptions {
  parentAnchor: `0x${string}` | undefined;
  dataSchemaUID: `0x${string}` | undefined;
  editionAddresses: string[];
  fileViewAddress: `0x${string}` | undefined;
  fileViewAbi: Abi | undefined;
  /** Target items per user-facing page. Default 50. */
  pageSize?: bigint;
  /** False disables the hook entirely (state cleared, no fetches). */
  enabled: boolean;
}

interface UseEditionDirectoryPageResult {
  items: any[] | undefined;
  isLoading: boolean;
  /** True when the cursor is non-empty (more pages available). */
  hasMore: boolean;
  /** Load the next user-facing page. */
  loadMore: () => void;
  /** Reset to the first cursor and refetch page 1. */
  refresh: () => Promise<void>;
}

const EMPTY_CURSOR = "0x" as `0x${string}`;

/**
 * Safety cap on auto-advance loops within a single user-facing page load.
 * The contract's `_FOLDER_SCAN_BUDGET_PER_CALL = 2048` bounds work per call,
 * so 20 auto-advances covers 40k scan entries — far beyond any realistic
 * phase-0 skip pattern. Prevents a runaway loop if a resolver bug ever
 * returns non-empty cursors with zero progress.
 */
const MAX_AUTO_ADVANCE_PAGES = 20;

export function useEditionDirectoryPage({
  parentAnchor,
  dataSchemaUID,
  editionAddresses,
  fileViewAddress,
  fileViewAbi,
  pageSize = 50n,
  enabled,
}: UseEditionDirectoryPageOptions): UseEditionDirectoryPageResult {
  const publicClient = usePublicClient();
  const [items, setItems] = useState<any[] | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadTrigger, setLoadTrigger] = useState(0);
  const cursorRef = useRef<`0x${string}`>(EMPTY_CURSOR);

  const editionsKey = editionAddresses.join(",").toLowerCase();
  const depsKey = `${enabled ? "1" : "0"}|${parentAnchor ?? ""}|${dataSchemaUID ?? ""}|${editionsKey}|${pageSize.toString()}`;
  const lastDepsRef = useRef<string>("");
  // NOTE: There was previously an `inFlightRef` guard at the top of the fetch
  // effect (`if (inFlightRef.current) return;`) intended to prevent concurrent
  // reads. It silently dropped `loadTrigger` bumps that landed while a prior
  // fetch was still settling — including refresh() bumps — so callers awaiting
  // `await refetchEditionItems()` after a delete could hang forever with the
  // resolver never installed. See P1 review on #9.
  //
  // The `cancelled` closure flag + the `ownedResolver` identity check already
  // prevent stale fetches from committing state or prematurely resolving a
  // newer refresh's awaiter, so the guard was redundant safety masquerading
  // as correctness. Removed; every loadTrigger advance triggers a fresh fetch,
  // and the old fetch bails on `cancelled` without clobbering the new one.

  // When callers `await refresh()` they expect to see the post-delete result
  // before re-rendering logic runs. We resolve this promise when the next
  // fetch triggered by refresh completes.
  const refreshPendingRef = useRef<(() => void) | null>(null);

  // Reset accumulator whenever the identity of the query changes. We eagerly
  // set `isLoading=true` when scheduling the first fetch so the brief render
  // gap between this effect and the fetch effect (below) doesn't flash a
  // "no results" state to the caller.
  useEffect(() => {
    if (lastDepsRef.current === depsKey) return;
    lastDepsRef.current = depsKey;
    cursorRef.current = EMPTY_CURSOR;
    setItems(enabled ? [] : undefined);
    setHasMore(enabled);
    setIsLoading(enabled);
    if (enabled) setLoadTrigger(t => t + 1);
  }, [depsKey, enabled]);

  const loadMore = useCallback(() => {
    if (!enabled) return;
    setLoadTrigger(t => t + 1);
  }, [enabled]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    // Resolve any previously-pending refresh — the new one supersedes it.
    refreshPendingRef.current?.();
    await new Promise<void>(resolve => {
      refreshPendingRef.current = resolve;
      cursorRef.current = EMPTY_CURSOR;
      setItems([]);
      setHasMore(true);
      setLoadTrigger(t => t + 1);
    });
  }, [enabled]);

  // Effect fires whenever loadTrigger advances. Auto-advances the opaque cursor
  // across budget-exhausted pages until we either hit `pageSize` items or the
  // cursor returns empty (ADR-0036 terminator).
  useEffect(() => {
    if (!enabled) return;
    if (loadTrigger === 0) return;
    if (!publicClient || !fileViewAddress || !fileViewAbi) return;
    if (!parentAnchor || !dataSchemaUID) return;
    if (editionAddresses.length === 0) return;

    let cancelled = false;

    // Snapshot the refresh resolver (if any) that this fetch is responsible
    // for. A later `refresh()` call resolves the previous resolver
    // synchronously and installs a *new* one before bumping `loadTrigger`,
    // which cancels this fetch and schedules a fresh one. Without this
    // snapshot, a cancelled older fetch's `finally` block would see the
    // newer resolver in `refreshPendingRef.current` and resolve it
    // prematurely — before the fresh fetch has populated `items`. Awaiters
    // of the newer `refresh()` would then observe stale directory state.
    //
    // Pairing the snapshot with an identity check on resolve ensures
    // exactly one fetch instance — the one whose `refresh()` installed
    // this resolver — can clear it, and only when it actually committed
    // state (i.e. wasn't cancelled).
    const ownedResolver = refreshPendingRef.current;

    (async () => {
      setIsLoading(true);
      const collected: any[] = [];
      let cursor = cursorRef.current;
      let autoPages = 0;
      let exhausted = false;

      try {
        while (autoPages < MAX_AUTO_ADVANCE_PAGES) {
          const result = (await publicClient.readContract({
            address: fileViewAddress,
            abi: fileViewAbi,
            functionName: "getDirectoryPageBySchemaAndAddressList",
            args: [parentAnchor, dataSchemaUID, editionAddresses as `0x${string}`[], cursor, pageSize],
          })) as any;

          if (cancelled) return;

          // Solidity struct decodes as either a named object or a positional tuple
          // depending on viem version / ABI shape — handle both defensively.
          const pageItems: any[] = result?.items ?? result?.[0] ?? [];
          const nextCursor: `0x${string}` = (result?.nextCursor ?? result?.[1] ?? EMPTY_CURSOR) as `0x${string}`;

          collected.push(...pageItems);
          cursor = nextCursor;
          autoPages++;

          // Empty cursor = both phases exhausted (ADR-0036).
          if (!nextCursor || nextCursor === EMPTY_CURSOR || nextCursor.length <= 2) {
            exhausted = true;
            break;
          }

          // Target reached — stop auto-advancing and wait for explicit loadMore.
          if (collected.length >= Number(pageSize)) break;

          // Otherwise: this page returned fewer items than requested with a
          // non-empty cursor (phase-0 budget burn). Auto-advance so the user
          // doesn't see an empty grid when phase-1 has matches.
        }

        if (cancelled) return;

        cursorRef.current = cursor;
        setHasMore(!exhausted);
        setItems(prev => [...(prev ?? []), ...collected]);
      } catch (err) {
        console.error("useEditionDirectoryPage: fetch failed", err);
        if (!cancelled) setHasMore(false);
      } finally {
        if (!cancelled) setIsLoading(false);
        // Resolve the awaiter from `refresh()` so callers that do
        // `await refetchEditionItems()` see the post-fetch state before
        // continuing (delete-then-refresh flow). Two gates:
        //   1. `!cancelled` — a cancelled fetch never committed state,
        //      so resolving here would hand stale data to the awaiter.
        //      The successor fetch will resolve it instead.
        //   2. Identity check — if a later `refresh()` already replaced
        //      the resolver (meaning our owner was previously resolved
        //      by `refresh()` itself), do nothing. The newer fetch owns
        //      the newer resolver.
        if (!cancelled && ownedResolver && refreshPendingRef.current === ownedResolver) {
          refreshPendingRef.current = null;
          ownedResolver();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // cursorRef is mutable-ref; editionsKey stands in for editionAddresses equality.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    loadTrigger,
    enabled,
    publicClient,
    fileViewAddress,
    fileViewAbi,
    parentAnchor,
    dataSchemaUID,
    editionsKey,
    pageSize,
  ]);

  return { items, isLoading, hasMore, loadMore, refresh };
}
