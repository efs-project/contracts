/**
 * Client-side sort hint computation for EFSSortOverlay.processItems.
 *
 * For lists larger than ~1000 items, computing hints on-chain via computeHints()
 * becomes gas-expensive. This utility computes hints locally using sort keys
 * fetched via multicall.
 *
 * Usage:
 *   1. Fetch sort keys for the current sorted list (head→tail) via getSortKey multicall
 *   2. Fetch sort keys for new items to insert
 *   3. Call computeHintsLocally() to get leftHints + rightHints for processItems
 *
 * Hex comparison note:
 *   Sort keys are returned as hex strings ("0x1a2b..."). For numeric keys (timestamps),
 *   sort functions MUST left-pad to fixed 32 bytes (abi.encodePacked(uint256)) so that
 *   lexicographic hex string comparison matches on-chain byte-by-byte evaluation.
 *   NameSort produces variable-length bytes where lexicographic comparison is correct
 *   by nature (name bytes + uid suffix).
 */

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

export interface SortedListItem {
  uid: string;
  sortKey: string; // hex string "0x..."
}

export interface HintResult {
  leftHints: string[];
  rightHints: string[];
}

/**
 * Compare two hex-encoded sort keys lexicographically.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 *
 * This mirrors the on-chain byte-by-byte comparison in ISortFunc.isLessThan.
 * Works correctly for both fixed-length (timestamp) and variable-length (name)
 * sort keys, as long as timestamp keys are left-padded to 32 bytes.
 */
function compareSortKeys(a: string, b: string): number {
  // Remove "0x" prefix, compare as hex strings
  const aHex = a.startsWith("0x") ? a.slice(2) : a;
  const bHex = b.startsWith("0x") ? b.slice(2) : b;

  // Pad to equal length for comparison (shorter = smaller lexicographically)
  const maxLen = Math.max(aHex.length, bHex.length);
  const aPadded = aHex.padEnd(maxLen, "0");
  const bPadded = bHex.padEnd(maxLen, "0");

  if (aPadded < bPadded) return -1;
  if (aPadded > bPadded) return 1;
  return 0;
}

/**
 * Compute processItems hints for a batch of new items to insert into a sorted list.
 *
 * @param currentList  Existing sorted list from head to tail (uid + sortKey pairs).
 *                     Fetch via getSortedChunk + getSortKey multicall.
 * @param newItems     Items to insert (uid + sortKey pairs).
 *                     Items with empty sortKey ("0x") are ineligible — they get
 *                     zero hints and will be skipped by processItems.
 * @returns leftHints and rightHints arrays for processItems, one entry per new item.
 *
 * Time complexity: O(N + M log N) where N = currentList.length, M = newItems.length.
 */
export function computeHintsLocally(currentList: SortedListItem[], newItems: SortedListItem[]): HintResult {
  // Working copy of the list — we splice new items in as we go so subsequent
  // items can find their correct position relative to already-inserted new items.
  const simList: SortedListItem[] = [...currentList];

  const leftHints: string[] = [];
  const rightHints: string[] = [];

  for (const item of newItems) {
    // Ineligible items (empty sort key) get zero hints — processItems will skip them
    if (!item.sortKey || item.sortKey === "0x" || item.sortKey === ZERO_BYTES32) {
      leftHints.push(ZERO_BYTES32);
      rightHints.push(ZERO_BYTES32);
      continue;
    }

    // Binary search: find insertion position (first element > item.sortKey)
    let lo = 0;
    let hi = simList.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareSortKeys(simList[mid].sortKey, item.sortKey) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    const pos = lo;

    leftHints.push(pos === 0 ? ZERO_BYTES32 : simList[pos - 1].uid);
    rightHints.push(pos === simList.length ? ZERO_BYTES32 : simList[pos].uid);

    // Insert into simulation list so subsequent items find correct positions
    simList.splice(pos, 0, item);
  }

  return { leftHints, rightHints };
}

/**
 * Fetch sort keys for a list of UIDs via individual eth_call.
 * For production use, replace with a multicall batch to reduce RPC round-trips.
 *
 * @param uids       UIDs to fetch sort keys for
 * @param getSortKey Function that calls ISortFunc.getSortKey(uid, sortInfoUID)
 * @returns Array of {uid, sortKey} pairs in the same order as uids
 */
export async function fetchSortKeys(
  uids: string[],
  getSortKey: (uid: string) => Promise<string>,
): Promise<SortedListItem[]> {
  return Promise.all(
    uids.map(async uid => ({
      uid,
      sortKey: await getSortKey(uid),
    })),
  );
}
