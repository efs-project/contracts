# EFS Custom Lists — Design Notes

## Sorts vs Curated Lists

EFS has two distinct ordering mechanisms:

| | Algorithmic Sort | Curated List |
|---|---|---|
| **Ordering** | Computed from item properties (name, timestamp) | Manually assigned by curator |
| **Storage** | Shared linked list keyed by (sortInfoUID, parentAnchor) | Per-attester positional anchors |
| **Gas model** | Public good — anyone can advance shared list | Per-curator — only list owner pays |
| **Mutability** | Re-sort possible via repositionItem (future ISortFunc) | Reorder by changing position anchors |
| **Identity** | Naming anchor + SORT_INFO attestation | A directory of positional anchors |

---

## Curated Lists via Positional Anchors

A curated list is a directory of child **positional anchors** named "a0", "a1", "a2", etc. Each position is itself an anchor — it can have per-attester DATA attestations, enabling editions at the position level.

```
/my-playlist/
  /a0/ ← positional anchor
    DATA(alice) = "ipfs://track-1"    ← alice's pick for position 0
    DATA(bob)   = "ipfs://track-1b"   ← bob's alternate pick
  /a1/ ← positional anchor
    DATA(alice) = "ipfs://track-2"
  /a2/ ← ...
  SORT_INFO(owner) → FractionalSort   ← marks this dir as a curated list
  PROPERTY(owner) key="defaultSort" value="<sortInfoUID>"
```

The positions themselves are ordered by FractionalSort, which assigns fractional sort keys. The curator can reorder by setting a new fractional key between existing positions.

### FractionalSort

FractionalSort is a planned ISortFunc implementation where the curator manually assigns sort keys. Unlike algorithmic sorts (shared public good), FractionalSort lists are inherently per-attester — the ordering is the curator's opinion, not a deterministic function of item properties.

ISortFunc could declare `isShared() external pure returns (bool)` to distinguish:
- `true` — algorithmic, deterministic, shared list is appropriate
- `false` — per-attester manual ordering; each attester maintains their own sorted list

This flag would inform EFSSortOverlay to store lists per-attester when `isShared() == false`, restoring the old per-attester storage model for manual lists only.

---

## "Onchain Mode" vs "Enhanced Mode" (The Graph)

**Onchain mode** — everything queried directly from contracts via RPC calls:
- Sort discovery: `getAnchorsBySchema` paginated calls
- Sort key computation: multicall over `ISortFunc.getSortKey`
- Sorted reads: `getSortedChunk` with cursor pagination
- Hint computation: on-chain `computeHints` for small lists, local for large
- Works with zero infrastructure beyond an RPC endpoint
- Suitable for <10k items per anchor before RPC limits become painful

**Enhanced mode** — The Graph subgraph indexes EFSIndexer events:
- Sort discovery: instant, no pagination needed
- Sort keys: pre-indexed and queryable
- Sorted reads: GraphQL queries return pre-sorted results
- Hint computation: trivial — sort keys already indexed
- Required for >100k items, real-time updates, search

The design intentionally keeps onchain mode viable for small-to-medium directories so EFS works without The Graph infrastructure. Enhanced mode is an upgrade, not a requirement.

---

## Universal /sorts/ as Sort Template Registry

`/sorts/` contains naming anchors for sort concepts that are meaningful across any anchor type:
- "ByName" — sort by anchor name (ASCII)
- "ByDate" — sort by attestation timestamp

Any anchor can use these global sorts without local setup. Local sort overrides (naming anchors that are direct children of a specific parent anchor) take precedence over global sorts of the same name.

Future additions to `/sorts/` could include:
- "ByRating" — sort by an average rating PROPERTY value
- "ByPopularity" — sort by referencing attestation count
- "ByCustom" — sort by a user-defined PROPERTY key

Each global sort is a naming anchor + SORT_INFO; different attesters can provide competing implementations (e.g., different address for the rating sortFunc). Editions resolution picks the trusted implementation.

---

## Anchor Sorts vs Data-Content Sorts

Current ISortFunc implementations sort **anchors** (by their anchor metadata):
- NameSort reads the anchor's `name` field
- TimestampSort reads the anchor's EAS attestation timestamp

Future sorts could operate on **content** (DATA attestations):
- Sort by content type (audio before video before text)
- Sort by file size
- Sort by content schema property

These would require ISortFunc to resolve the DATA attestation for an anchor, not just the anchor itself. The `sortInfoUID` parameter passed to `getSortKey` allows context-sensitive resolution (e.g., the sort could read a specific PROPERTY schema from the sortInfoUID to know which property to sort by).

---

## Web of Trust Integration

Sort discovery today uses a flat editions list (ordered address list). A more sophisticated trust model could weight sort implementations:
- Trust transitively through follows/vouches
- Score implementations by how many trusted users use them
- Surface "popular among people you trust" sorts

This integrates naturally with the naming anchor model: the naming anchor is the schelling point, the implementations compete, and the trust graph selects among them.

---

## Sort Upgrades

When a better ISortFunc is deployed for an existing sort concept:
1. Curator creates a new SORT_INFO attestation referencing the same naming anchor
2. Editions users who trusted the curator's address now get the new implementation
3. Old SORT_INFO can be revoked
4. The shared sorted list for the old sortInfoUID persists — readable, no longer updateable after revoke

This enables non-breaking upgrades: new implementations take over for new reads while old data stays accessible.

---

## Gas Sponsorship (Future)

`processItems` is the gas-heavy operation. For public directories, the system deployer or a protocol could sponsor processing via:
- EIP-4337 user operations (gas paid by a paymaster)
- Meta-transactions (relayer forwards calls, protocol pays)
- A processing bounty system (pay callers to advance stale sorts)

This is not required for v1 but the contract design accommodates it — `processItems` has no `msg.sender` restriction.

---

## Positional Anchor Editions: Advanced Use

Since each positional anchor in a curated list can have per-attester DATA, curated lists naturally support editions:

```
Alice's playlist edition:  /a0/ → DATA(alice)="track-A"
Bob's playlist edition:    /a0/ → DATA(bob)="track-B"
```

Viewers choose whose playlist edition to see. This enables:
- Collaborative playlists where each contributor proposes positions
- Forked playlists (bob takes alice's list and substitutes some tracks)
- Attested recommendations (sign that you endorse this ordering)

The `getDirectoryPageBySchemaAndAddressList` API already supports this read pattern — it returns positional anchors filtered by attester.
