# Lists and Collections

EFS lists are a special case of directories. The same kernel/overlay architecture that powers file browsing handles curated collections, social graphs, and ranked orderings. There is no separate "list" contract — **everything is kernel data + sort overlay**.

For the full schema definitions see [Data Models and Schemas](./02-Data-Models-and-Schemas.md) and for indexing details see [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

---

## 1. Core Concept: Everything Is A Directory

A curated list is just a directory whose children are **positional Anchors**:

```
/mytopmemes/ (Anchor uid=0xBBB)
 ├── "a0" (Anchor, refUID=0xBBB)  →  DATA pointing to cat.jpg
 ├── "a1" (Anchor, refUID=0xBBB)  →  DATA pointing to hamster.gif
 ├── "a2" (Anchor, refUID=0xBBB)  →  DATA pointing to dog.jpg
 └── by-preference (Anchor, schema=SORT_INFO)
      └── SORT_INFO: { sortFunc: <FractionalSort address> }
```

The **kernel** (EFSIndexer) tracks these children in insertion order. The **sort overlay** (EFSSortOverlay) maintains a **shared** sorted linked list per `(sortInfoUID, parentAnchor)` on top of the kernel arrays, using any pluggable `ISortFunc` comparator. Edition filtering is applied at read time via `getSortedChunkByAddressList`.

**Editions on lists:** Positional Anchors ("a0", "a1", …) enable per-position Editions. Alice tags her DATA at "a1" = hamster.gif, Bob tags his DATA at "a1" = dragon.jpg. The existing TAG-based placement via `getActiveTargetsByAttesterAndSchema` handles this — no new mechanism needed.

---

## 2. SORT_INFO Schema

```
SORT_INFO: "address sortFunc, bytes32 targetSchema"
```

| Field | Description |
|-------|-------------|
| `sortFunc` | Address of an `ISortFunc` contract defining the comparator |
| `targetSchema` | Which Anchor schema to sort — `bytes32(0)` = all children, `DATA_SCHEMA` = only file anchors |
| `refUID` | Naming Anchor UID — the Anchor is a **child** of the directory being sorted (its schema = `SORT_INFO_SCHEMA`) |
| revocable | `true` — revoking signals "I'm done maintaining this sort; hide from menu" |

The naming Anchor's parent (`EFSIndexer.getParent(namingAnchorUID)`) is the directory being sorted. EFSSortOverlay uses this to find the kernel array for staleness calculation.

**Client discovery:** `getAnchorsBySchema(parentUID, SORT_INFO_SCHEMA, 0, 100, false, false)` returns all sort definition Anchors under a directory. The client reads SORT_INFO data for each to get `sortFunc` and `targetSchema`.

**Default sort:** A PROPERTY attestation on the parent Anchor with `key = "defaultSort"`, `value = <SORT_INFO UID>` signals the preferred default. Per-attester (Editions model) — each viewer can set their own default.

---

## 3. Sort Overlay Architecture

### ISortFunc Interface

```solidity
interface ISortFunc {
    function isLessThan(bytes32 a, bytes32 b, bytes32 sortInfoUID) external view returns (bool);
    function getSortKey(bytes32 uid, bytes32 sortInfoUID) external view returns (bytes memory);
}
```

- `isLessThan` — O(1) on-chain validation (2 calls per item in `processItems`)
- `getSortKey` — client calls once per item, sorts locally by returned bytes, then submits sorted order to `processItems` (avoids N² comparison calls on-chain)
- Empty bytes from `getSortKey` = ineligible item (client/overlay skips it)

Reference implementations: `AlphabeticalSort` (reads Anchor name), `TimestampSort` (reads attestation.time).

### processItems — Lazy Client-Hinted Sorting

```solidity
function processItems(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,          // the directory being sorted
    uint256 expectedStartIndex,    // _lastProcessedIndex at call time (concurrency guard)
    bytes32[] calldata items,      // kernel UIDs in kernel order
    bytes32[] calldata leftHints,  // left neighbour in sorted list (bytes32(0) = insert at head)
    bytes32[] calldata rightHints  // right neighbour in sorted list (bytes32(0) = insert at tail)
) external;
```

**Flow per item:**
1. **Validate membership**: `getChildrenByAttesterAt(parentUID, attester, lastProcessedIndex) == item` — reverts with `InvalidItem` if the submitted UID does not match the expected kernel position. This prevents callers from injecting arbitrary UIDs into their sorted list.
2. Skip revoked items (`EFSIndexer.isRevoked(item) == true`) — still advance `_lastProcessedIndex`
3. Skip ineligible items (`sortFunc.getSortKey(item, sortInfoUID)` returns empty) — still advance
4. Validate position: `isLessThan(leftHint, item)` and `isLessThan(item, rightHint)` (sentinels skipped)
5. Insert into sorted linked list between hints
6. Emit `ItemSorted` event (for The Graph / off-chain indexers)

Anyone can call `processItems` — gas is paid by the caller. The overlay is maintained lazily by whoever wants the sort maintained.

### getSortStaleness

```solidity
function getSortStaleness(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (uint256);
```

`staleness = kernelCount - lastProcessedIndex`. UI shows: "Alphabetical: 3 items behind".

**Note — conservative upper bound**: Staleness counts all unprocessed kernel items, including items that `ISortFunc.getSortKey` would deem ineligible (wrong schema, corrupted data, etc.). Ineligible items advance `_lastProcessedIndex` without entering the sorted list. So staleness may be slightly higher than the number of items that will actually be inserted. This is by design — checking eligibility on-chain for every unprocessed item would be prohibitively expensive as a read call. The UI should show staleness as "up to N items behind" rather than an exact count.

### getSortedChunk (cursor pagination)

```solidity
function getSortedChunk(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    bytes32 startNode,   // bytes32(0) = start at head
    uint256 limit,       // max items, capped at MAX_PAGE_SIZE (100)
    bool showRevoked
) external view returns (bytes32[] memory items, bytes32 nextCursor)
```

Returns `(items[], nextCursor)`. Pass `nextCursor` as `startNode` on the next call. `bytes32(0)` nextCursor means end of list.

---

## 4. Shared List + Edition Filtering at Read Time

The sorted linked list is keyed by `(sortInfoUID, parentAnchor)` — one shared ordering per directory:

```
_sortNodes[sortInfoUID][parentAnchor][itemUID] → Node
_sortHeads[sortInfoUID][parentAnchor]          → first UID (sorted)
_sortTails[sortInfoUID][parentAnchor]          → last UID (sorted)
_sortLengths[sortInfoUID][parentAnchor]        → count
_lastProcessedIndex[sortInfoUID][parentAnchor] → kernel items acknowledged
```

All attesters contribute to a single sorted list per `(sortInfoUID, parentAnchor)`. Anyone can call `processItems` and pay gas to maintain it. Edition filtering is applied at read time via `getSortedChunkByAddressList(sortInfoUID, parentAnchor, startNode, limit, attesters)` — only items contributed by the specified attesters are returned, in sorted order.

---

## 5. Client Navigation: Browsing a Directory with Sorts

When browsing `/memes/` (Anchor uid=0xAAA, attester = alice):

```
1. Fetch sort naming anchors (separate from file children):
   getAnchorsBySchema(0xAAA, SORT_INFO_SCHEMA_UID, 0, 50, false, false)
   → [alphabetical-namingUID, newest-first-namingUID]

   Fetch file children from multiple attesters (schema-filtered):
   getAnchorsBySchemaAndAddressList(0xAAA, DATA_SCHEMA_UID, [alice, bob], 0, 50, true, false)
   → [cat.jpg, dog.jpg, hamster.gif]  (only DATA-schema anchors, deduped)

   Or for a single attester:
   getChildrenByAttester(0xAAA, alice, 0, 50, false, false)
   → [cat.jpg, dog.jpg, hamster.gif]  (alice's items; sort anchors she didn't create won't appear)

   Note: sort naming anchors have anchorSchema = SORT_INFO_SCHEMA_UID.
   Schema-filtered queries keep them out of file listings automatically.

2. Resolve SORT_INFO UID for each naming anchor (fully on-chain):
   getReferencingAttestations(namingAnchorUID, SORT_INFO_SCHEMA_UID, 0, 10, false)
   → [sortInfoUID, ...]

   This works because EFSSortOverlay.onAttest calls indexer.index(uid), registering
   every SORT_INFO attestation into EFSIndexer's generic referencing indices.

3. Read sort config and staleness:
   overlay.getSortConfig(sortInfoUID)               → { sortFunc, targetSchema, valid, revoked }
   overlay.getSortStaleness(sortInfoUID, 0xAAA)     → N (unprocessed items for this directory)

4. UI: "Sort by: Added (default) | Alphabetical ⚡ | Newest First (3 behind)"

5. On sort selection:
   - Call getSortedChunk(sortInfoUID, 0xAAA, bytes32(0), 20, false) for all items
   - Or getSortedChunkByAddressList(sortInfoUID, 0xAAA, bytes32(0), 20, [alice]) for edition-filtered
   - If staleness > 0, prompt: "N items unprocessed — pay gas to maintain?"
   - If user accepts, run processItems (see workflow 14 in Core Workflows)
```

---

## 6. processItems — Hint Computation

The contract validates hints on-chain with `isLessThan`, so `processItems` requires correct `leftHint`/`rightHint` pairs or it reverts with `InvalidPosition`.

**On-chain (recommended):** Call `overlay.computeHints(sortInfoUID, parentAnchor, newItems)` — a free `view` function (`eth_call`) that computes all hints for a batch. No client-side sort logic needed:

```ts
const startIndex = await overlay.getLastProcessedIndex(sortInfoUID, parentAnchor);
const [leftHints, rightHints] = await overlay.computeHints(sortInfoUID, parentAnchor, newItems);
await overlay.processItems(sortInfoUID, parentAnchor, startIndex, newItems, leftHints, rightHints);
```

**Client-side (fallback, for custom sorting or offline use):** Compute hints locally using the TypeScript algorithm below. Useful when the client already has sort keys cached or wants to avoid the `computeHints` call.

**Algorithm** (TypeScript pseudocode):

```ts
async function computeHints(newItems, alreadySorted, sortFunc, sortInfoUID) {
  // 1. Fetch sort keys for all items
  const newKeys    = await Promise.all(newItems.map(uid => sortFunc.getSortKey(uid, sortInfoUID)))
  const existKeys  = await Promise.all(alreadySorted.map(uid => sortFunc.getSortKey(uid, sortInfoUID)))

  // 2. Simulate the sorted list state, mutating as we go
  const simList = [...alreadySorted]
  const simKeys = [...existKeys]
  const leftHints = [], rightHints = []

  for (let i = 0; i < newItems.length; i++) {
    const key = newKeys[i]

    if (key.length === 0) {
      // Ineligible item — overlay skips it; hints don't matter
      leftHints.push(ZeroHash); rightHints.push(ZeroHash); continue
    }

    // Binary search: find first pos where simKeys[pos] > key
    let lo = 0, hi = simList.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compare(simKeys[mid], key) <= 0) lo = mid + 1
      else hi = mid
    }
    const pos = lo

    leftHints.push(pos === 0 ? ZeroHash : simList[pos - 1])
    rightHints.push(pos === simList.length ? ZeroHash : simList[pos])

    // Update simulation so subsequent items in batch see correct state
    simList.splice(pos, 0, newItems[i])
    simKeys.splice(pos, 0, key)
  }

  return { leftHints, rightHints }
}
```

**Key invariants:**
- `newItems` must be in kernel order starting from `getLastProcessedIndex(sortInfoUID, parentAnchor)`
- Process items in kernel order — don't reorder them before calling `processItems`
- The simulation must account for items inserted earlier in the same batch
- `bytes32(0)` hints are sentinels: left=ZeroHash means "insert at head", right=ZeroHash means "insert at tail"

## 7. Gas Costs

| Operation | Gas estimate |
|-----------|-------------|
| processItems (N items, no validation overhead) | ~40–60k per item |
| getSortedChunk page of N | N × SLOAD ≈ 2,100 × N |
| getSortStaleness | 2 × SLOAD + 1 external call |

On L2 (Base, Arbitrum), costs are negligible.
