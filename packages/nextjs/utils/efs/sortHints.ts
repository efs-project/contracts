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
 * ISortFunc sort key format requirements for correct client-side comparison:
 *
 *   computeHintsLocally compares sort keys as raw hex strings (lexicographic byte order).
 *   This matches on-chain behaviour only if the sort key bytes uniquely determine order.
 *   Two conventions are required:
 *
 *   1. Fixed-length keys (e.g. TimestampSort):
 *      Use abi.encodePacked(uint256(value), uid) — 64 bytes total. All keys are the same
 *      length, so raw hex string comparison is correct.
 *
 *   2. Variable-length keys with a string prefix (e.g. NameSort):
 *      Use abi.encodePacked(bytes(name), bytes1(0x00), uid). The null byte terminates the
 *      variable-length name section. Without it, a sort key for name "a" could sort AFTER
 *      "ab" if the uid of "a" starts with a byte > 0x62 ('b'). The null byte guarantees
 *      that "a\x00uid" < "ab\x00uid" regardless of uid values (since 0x00 < any printable
 *      ASCII character). Anchor names must not contain null bytes — which is true by convention.
 *
 *   ISortFunc implementations that don't follow these conventions should use on-chain
 *   computeHints() (which calls isLessThan directly) rather than computeHintsLocally.
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
 * Assumes sort keys follow the ISortFunc format conventions documented above:
 *   - Fixed-length keys (TimestampSort): all keys same width, no padding needed.
 *   - Variable-length keys (NameSort): null-byte terminated before uid, so raw
 *     lexicographic comparison correctly reflects name ordering.
 *
 * Keys of different lengths are compared by padding the shorter key on the RIGHT
 * with zeros. For null-terminated variable-length keys this is harmless (both the
 * null terminator and uid are already present). For fixed-length keys the lengths
 * are always equal so padding never fires.
 */
function compareSortKeys(a: string, b: string): number {
  // Remove "0x" prefix, compare as hex strings
  const aHex = a.startsWith("0x") ? a.slice(2) : a;
  const bHex = b.startsWith("0x") ? b.slice(2) : b;

  // Pad to equal length for comparison
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
