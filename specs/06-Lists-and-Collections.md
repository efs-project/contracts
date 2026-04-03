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
      └── SORT_INFO: { sortFunc: 0xFractionalSort }
```

The **kernel** (EFSIndexer) tracks these children in insertion order. The **sort overlay** (EFSSortOverlay) maintains per-attester sorted linked lists on top of the kernel arrays, using any pluggable `ISortFunc` comparator.

**Editions on lists:** Positional Anchors ("a0", "a1", …) enable per-position Editions. Alice's DATA on "a1" = hamster.gif, Bob's DATA on "a1" = dragon.jpg. The existing `getDataByAddressList` fallback handles this — no new mechanism needed.

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
    bytes32[] calldata items,      // kernel UIDs in kernel order
    bytes32[] calldata leftHints,  // left neighbour in sorted list (bytes32(0) = insert at head)
    bytes32[] calldata rightHints  // right neighbour in sorted list (bytes32(0) = insert at tail)
) external;
```

**Flow per item:**
1. Skip revoked items (`EFSIndexer.isRevoked(item) == true`) — still advance `_lastProcessedIndex`
2. Skip ineligible items (`sortFunc.getSortKey(item, sortInfoUID)` returns empty) — still advance
3. Validate position: `isLessThan(leftHint, item)` and `isLessThan(item, rightHint)` (sentinels skipped)
4. Insert into sorted linked list between hints
5. Emit `ItemSorted` event (for The Graph / off-chain indexers)

Anyone can call `processItems` — gas is paid by the caller. The overlay is maintained lazily by whoever wants the sort maintained.

### getSortStaleness

```solidity
function getSortStaleness(bytes32 sortInfoUID, address attester) external view returns (uint256);
```

`staleness = kernelCount - lastProcessedIndex`. UI shows: "Alphabetical: 3 items behind".

### getSortedChunk (cursor pagination)

```solidity
function getSortedChunk(
    bytes32 sortInfoUID,
    address attester,
    bytes32 startNode,  // bytes32(0) = start at head
    uint256 limit       // max items, capped at MAX_PAGE_SIZE (100)
) external view returns (bytes32[] memory items, bytes32 nextCursor)
```

Identical cursor semantics to the old `EFSListManager.getSortedChunk`.

---

## 4. Per-Attester Independence

The sorted linked list is keyed by `(sortInfoUID, attester)`:

```
_sortNodes[sortInfoUID][attester][itemUID] → Node
_sortHeads[sortInfoUID][attester]          → first UID (sorted)
_sortTails[sortInfoUID][attester]          → last UID (sorted)
_sortLengths[sortInfoUID][attester]        → count
_lastProcessedIndex[sortInfoUID][attester] → kernel items acknowledged
```

Each attester independently maintains their sorted view of the same kernel array. Alice's sorted list for a sort is separate from Bob's — they pay their own gas and can choose different orderings (by using different ISortFunc contracts or processing items differently).

---

## 5. Client Navigation: Browsing a Directory with Sorts

When browsing `/memes/` (Anchor uid=0xAAA, attester = alice):

```
1. Fetch all children (kernel + attester filter):
   getChildrenByAttester(0xAAA, alice, 0, 50, false, false)
   → [cat.jpg, dog.jpg, hamster.gif, alphabetical, newest-first]

2. Read each Anchor's schemaUID from EAS:
   Files (anchorSchema = bytes32(0)):          [cat.jpg, dog.jpg, hamster.gif]
   Sorts (anchorSchema = SORT_INFO_SCHEMA):    [alphabetical, newest-first]

3. Read SORT_INFO for each sort Anchor → sortFunc, targetSchema
   Only show sorts where targetSchema == DATA_SCHEMA or bytes32(0)

4. UI: "Sort by: Added (default) | Alphabetical ⚡ | Newest First (3 behind)"

5. On sort selection:
   - Call getSortedChunk(sortInfoUID, alice, 0x0, 20)
   - If staleness > 0, prompt: "N items unprocessed — pay gas to maintain?"
```

---

## 6. Gas Costs

| Operation | Gas estimate |
|-----------|-------------|
| processItems (N items, no validation overhead) | ~40–60k per item |
| getSortedChunk page of N | N × SLOAD ≈ 2,100 × N |
| getSortStaleness | 2 × SLOAD + 1 external call |

On L2 (Base, Arbitrum), costs are negligible.
