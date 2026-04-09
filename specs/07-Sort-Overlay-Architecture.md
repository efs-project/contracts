# EFS Sort Overlay Architecture

## Overview

EFSSortOverlay is a separate contract that maintains sorted views over EFSIndexer kernel arrays. It is an overlay — it does not change the kernel, only adds ordered access to it. Sorts are lazily populated: items are inserted one batch at a time by any caller, who pays the gas.

---

## Core Design Principle: Shared Sorted Lists

Sorted lists are keyed by `(sortInfoUID, parentAnchor)`, **not** per-attester. Anyone can advance the shared sorted list. Gas spent processing a sort is a public good that benefits all readers of that parent anchor with that sort applied.

Per-attester filtered views are achieved at **read time** via `getSortedChunkByAddressList`, which walks the shared list and filters by `containsAttestations(itemUID, attester)`.

---

## Storage Model

```solidity
mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => Node))) _sortNodes;
    // sortInfoUID → parentAnchor → itemUID → Node{prev, next}
mapping(bytes32 => mapping(bytes32 => bytes32)) _sortHeads;
    // sortInfoUID → parentAnchor → head UID
mapping(bytes32 => mapping(bytes32 => bytes32)) _sortTails;
mapping(bytes32 => mapping(bytes32 => uint256)) _sortLengths;
mapping(bytes32 => mapping(bytes32 => uint256)) _lastProcessedIndex;
```

The sentinel is `bytes32(0)`. Head nodes have `prev == 0`, tail nodes have `next == 0`.

---

## SORT_INFO Schema

```
"address sortFunc, bytes32 targetSchema, uint8 sourceType"
```

- **sortFunc** — address of an `ISortFunc` implementation
- **targetSchema** — for `sourceType == 1`, restricts to children of this schema; `bytes32(0)` means all
- **sourceType** — which kernel array is the source list:
  - `0` = `_children[parentAnchor]` (all children)
  - `1` = `_childrenBySchema[parentAnchor][targetSchema]` (schema-filtered children)
  - `2+` = reserved; reverts `UnsupportedSourceType()`

The SORT_INFO attestation's `refUID` points to a **naming anchor** — an ANCHOR attestation whose name is the human-readable sort label (e.g., "ByName", "ByDate"). Naming anchors are the stable schelling points that users share; the SORT_INFO is the per-attester implementation detail.

---

## Sort Identity: Naming Anchors and SORT_INFO

Sort concepts use the same **editions model** as file content:

- **Naming anchor** = the sort concept (stable, permanent, shared reference point)
- **SORT_INFO attestation** = a per-attester implementation
- **Editions resolution** = first matching SORT_INFO from the editions hierarchy wins

This mirrors how DATA attestations work on file anchors: the anchor is the concept, DATA is the per-attester content.

A naming anchor becomes a sort concept anchor by having `anchorSchema = SORT_INFO_SCHEMA_UID` in its ANCHOR data. This lets `getAnchorsBySchema(parentAnchor, SORT_INFO_SCHEMA_UID, ...)` discover all sort concepts for a given parent.

---

## Sort Discovery

For a given parent anchor, available sort concepts are discovered in two layers:

1. **Local** — naming anchors that are direct children of `parentAnchor` with `anchorSchema == SORT_INFO_SCHEMA_UID`
2. **Global** — naming anchors under `/sorts/` (accessible via `indexer.sortsAnchorUID`) with the same schema

Local names override global names (same-name match wins).

For each naming anchor, the best SORT_INFO implementation is resolved via the editions hierarchy:

```
editions = [user, trusted_friend, system_deployer]
For each editions address:
  getReferencingBySchemaAndAttester(namingAnchorUID, SORT_INFO_SCHEMA_UID, attester)
  → first non-revoked result wins
```

---

## processItems

```solidity
function processItems(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    uint256 expectedStartIndex,
    bytes32[] calldata items,
    bytes32[] calldata leftHints,
    bytes32[] calldata rightHints
) external
```

**Concurrency safety:**
- `currentIndex >= expectedStartIndex + items.length` → **silent no-op** — the entire batch was already processed by another caller; the tx succeeds without state change. This allows front-run callers to complete without error.
- `currentIndex != expectedStartIndex` → **revert `StaleStartIndex`** — partial overlap; caller must refresh `getLastProcessedIndex` and resubmit.
- Otherwise → proceed normally.

**Per-item flow:**
1. Validate `items[i] == kernelArray[parentAnchor][currentIndex]` via `getChildAt` or `getChildBySchemaAt` (per sourceType). Reverts `InvalidItem` on mismatch — callers cannot inject arbitrary UIDs.
2. Compute `sortKey = ISortFunc.getSortKey(items[i], sortInfoUID)`. If `sortKey.length == 0`, item is ineligible for this sort — skip insertion, advance index.
3. Validate hints: `isLessThan(left.key, item.key)` and `isLessThan(item.key, right.key)`. Reverts `InvalidPosition` on bad hints.
4. Insert into linked list between `left` and `right`.
5. Advance `_lastProcessedIndex[sortInfoUID][parentAnchor]`.

Revoked items are always inserted (consistent with kernel semantics). Read functions skip them by default (`showRevoked = false`).

---

## repositionItem

```solidity
function repositionItem(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    bytes32 itemUID,
    bytes32 newLeftHint,
    bytes32 newRightHint
) external
```

Moves an item to a new position in the sorted list. Used when a sort function's output for an item may change (e.g., mutable content). 

**Idempotency guard:** Before unlinking, checks whether the item already satisfies the sorted invariant at its current position (`prev.key ≤ item.key ≤ next.key`). If so, reverts `UnnecessaryReposition()` to prevent griefing via no-op calls that waste gas.

---

## Reading

### getSortedChunk

```solidity
function getSortedChunk(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    bytes32 startNode,  // bytes32(0) = start from head
    uint256 limit,
    bool showRevoked
) external view returns (bytes32[] memory items, bytes32 nextCursor)
```

Returns `nextCursor = bytes32(0)` when the end of the list is reached.

### getSortedChunkByAddressList

```solidity
function getSortedChunkByAddressList(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    bytes32 startNode,
    uint256 limit,
    uint256 maxTraversal,  // 0 = DEFAULT_MAX_TRAVERSAL (10,000)
    address[] calldata attesters,
    bool showRevoked
) external view returns (bytes32[] memory items, bytes32 nextCursor)
```

Walks the shared sorted list and includes only items where `containsAttestations(itemUID, attester)` is true for at least one attester in the list.

`maxTraversal` bounds the number of nodes walked per call to prevent RPC timeout on sparse filtered lists. If the traversal limit is hit before collecting `limit` items, returns partial results with a non-zero cursor. Client keeps calling until cursor is `bytes32(0)`. 

**Default (`DEFAULT_MAX_TRAVERSAL = 10_000`)** is calibrated for typical RPC gas limits (~50M gas on mainnet). L2s may tolerate higher values. Configure a safe default in the frontend and expose as a tunable constant.

---

## Staleness

```solidity
function getSortStaleness(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (uint256)
```

Returns `kernelCount - lastProcessedIndex`. `kernelCount` is determined by the sourceType:
- `0` → `indexer.getChildrenCount(parentAnchor)`
- `1` → `indexer.getChildCountBySchema(parentAnchor, targetSchema)`

A staleness of 0 means the sorted list is fully up-to-date.

---

## Hint Computation

### On-chain (small lists, free eth_call)

```solidity
function computeHints(
    bytes32 sortInfoUID,
    bytes32 parentAnchor,
    bytes32[] calldata newItems
) external view returns (bytes32[] memory leftHints, bytes32[] memory rightHints)
```

Binary search over the current linked list. O(N × log N) gas. Use for lists < ~1000 items.

### Client-side (large lists, primary path)

For large lists, clients fetch sort keys via multicall (`ISortFunc.getSortKey(uid, sortInfoUID)` for each item), sort locally, and map positions to hints using a binary search utility in `packages/nextjs/utils/efs/sortHints.ts`.

**Hex comparison note:** Sort keys arrive as hex strings (`"0x1a2b..."`). For numeric keys (timestamps), sort functions MUST left-pad to fixed 32 bytes (`abi.encodePacked(uint256)`) so that lexicographic JS string comparison matches on-chain byte-by-byte evaluation. NameSort already produces variable-length bytes where lexicographic comparison is correct.

---

## ISortFunc Interface

```solidity
interface ISortFunc {
    function getSortKey(bytes32 uid, bytes32 sortInfoUID) external view returns (bytes memory);
    function isLessThan(bytes32 uidA, bytes32 uidB, bytes32 sortInfoUID) external view returns (bool);
}
```

### Deterministic Tie-Breaking

All ISortFunc implementations MUST append `uid` to the sort key to ensure globally unique keys. Without tie-breaking, two items with equal sort keys would have ambiguous relative order between the on-chain list and JS client computation.

```solidity
// TimestampSort: fixed 64-byte key (left-padded timestamp + uid)
return abi.encodePacked(uint256(att.time), uid);

// NameSort: variable-length key (anchor name bytes + uid)
return abi.encodePacked(bytes(name), uid);
```

### Reference Implementations

- **`NameSort`** — ASCII byte-by-byte comparison of anchor names; appends uid for tie-breaking
- **`TimestampSort`** — EAS attestation timestamp ordering (oldest first); appends uid for tie-breaking

---

## /sorts/ System Anchor

`indexer.sortsAnchorUID` points to a well-known ANCHOR under the root, named "sorts". It is the registry for universal sort concepts available across all anchors.

System sorts ("ByName", "ByDate") are seeded during deployment:
1. Create naming anchor "ByName" under `/sorts/` with `anchorSchema = SORT_INFO_SCHEMA_UID`
2. Attest SORT_INFO referencing "ByName": `{ sortFunc: NameSort, targetSchema: bytes32(0), sourceType: 0 }`
3. Same for "ByDate" → TimestampSort

The deployer address is the attester for system sorts. The UI identifies system sorts by checking the attester against the known deployer/system address.

---

## showRevoked Consistency

EFSSortOverlay aligns with EFSIndexer kernel semantics:

- Items are always **inserted** into sorted lists (including revoked items — tracks kernel state faithfully)
- **Read functions** skip revoked by default (`showRevoked = false`)
- Pass `showRevoked = true` to include revoked items (e.g., history views)
- Ineligible items (empty sort key) are never inserted

---

## Griefing Resistance

- **Fabricated UIDs** rejected — `processItems` validates each item against the kernel via `getChildAt`; arbitrary UIDs cannot be injected
- **Edition filtering** — `getSortedChunkByAddressList` ensures readers only see items from trusted attesters
- **Name squatting** — naming anchors are not the SORT_INFO; any attester can create a competing SORT_INFO on the same naming anchor, and editions resolution picks the trusted one
- **No-op repositionItem** — `UnnecessaryReposition()` prevents griefing via no-op calls
- **Sort/anchor mismatch** — callers can sort any anchor's children with any sort (wrong combos waste the caller's own gas, no harm to others)

---

## Hierarchical Resolution Order (V1)

```
1. User's own SORT_INFO (self-sovereign)
2. Editions/trusted addresses (curated by user)
3. EFS system defaults (deployer-attested ByName, ByDate)
```

Future layers (OS maintainer, public coordinated, web-of-trust) slot into this hierarchy without breaking existing clients.

---

## Gas Economics

- `processItems` is O(N) in batch size × O(log N) per insertion (binary search hint validation)
- Anyone can call `processItems` for any `(sortInfoUID, parentAnchor)` — gas is socialised
- `computeHints` is a free `eth_call` view — no gas cost for hint computation
- `getSortedChunk` and `getSortedChunkByAddressList` are view functions — no gas cost for reads
- Sorted list storage: 2 × 32-byte slots per item (prev + next pointers)
