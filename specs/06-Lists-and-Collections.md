# Lists and Collections

EFS supports dynamic, user-orderable lists — social graphs, curated media collections, strictly ordered directories — that scale to 1,000,000+ items. The architecture uses the **Editions model** (see [System Architecture](./01-System-Architecture.md)): each attester maintains their own independent ordered list for a given collection, and the SPA decides whose list to display or how to merge multiple lists client-side.

Lists use two new EAS schemas — LIST_INFO and LIST_ITEM — managed by the `EFSListManager` contract. For the full schema definitions see [Data Models and Schemas](./02-Data-Models-and-Schemas.md#5-list-info-schema) and for indexing details see [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md#list-indexing-via-efslistmanager).

---

## 1. List Data Model

### Vertical Reverse-Pointer Architecture

Lists decouple the root configuration from the items it contains, following EFP (Ethereum Follow Protocol) principles:

- **LIST_INFO** — A single master attestation defining the list's identity and rules. Its `refUID` points to a named EFS Anchor — exactly as DATA attestations do. The Anchor is the shared naming Schelling point. Multiple users can each create their own LIST_INFO under the same Anchor, giving each user their own edition of the list. A LIST_INFO with no Anchor (`refUID = bytes32(0)`) is valid but not discoverable via path.
- **LIST_ITEM** — One attestation per item. Each item's `refUID` points **up** to the parent LIST_INFO. This means adding or deleting items never touches the parent LIST_INFO state.

This reverse-pointer design means the LIST_INFO can be traded, delegated to a DAO, or updated without modifying the underlying dataset.

**Example — `/memes/top3`**: The "top3" Anchor lives under the `/memes/` folder. Alice creates a LIST_INFO with `refUID = top3AnchorUID`. Bob creates a separate LIST_INFO also with `refUID = top3AnchorUID`. Both lists exist under the same Anchor. The SPA calls `getListsByAnchor(top3AnchorUID)` to enumerate them and shows Alice's and Bob's editions side-by-side.

### Address-Based Lists (EFP Integration)

When listing Ethereum addresses (e.g. a social graph of followed users), set `itemUID = bytes32(0)` and put the target address in the EAS `recipient` field. The schema check on `targetSchemaUID` is automatically bypassed for zero itemUIDs, preserving EFP semantics natively.

---

## 2. On-Chain Doubly Linked List

### Why Linked Lists, Not Arrays

Simple arrays suffer O(N) gas costs for mid-list insertions. Fractional indices are O(1) to write but require O(N) reads to sort at the EVM level (impossible at scale — 1M items would exhaust block gas limits and RPC payload limits before returning a sorted page).

The doubly linked mapping provides:
- **O(1) append** to any list (regardless of length)
- **O(1) removal** via pointer surgery on prev/next neighbours
- **O(1) per-item reads** — cursor-based pagination traverses exactly one SLOAD per item

### Node Structure

```solidity
struct Node {
    bytes32 prev;  // previous LIST_ITEM attestation UID (bytes32(0) = head)
    bytes32 next;  // next LIST_ITEM attestation UID (bytes32(0) = tail)
}
```

The key in the `_listNodes` mapping is the LIST_ITEM attestation UID itself (no redundant `itemUID` field in the node). The actual item data is decoded from the attestation on read.

### Per-Attester Lists (Editions)

The linked list is keyed by `(listInfoUID, attester)`:

```
_listNodes[listInfoUID][attester][itemAttUID] → Node
_listHeads[listInfoUID][attester]             → first UID
_listTails[listInfoUID][attester]             → last UID
_listLengths[listInfoUID][attester]           → count
```

This is the same pattern as `_childrenByAttester` in `EFSIndexer` — each user maintains their own independent ordered list for a given LIST_INFO. The base list (e.g. the list owner's own items) is queried by passing the LIST_INFO attester's address to `getSortedChunk`.

### Gas Cost

| Operation | EVM Operations | Estimated Gas |
|-----------|---------------|---------------|
| Append to list | 3× SSTORE (new node) + 1× SSTORE (old tail.next) + 1× SSTORE (tail pointer) | ~100–130k gas |
| Remove from list | 2–4× SSTORE (bridge neighbours) + 1× SSTORE (length) + 1× delete | ~60–80k gas |
| Read page of N items | N× SLOAD | ~2,100 × N gas |

On L2/L3 rollups (Base, Arbitrum), these costs are negligible. Gas cost is constant regardless of list size — a 1M-item list has the same insert cost as a 10-item list.

---

## 3. Cursor-Based Pagination (`getSortedChunk`)

```solidity
function getSortedChunk(
    bytes32 listInfoUID,
    address attester,
    bytes32 startNode,  // bytes32(0) = start at head; otherwise start FROM this UID (inclusive)
    uint256 limit       // max items per page; capped at MAX_PAGE_SIZE (100)
) external view returns (bytes32[] memory items, bytes32 nextCursor)
```

- `startNode = bytes32(0)` → begin at the list head
- `startNode = someUID` → begin FROM that node (inclusive — it IS the first item of this page)
- `nextCursor` = the UID of the first item for the following page; `bytes32(0)` = end of list

**Pagination loop:**
```
page 1: getSortedChunk(listUID, addr, 0x0,        10) → items[0..9],  cursor = items[10]
page 2: getSortedChunk(listUID, addr, items[10],  10) → items[10..19], cursor = items[20]
page 3: getSortedChunk(listUID, addr, items[20],  10) → items[20..N],  cursor = 0x0 (done)
```

**Cycle protection:** The `limit` parameter is the circuit breaker. Even if pointers were somehow corrupted, the while loop terminates after `limit` steps. External actors cannot corrupt another attester's pointers — each attester's list is only modified by the resolver hooks when that attester's own attestations are processed.

**Revoked lists:** If the LIST_INFO attestation is revoked, `getSortedChunk` returns an empty array. Items remain on-chain but are treated as orphaned.

### Consistent Snapshot Querying

For multi-page sessions, always pin the `blockNumber` parameter in `eth_call` to the same finalized block across all page requests. This prevents "shifting state" anomalies where items inserted or deleted between page requests could cause the cursor to skip or repeat items.

---

## 4. Client-Side Fractional Index Ordering

The on-chain linked list maintains **insertion/append order** as the base (chronological) state. For user-defined manual ordering, fractional indices are stored in LIST_ITEM attestation data as a `string` field and sorted **client-side only**.

**Why client-side?**
- On-chain string comparisons are expensive and sorting 10 results requires 10 comparisons at ~10k gas each
- Finding the correct insertion position in a sorted linked list requires O(N) traversal
- Fractional indices are a client UX concern, not a protocol-level constraint

**Fractional index format:** Base-62 lexicographical strings (e.g. `"a0"`, `"a0V"`, `"a1"`). A deterministic salt (the attester's Ethereum address appended as `"a0V-0xAbcd..."`) prevents ordering collisions during concurrent inserts.

**Concurrency:** If two users simultaneously insert at the same position, their fractional strings will be distinct due to the address salt. The resulting interleaving (e.g. `[B1, A1, B2, A2]` instead of `[A1, A2, B1, B2]`) is a cosmetic issue for subjective lists, not a data integrity problem. CRDTs (LSEQ, RGA) are explicitly out of scope for EFS — the address-salt fractional approach is sufficient.

---

## 5. The Four-Tier Subjective Resolution Engine

EFS is permissionless — anyone can attest LIST_ITEM entries to any LIST_INFO. The SPA protects users by merging data through a cascading priority hierarchy before rendering.

### Tier 1 — Local Overrides (Cryptographic Self-Attestation)

Attestations signed by the **viewing user** take absolute precedence. If the user has added items, those appear first. If the user has issued a "tombstone" (`fileMode = "tombstone"` Data attestation targeting a specific `itemUID`), that item is removed from their view regardless of base state.

### Tier 2 — Trusted Circle (Web of Trust)

If no local override exists, the SPA aggregates overrides from addresses the user explicitly follows (via EFP social graph data). A trusted auditor's tombstone removes an item from the viewer's feed.

### Tier 3 — Maintainer Overlays (Curated Defaults)

Fallback to overlay states from recognised DAOs or protocol deployers. Ensures clean default state for new users without an established Web of Trust.

### Tier 4 — Global Consensus (Averaged State)

The foundational list state as defined by the original list owner, with items statistically filtered using aggregated tag weights (upvotes/downvotes). To resist Sybil manipulation of Tier 4, the SPA cross-references attesters against decentralised identity primitives (Gitcoin Passport, EAS Proof of Humanity, EFP identity weights). Votes from unverified addresses are discounted or ignored.

### SPA Execution Algorithm

1. **Fetch base chunk** — Call `getSortedChunk(listInfoUID, baseAttester, cursor, 10)` at a pinned block height.
2. **Fetch targeted overrides** — Extract the 10 item UIDs. Execute a targeted `eth_getLogs` (or multicall) querying only the connected user and their Web of Trust for attestations modifying those 10 specific UIDs. EVM bloom filters make this sub-millisecond.
3. **Execute local merge** — Apply tombstones (remove items), apply insertions (splice new items into the virtual DOM).
4. **Recursive fill** — If tombstones reduced the page to 8 items, request 2 more from `getSortedChunk`, evaluate them against overrides, and append until the quota is met.

**Progressive Local Caching (EIP-4444 resilience):** The SPA caches `eth_getLogs` results in IndexedDB, keyed by `(listInfoUID, blockRange)`. On subsequent loads, only the delta (blocks since last visit) is fetched from the RPC. For brand-new devices, historical logs are fetched in 10,000-block chunks with exponential backoff. This keeps the "No Central Indexer" constraint intact while surviving node history expiry.

---

## 6. listType Values

| Value | Name | On-Chain Order | Client Sort |
|-------|------|---------------|-------------|
| 0 | Manual | Insertion order (append) | `fractionalIndex` string ascending |
| 1 | Chronological | Insertion order (append) | No re-sort needed |

Values 2 (Red-Black Sorted) and 3 (Ranked) are reserved for future use. A self-balancing on-chain BST for O(log N) random access is deferred to v2 — the linked list + client-side sort satisfies all v1 requirements.

---

## 7. Hard Fork Threshold

If a user's Edition grows so heavily customised (tens of thousands of tombstones/overrides) that the SPA's RPC calls begin hitting timeout limits, the architecture provides an escape hatch:

**Deploy a new LIST_INFO**, pointing to the same EFS Anchor. This creates a fresh base list with no override burden. The old list remains on-chain for historical reference. This is the "hard fork" pattern described in the original design document.
