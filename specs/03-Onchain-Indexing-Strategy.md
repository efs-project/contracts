# Onchain Indexing Strategy

EFS is designed to work fully onchain without offchain centralized dependencies, which requires key data lookups to be highly efficient. Because EFS uses intermediary naming schemas (Anchors as seen in [Data Models and Schemas](./02-Data-Models-and-Schemas.md)), this presents a unique indexing challenge for smart contracts and the frontend client.

For practical queries utilizing this index, see [Core Workflows](./04-Core-Workflows.md).

## The Multi-Level Attestation Challenge
In EFS, file identity is decoupled from file location. A DATA attestation is standalone (`refUID = 0x0`) and placed at paths via TAG attestations. The logical flow is:

```
Folder (Anchor) → File Name (child Anchor) ←── TAG(definition=Anchor, refUID=DATA) ←── DATA (standalone)
                                                                                        ├── PROPERTY (contentType)
                                                                                        └── MIRROR (retrieval URI)
```

Because Ethereum cannot natively query "all DATAs placed at this Anchor by this attester" without an index, EFS uses two coordinated contracts:
- **EFSIndexer** — indexes Anchors (directory tree), PROPERTYs, and MIRRORs via resolver hooks
- **TagResolver** — indexes TAG-based file placement via its `_activeByAAS` compact index

## Contract Indexing Approach
To make fast directory browsing possible, two resolver contracts maintain complementary indices:

**EFSIndexer** (resolver for ANCHOR, DATA, PROPERTY schemas):
1. When an Anchor is created, EAS calls `onAttest` → the indexer records parent–child relationships, name lookups, and schema-filtered child lists.
2. When a standalone DATA is created (`refUID = 0x0`), the indexer records content-addressed deduplication via `dataByContentKey[contentHash]`.
3. When a PROPERTY or MIRROR references a DATA, the indexer records it in referencing indices.

**TagResolver** (resolver for TAG schema):
1. When a TAG with `applies=true` places a DATA at an Anchor, the TagResolver adds the DATA UID to `_activeByAAS[definition][attester][schema]` — a compact, swap-and-pop array enabling efficient folder listing.
2. When a TAG with `applies=false` removes a placement, the TagResolver swap-and-pops the DATA UID out of the array.
3. The TagResolver also calls `indexer.propagateContains(definition, attester)` to flag the Anchor's ancestors in the tree, enabling "has content" checks for tree rendering.

This allows a client to query `getActiveTargetsByAttesterAndSchema(anchorUID, attester, DATA_SCHEMA_UID, start, length)` to get a compact, active-only list of DATAs at any path.

### Gas Limits, Spam, and Append-Only Storage
Because EAS is permissionless, anyone can attest files to a folder. To prevent Out-Of-Gas (OOG) errors:
- **Read Pagination**: All indexer read functions accept `start` and `length` parameters for cursor-based pagination through large directories.
- **Append-Only Kernel**: EFSIndexer is the append-only kernel. Arrays are never modified after a write. When an attestation is revoked, `onRevoke` sets `_isRevoked[uid] = true` but leaves all arrays intact. This eliminates O(N) removal overhead and makes the storage model simpler and cheaper to write (deploy gas: ~2.35M vs ~3.8M for the old swap-and-pop design; revoke gas: ~90k vs ~200k).
- **`showRevoked` filtering**: Every read function accepts a `bool showRevoked` parameter. When `false` (the default), the function scans forward and skips revoked UIDs, returning only active items. When `true`, revoked items are included — useful for history views and admin tooling.

### Kernel Events (Off-Chain Indexing)
EFSIndexer emits structured events from its native schema resolver hooks, enabling efficient off-chain indexing without scanning all EAS `Attested` events:

```solidity
event AnchorCreated(bytes32 indexed parentUID, bytes32 indexed anchorUID, address indexed attester, bytes32 anchorSchema);
event DataCreated(bytes32 indexed dataUID, address indexed attester, bytes32 contentHash);
event MirrorCreated(bytes32 indexed dataUID, bytes32 indexed mirrorUID, address indexed attester);
event PropertyCreated(bytes32 indexed anchorUID, bytes32 indexed propertyUID, address indexed attester);
event AttestationRevoked(bytes32 indexed uid, address indexed attester);
```

All events are indexed on the most useful lookup fields. `DataCreated` includes `contentHash` for off-chain dedup tracking. `MirrorCreated` links mirrors to their parent DATA. A Graph subgraph subscribing to these events can reconstruct full directory state without any additional contract reads during sync.

`EFSSortOverlay` emits `ItemSorted(sortInfoUID, attester, itemUID, leftNeighbour, rightNeighbour)` for each item inserted into a sorted list — enabling The Graph to reconstruct sorted order off-chain.

### Single-Element Kernel Access
`getChildrenByAttesterAt(parentUID, attester, idx)` exposes direct index-based access into the `_childrenByAttester` array. Used internally by `EFSSortOverlay.processItems` to validate submitted items against the kernel — callers cannot inject arbitrary UIDs into their sorted view.

## Editions (Address-Based Namespaces)
To support subjective file resolution natively onchain, two coordinated index systems work together:

### EFSIndexer: Directory Structure
- **Core Referencing History**: `_allReferencing` and `_referencingByAttester` track immutable history, ensuring revocations do not break the chain of edits.
- **Deduplicated Directory Listings**: `getChildrenByAddressList` walks the global `_children` array (unique, insertion order) and includes only items where any of the provided attesters has contributed — no duplicates possible. Pass the returned cursor to get the next page.
- **Schema + Attester Filtered Listings**: `getAnchorsBySchemaAndAddressList(parentUID, anchorSchema, attesters, startCursor, pageSize, reverseOrder, showRevoked)` intersects `_childrenBySchema[anchorSchema]` with `_containsAttestations` per attester. Use this when the caller wants a specific anchor type (e.g. `DATA_SCHEMA_UID` for file anchors, `SORT_INFO_SCHEMA_UID` for sort anchors) from a multi-attester directory without interleaving unrelated anchor types.
- **Content-Addressed Dedup**: `dataByContentKey[contentHash]` maps content hashes to the first (canonical) DATA UID.

### TagResolver: File Placement (Compact Index)
- **`_activeByAAS[definition][attester][schema]`**: The primary index for folder listing. A compact, swap-and-pop array of target UIDs per (definition Anchor, attester, target schema). When `applies=true`, the target is pushed; when `applies=false`, it's swap-and-popped out. This gives O(1) add/remove and contiguous reads — no revoked-item scanning needed.
- **`_activeByAASIndex[definition][attester][schema][target]`**: Position+1 index for O(1) swap-and-pop removal (0 = absent).
- **Queried via**: `getActiveTargetsByAttesterAndSchema(definition, attester, schema, start, length)` and `getActiveTargetsByAttesterAndSchemaCount(definition, attester, schema)`.

**Folder listing pattern**:
```
For each attester in editions:
  files = tagResolver.getActiveTargetsByAttesterAndSchema(anchorUID, attester, DATA_SCHEMA_UID, 0, pageSize)
  subfolders = tagResolver.getActiveTargetsByAttesterAndSchema(anchorUID, attester, ANCHOR_SCHEMA_UID, 0, pageSize)
```

### `propagateContains` (Tree Visibility)
When a TAG with `applies=true` places a DATA at a structural Anchor, the TagResolver calls `indexer.propagateContains(definition, attester)`. This walks up the `_parents` chain from the definition Anchor, setting `_containsAttestations[ancestor][attester] = true` at each level. Early-exit on already-flagged ancestors makes repeated contributions amortized O(1). This enables the sidebar tree to show which folders contain content from a given attester without scanning their children.

`MAX_ANCHOR_DEPTH = 32` caps the upward walk to prevent gas griefing via deeply nested Anchor chains.

### `_childrenByAttester` and `_containsAttestations` Propagation Behaviour
`_containsAttestations[anchorUID][attester]` is flagged when an attester contributes content under that anchor. Two paths trigger propagation:

1. **Anchor creation**: When an attester creates an Anchor under a parent, the indexer walks up `_parents` flagging `_containsAttestations` and pushing to `_childrenByAttester` at each ancestor.
2. **TAG-based file placement**: When the TagResolver processes a TAG with `applies=true` where the definition is a structural Anchor, it calls `indexer.propagateContains(definition, attester)` which performs the same upward walk.

In practice this means:
- Alice creates `apple.mp3` (Anchor) under `/music/`. `_childrenByAttester[musicUID][alice]` gets `apple.mp3`. Direct anchor creation.
- Bob tags a DATA into Alice’s `apple.mp3` Anchor. TagResolver calls `propagateContains(apple.mp3, bob)` → `_containsAttestations[musicUID][bob]` is set and `apple.mp3` is pushed to `_childrenByAttester[musicUID][bob]`.

**UI implication**: `getChildrenByAddressList(musicUID, [alice, bob])` walks the global `_children` array and O(1)-checks `_containsAttestations`. Both alice’s and bob’s contributions appear without duplicates.

## Efficient Client Traversal
When a web client needs to load a directory:
1. It queries the Indexer contract for the list of names (Anchors) inside the target Folder.
2. For each name returned, the client receives the associated resolved state (the newest/most valid Data or Property attestation).
3. Under the hood, this requires indexing based on the *schema type* and the *attester's address*, as the active state of a directory is a subjective compilation based on a specific user's web of trust or explicit edition request.

## Tag Indexing via EFSTagResolver
Tag attestations are handled by a dedicated `EFSTagResolver` contract (separate from the `EFSIndexer`). The Tag schema is registered in EAS with the `EFSTagResolver` as its resolver.

### Singleton Tagging Pattern
The `EFSTagResolver` enforces that only one active tag exists per `(attester, target, definition)` triple. It maintains an internal mapping:
```
mapping(bytes32 compositeHash => bytes32 activeUID) _activeTag
```
where `compositeHash = keccak256(abi.encodePacked(attester, targetID, definition))`.

When a user applies a tag that matches an existing combination, the resolver overwrites the mapping pointer to the new attestation UID. The old attestation remains on-chain but is logically superseded. This "logical superseding" approach avoids reentrancy issues that would arise from calling `eas.revoke()` inside a resolver hook (EAS requires `msg.sender == attester` for revocation, which the resolver cannot satisfy).

### Tag Definition Storage
Tag definitions are stored as normal Anchors under a reserved `/tags/` folder in the filesystem tree. This folder is created at deploy time as a child of the root Anchor. The UI hides `/tags/` from directory listings and the sidebar tree, but the definitions are discoverable via `resolvePath(tagsAnchorUID, "tagName")`. This approach keeps all anchors uniform (no special schema markers) while giving tags a dedicated namespace.

### Discovery Indices
The resolver maintains append-only discovery indices:
- **Definitions by Target**: Which tag definitions have ever been applied to a given target (`_tagDefinitions[targetID]`).
- **Targets by Definition**: Which targets have ever been tagged with a given definition (`_taggedTargets[definition]`).

These indices only grow; revoked or negated tags are **not** removed from them. Consumers must cross-reference `getActiveTagUID` to determine whether a discovered entry is still active.

### EFSIndexer Integration
`TagResolver` is wired to EFSIndexer: `onAttest` calls `indexer.index(uid)` and `onRevoke` calls `indexer.indexRevocation(uid)`. This means TAG attestations are fully registered in EFSIndexer's generic discovery indices alongside all other schemas:

```
indexer.getReferencingAttestations(targetUID, TAG_SCHEMA_UID, 0, 100, false)
  → all TAG attestations targeting a given anchor or address

indexer.getOutgoingAttestations(attester, TAG_SCHEMA_UID, 0, 100, false)
  → all TAG attestations made by a specific user
```

**Schema-aware queries are the correct pattern**: Because tags now share the EFSIndexer discovery layer with other schemas, callers must specify `schemaUID` when they want schema-specific results. A call for file Anchors in a directory should pass `DATA_SCHEMA_UID`; a call for tags on a target should pass `TAG_SCHEMA_UID`. Mixing schemas in a single query is intentional only when building a generic history view.

### On-Chain Query Functions
- `getActiveTagUID(attester, targetID, definition)` — Returns the active tag attestation UID for a specific triple. Returns zero if no active tag exists (never set, revoked, or the active attestation was for a different triple).
- `isActivelyTagged(targetID, definition)` — Returns true if any attester has an active `applies=true` tag for this (target, definition) pair.
- `isActivelyTaggedByAny(targetID, definition, attesters[])` — Returns true if any of the given attesters has an active `applies=true` tag.
- `getTagDefinitionCount(targetID)` — Number of distinct definitions ever applied to a target.
- `getTagDefinitions(targetID, start, length)` — Paginated list of definitions applied to a target.
- `getTaggedTargetCount(definition)` — Number of distinct targets ever tagged with a definition.
- `getTaggedTargets(definition, start, length)` — Paginated list of targets tagged with a definition.
- **`getActiveTargetsByAttesterAndSchema(definition, attester, schema, start, length)`** — Paginated list of active target UIDs from the compact `_activeByAAS` index. **This is the primary folder listing query** — returns only currently-placed items, no revoked-item scanning needed.
- **`getActiveTargetsByAttesterAndSchemaCount(definition, attester, schema)`** — Count of active targets in the compact index.

### Edition-Aware Tag Filtering
When filtering a directory listing by tags, the client must account for editions. Tags target specific DATA UIDs, not the shared Anchor UID. The filtering algorithm is:

1. **Resolve the tag definition**: `resolvePath(tagsAnchorUID, tagName)` returns the definition Anchor UID. Tag definitions can be nested (e.g., `/tags/nsfw/orgy/`); the UI walks `refUID` up from a definition to check if it's a descendant of `/tags/`.
2. **Fetch tagged targets**: `getTaggedTargets(definitionUID, 0, count)` returns all DATA UIDs ever tagged with this definition.
3. **Build a DATA UID map for the directory**: For each file item, resolve its DATA UIDs via `getActiveTargetsByAttesterAndSchema(anchorUID, attester, DATA_SCHEMA_UID, 0, count)` for each attester in the editions list.
4. **Match**: If **any** of the file's DATA UIDs appears in the tagged targets set, the item matches the filter.

This ensures that tagging User A's edition of `test.txt` as "nsfw" does not cause User B's edition to appear when filtering by "nsfw".

### Edge Cases and Caveats
- **Append-only discovery**: `getTaggedTargets` returns UIDs that were ever tagged, including revoked ones. A strict filter should additionally verify each candidate via `getActiveTagUID` or by checking the `applies` field of the active attestation.
- **Updated DATA (new uploads)**: When a user uploads a new version, they TAG the new DATA at the path (`applies=true`) and TAG the old DATA (`applies=false`). Tags (labels like "nsfw") on the old DATA UID do not carry over to the new version. Users must re-tag after uploading a new version.
- **Cross-user tagging**: User B can tag User A's DATA UID. The tag is stored under `(userB, dataA_UID, definition)` and `dataA_UID` appears in `getTaggedTargets`. When viewing User A's edition, the filter matches regardless of who applied the tag.
- **Folder-level tags**: Tags on Anchor UIDs (folders) are checked directly against the anchor UID without DATA indirection.

### Off-Chain Indexer API Patterns
For a responsive web UI, off-chain indexers should expose these additional query patterns:
1. **Attestations by Tag and Schema**: `getAttestationsByTag(definitionUID, targetSchemaUID, applies, cursor)` — Paginated list of items with a specific tag, filtered by the target's schema type.
2. **Addresses by Tag**: `getAddressesByTag(definitionUID, applies, cursor)` — Paginated list of user addresses (from the `recipient` field) possessing a specific tag.
3. **Tags for Target**: `getTagsForTarget(targetID)` — All active tags applied to a specific file, folder, or address.
4. **Boolean State Check**: `checkIfTargetHasTag(targetID, definitionUID)` — Optimized boolean check for tag membership.

## Sort Overlay Indexing via EFSSortOverlay

The SORT_INFO schema is handled by `EFSSortOverlay`. It is registered in EAS with `EFSSortOverlay` as its resolver.

Sort overlays are **not populated in the resolver hook** — they are populated lazily off-hook by `processItems` calls. The resolver hook only validates and caches the sort config.

### Per-Attester Sorted Linked Lists

The `EFSSortOverlay` maintains a doubly linked list **per `(sortInfoUID, attester)` pair**:

```
_sortNodes[sortInfoUID][attester][itemUID]  → Node { prev, next }
_sortHeads[sortInfoUID][attester]           → head UID (bytes32(0) = empty)
_sortTails[sortInfoUID][attester]           → tail UID (bytes32(0) = empty)
_sortLengths[sortInfoUID][attester]         → item count
_lastProcessedIndex[sortInfoUID][attester]  → kernel items acknowledged
```

The kernel (EFSIndexer) remains the source of truth. The sort overlay is a secondary index providing a different ordering.

### Resolver Hook Behaviour

- **SORT_INFO `onAttest`**: Validates `refUID != bytes32(0)` (naming Anchor required) and `sortFunc != address(0)`. Caches `SortConfig { sortFunc, targetSchema, valid, revoked }`.
- **SORT_INFO `onRevoke`**: Sets `config.revoked = true`. `processItems` will revert for revoked sorts; `getSortStaleness` returns 0.

### On-Chain Query Functions

**Sorted pagination:**
- `getSortedChunk(sortInfoUID, attester, startNode, limit)` — Cursor-based pagination. `startNode = bytes32(0)` starts at head. Returns `(items[], nextCursor)`. Hard cap: `limit ≤ 100`.
- `getSortLength(sortInfoUID, attester)` — Sorted item count.
- `getSortHead(sortInfoUID, attester)` — First (smallest) item UID.
- `getSortTail(sortInfoUID, attester)` — Last (largest) item UID.
- `getSortNode(sortInfoUID, attester, itemUID)` — Raw `Node { prev, next }` for a specific item.

**Staleness and progress:**
- `getSortStaleness(sortInfoUID, attester)` — `kernelCount - lastProcessedIndex`. How many kernel items are unprocessed.
- `getLastProcessedIndex(sortInfoUID, attester)` — Physical kernel index to resume from.

**Sort config:**
- `getSortConfig(sortInfoUID)` — Cached `SortConfig { sortFunc, targetSchema, valid, revoked }`.

**Kernel discovery** (used by clients to find sorts under a directory):
- `EFSIndexer.getAnchorsBySchema(parentUID, SORT_INFO_SCHEMA_UID, 0, 100, false, false)` — returns all sort naming Anchor UIDs under a directory. Sort naming Anchors are regular kernel children; no separate discovery index needed.
- `EFSIndexer.getReferencingAttestations(namingAnchorUID, SORT_INFO_SCHEMA_UID, 0, 10, false)` — returns SORT_INFO UIDs pointing at a naming anchor. Works because `EFSSortOverlay.onAttest` calls `indexer.index(attestation.uid)` after caching the sort config, registering every SORT_INFO attestation into EFSIndexer's generic referencing indices.

### Public Index API

EFSIndexer exposes a permissionless indexing API for any EAS attestation whose schema is resolved by a contract other than EFSIndexer:

- **`index(bytes32 uid) → bool wasIndexed`** — reads the attestation from EAS and runs the same global indexing logic as `onAttest` (schema, attester, sent, received, referencing, upward propagation). Idempotent — guarded by `mapping(bytes32 => bool) _indexed`. Returns `false` for EFS-native schemas (already indexed via `onAttest`) and for already-indexed UIDs. Emits `AttestationIndexed`.
- **`indexBatch(bytes32[] uids) → uint256 count`** — batch version; skips already-indexed and EFS-native UIDs without reverting. Returns count of newly indexed UIDs.
- **`indexRevocation(bytes32 uid)`** — mirrors a revocation from EAS into `_isRevoked`. Call after `eas.revoke()` to make `isRevoked()` return true for externally-resolved schemas. Requires the attestation to already be revoked in EAS. Idempotent. Emits `RevocationIndexed`.
- **`isIndexed(bytes32 uid) → bool`** — returns true if a UID was indexed via the public API (not via `onAttest`).

**How partner resolvers use this:**
```
// EFSSortOverlay
onAttest → indexer.index(attestation.uid)           // makes SORT_INFO discoverable
onRevoke → indexer.indexRevocation(attestation.uid) // syncs revocation state

// TagResolver
onAttest → indexer.index(attestation.uid)           // makes TAG attestations discoverable
onRevoke → indexer.indexRevocation(attestation.uid) // syncs revocation state

// MirrorResolver
onAttest → indexer.index(attestation.uid)           // makes MIRROR discoverable via getReferencingAttestations
onRevoke → indexer.indexRevocation(attestation.uid) // syncs revocation state
```

**Third-party developer usage:**
```
// After attesting with your own resolver:
indexer.index(myAttestationUID);
// Now discoverable via:
indexer.getReferencingAttestations(refUID, mySchemaUID, ...)
indexer.getAttestationsBySchema(mySchemaUID, ...)
indexer.getOutgoingAttestations(attester, mySchemaUID, ...)
```

See [Lists and Collections](./06-Lists-and-Collections.md) for the full architecture.
