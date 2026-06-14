# Onchain Indexing Strategy

EFS is designed to work fully onchain without offchain centralized dependencies, which requires key data lookups to be highly efficient. Because EFS uses intermediary naming schemas (Anchors as seen in [Data Models and Schemas](./02-Data-Models-and-Schemas.md)), this presents a unique indexing challenge for smart contracts and the frontend client.

For practical queries utilizing this index, see [Core Workflows](./04-Core-Workflows.md).

## The Multi-Level Attestation Challenge
In EFS, file identity is decoupled from file location. A DATA attestation is standalone (`refUID = 0x0`) and placed at paths via **edge attestations** (PIN for cardinality 1, TAG for cardinality N — ADR-0041). The logical flow:

```
Folder (Anchor) → File Name (child Anchor) ←── PIN(definition=Anchor, refUID=DATA) ←── DATA (standalone)
                                                                                        ├── PROPERTY (contentType)  ← bound via PIN
                                                                                        └── MIRROR (retrieval URI)
```

Because Ethereum cannot natively query "the active DATA placed at this Anchor by this attester" without an index, EFS uses two coordinated resolver contracts:
- **EFSIndexer** — indexes Anchors (directory tree), DATAs, PROPERTYs, and MIRRORs via resolver hooks
- **EdgeResolver** — indexes both PIN and TAG schemas (one shared contract per ADR-0041); maintains the per-slot active sets and the shared edge-discovery indices

## Contract Indexing Approach
To make fast directory browsing possible, two resolver contracts maintain complementary indices:

**EFSIndexer** (resolver for ANCHOR, DATA, PROPERTY schemas):
1. When an Anchor is created, EAS calls `onAttest` → the indexer records parent–child relationships, name lookups, and schema-filtered child lists.
2. When a standalone DATA is created (`refUID = 0x0`), the indexer records content-addressed deduplication via `dataByContentKey[contentHash]`.
3. When a PROPERTY or MIRROR references a DATA, the indexer records it in referencing indices.

**EdgeResolver** (resolver for PIN and TAG schemas — ADR-0041):
1. When a **PIN** is attested, EdgeResolver writes the active entry into `_activeBySlot[definition][attester][targetSchema]` (`SlotEntry { pinUID, targetID }`). A new PIN at the same slot but a different target supersedes the prior one in O(1) — the prior entry's `_activeEdge` row is cleared and counters are decremented.
2. When a **TAG** is attested, EdgeResolver appends the entry to `_activeByAAS[definition][attester][targetSchema]` as a `TagEntry { tagUID, weight }` and records its position in `_activeByAASIndex` for O(1) swap-and-pop. Re-attesting the same `(attester, target, definition)` edge updates the existing entry's UID and weight in place.
3. Both PIN and TAG calls into `indexer.propagateContains(definition, attester)` when the definition is a structural Anchor — this flags ancestors in the tree, enabling "has content" checks for tree rendering.
4. EdgeResolver maintains schema-blind discovery indices shared across PIN and TAG: `_edgeDefinitions[targetID]`, `_targetsByDef[definition]`, `_childrenWithEdge[parentUID][definition]`. Aggregate counters (`_activeCount[targetDefHash]`, `_activeTotalByDefAndAttester[def][attester]`) sum across both schemas naturally.

The bookkeeping is **schema-aware**: `_edgeHash(attester, targetID, definition, schema)` includes the schema UID, so a PIN and a TAG at the same `(attester, target, definition)` triple occupy independent slots in `_activeEdge` and cannot corrupt each other's state. Aggregate counts use a schema-blind `_targetDefHash(targetID, definition)` and compose correctly because each schema's `wasActive` check is isolated.

Smart-contract readers split by cardinality:

- **PIN** (Shape A — singular): `getActivePin(definition, attester, targetSchema) → bytes32 pinUID` and `getActivePinTarget(...) → bytes32 targetID`. O(1).
- **TAG** (Shape B — list): `getActiveTagEntries(definition, attester, schema, start, length) → TagEntry[]` for full `(uid, weight)` tuples in one bulk SLOAD; `getActiveTags(...)` drops weights when not needed; `getActiveTagWeight(attester, target, definition, targetSchema) → (exists, weight)` for the O(1) weight of one specific target's active TAG (ADR-0048).

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
event AttestationRevoked(bytes32 indexed uid, address indexed attester);  // native-schema revocations
event RevocationIndexed(bytes32 indexed uid);                              // externally-resolved schemas indexed via indexRevocation()
```

Subscribe to both revocation events. `AttestationRevoked` fires from the resolver hook on native schemas (ANCHOR, DATA, PROPERTY); `RevocationIndexed` fires when an external resolver calls `indexRevocation()` to surface a TAG/MIRROR/SORT_INFO revocation into the kernel.

All events are indexed on the most useful lookup fields. `DataCreated` includes `contentHash` for off-chain dedup tracking. `MirrorCreated` links mirrors to their parent DATA. A Graph subgraph subscribing to these events can reconstruct full directory state without any additional contract reads during sync.

`EFSSortOverlay` emits `ItemSorted(sortInfoUID, parentAnchor, itemUID, leftNeighbour, rightNeighbour)` for each item inserted into a sorted list — enabling The Graph to reconstruct sorted order off-chain.

### Single-Element Kernel Access
`getChildrenByAttesterAt(parentUID, attester, idx)` exposes direct index-based access into the `_childrenByAttester` array. Used internally by `EFSSortOverlay.processItems` to validate submitted items against the kernel — callers cannot inject arbitrary UIDs into their sorted view.

## Lenses (Address-Based Namespaces)
To support subjective file resolution natively onchain, two coordinated index systems work together:

### EFSIndexer: Directory Structure
- **Core Referencing History**: `_allReferencing` and `_referencingByAttester` track immutable history, ensuring revocations do not break the chain of edits.
- **Deduplicated Directory Listings**: `getChildrenByAddressList` walks the global `_children` array (unique, insertion order) and includes only items where any of the provided attesters has contributed — no duplicates possible. Pass the returned cursor to get the next page.
- **Schema + Attester Filtered Listings**: `getAnchorsBySchemaAndAddressList(parentUID, anchorSchema, attesters, startCursor, pageSize, reverseOrder, showRevoked)` intersects `_childrenBySchema[anchorSchema]` with `_containsAttestations` per attester. Use this when the caller wants a specific anchor type (e.g. `DATA_SCHEMA_UID` for file anchors, `SORT_INFO_SCHEMA_UID` for sort anchors) from a multi-attester directory without interleaving unrelated anchor types.
- **Content-Addressed Dedup**: `dataByContentKey[contentHash]` maps content hashes to the first (canonical) DATA UID.

### EdgeResolver: PIN and TAG storage (per-cardinality indices)

**PIN — `_activeBySlot[definition][attester][targetSchema]` (`SlotEntry { pinUID, targetID }`)**: Single-slot storage. **The `definition` is the Anchor where content is placed — for a file like `/memes/cat.jpg`, the definition is `cat.jpg`'s Anchor, NOT the `/memes/` Anchor.** A new PIN at the same slot supersedes the prior one in O(1). Revoke clears the slot iff the held `pinUID` matches.

- **Queried via**: `getActivePin(definition, attester, targetSchema)`, `getActivePinTarget(definition, attester, targetSchema)`, `getActivePinSlot(definition, attester, targetSchema)`.

**TAG — `_activeByAAS[definition][attester][schema]` (`TagEntry[] { tagUID, weight }`)**: Compact append-and-swap-and-pop list of active edges per slot. Each entry is a struct of `(tagUID, weight)` so on-chain consumers can read the full list with weights in one bulk SLOAD per slot — avoiding the N+1 SLOAD pattern that would arise if weight lived in a side mapping. Re-attesting the same `(attester, target, definition)` edge updates the existing entry's UID and weight in place. Revoke swap-and-pops the entry.

- **`_activeByAASIndex[definition][attester][schema][edgeHash]`**: Position+1 index for O(1) swap-and-pop removal (0 = absent). `edgeHash` is the schema-aware `keccak256(attester, targetID, definition, TAG_SCHEMA_UID)` so PIN re-attestations cannot collide with TAG entries.
- **Queried via**: `getActiveTagEntries(definition, attester, schema, start, length)` for `(uid, weight)` tuples; `getActiveTags(...)` for UID-only convenience; `getActiveTagsCount(...)` for length.

**Do not use raw `_activeByAAS` queries for folder listing.** The index is keyed per file anchor, not per folder. Listing the files inside `/memes/` requires iterating the folder's child anchors. Use `EFSFileView` (next section) — it handles the iteration, pagination, lens merge, and revocation filtering for you.

### EFSFileView: High-level directory views
EFSFileView is the read-side wrapper most client code should call rather than composing EFSIndexer + EdgeResolver queries by hand. Four variants:

- `getDirectoryPage(parent, start, length, dataSchemaUID, propertySchemaUID)` — all children, insertion order.
- `getDirectoryPageByAddressList(parent, attesters, startingCursor, pageSize)` — attester-filtered directory listing.
- `getDirectoryPageBySchemaAndAddressList(parent, anchorSchema, attesters, startingCursor, pageSize)` — schema + attester filtered (e.g. file anchors only).
- `getDirectoryPageFiltered(parent, anchorSchema, attesters, excludeTagDefs[], minWeights[], cursor, maxItems)` — as above, but skips any item a lens has tagged with ANY `excludeTagDefs[k]` at `weight >= minWeights[k]` (union across the exclude pairs and across lenses; e.g. hide `nsfw`/`system` together). The two arrays are parallel — `require(excludeTagDefs.length == minWeights.length)` — and capped at `MAX_EXCLUDE_TAGS_PER_QUERY = 8`; empty arrays ⇒ no exclusion (degenerates to the unfiltered read). Thresholds are caller arguments; the per-item check resolves a file's DATA via its placement PIN (file labels target the DATA UID, folder labels target the ANCHOR UID) and reads the weight via `EdgeResolver.getActiveTagWeight`. A phase-1 scan budget bounds an all-excluded page. ADR-0048.

Use `getDirectoryPageBySchemaAndAddressList(folderUID, DATA_SCHEMA_UID, [alice, bob], 0, 50)` to list files in `/memes/` from Alice and Bob's lenses. EFSFileView also exposes `getFilesAtPath(fileAnchorUID, attesters, schema, start, length)` for the narrower case of "what DATA attestations are on this specific anchor" — callers pass a file anchor, not a folder.

**Subfolder visibility in lens listings is tag-only** (ADR-0038, revised by ADR-0041). `getDirectoryPageBySchemaAndAddressList` returns generic subfolders iff at least one lens attester has an active `TAG(definition=anchorSchema, refUID=folder)`. There is no write-time folder-qualifying index. The upload flow (client side) walks the ancestor chain from the immediate parent up to root exclusive and emits a visibility TAG at every generic ancestor the attester hasn't already claimed; this keeps every folder on the path to an uploaded file visible in the uploader's lens. `_containsAttestations` is still populated (used below for file-anchor child filtering), but is no longer consulted for folder visibility.

### `propagateContains` (Tree Visibility)
When a PIN or TAG places content at a structural Anchor, EdgeResolver calls `indexer.propagateContains(definition, attester)`. This walks up the `_parents` chain from the definition Anchor, setting `_containsAttestations[ancestor][attester] = true` at each level. Early-exit on already-flagged ancestors makes repeated contributions amortized O(1). This enables the sidebar tree to show which folders contain content from a given attester without scanning their children.

`MAX_ANCHOR_DEPTH = 32` caps the upward walk to prevent gas griefing via deeply nested Anchor chains.

### `clearContains` (partial de-propagation)
When the last active edge placed at a definition Anchor by an attester is removed (revocation, or PIN supersede that empties the slot), EdgeResolver calls `indexer.clearContains(definition, attester)`. This clears the **immediate folder's** `_containsAttestations` flag only — ancestor flags remain sticky (see ADR-0010). The immediate-folder clear is sufficient because `getDirectoryPageByAddressList` checks the direct child's flag; leaving ancestors flagged is conservative (a folder might stop appearing empty) and avoids the gas cost of reference-counted de-propagation.

### `_childrenByAttester` and `_containsAttestations` Propagation Behaviour
`_containsAttestations[anchorUID][attester]` is flagged when an attester contributes content under that anchor. Two paths trigger propagation:

1. **Anchor creation**: When an attester creates an Anchor under a parent, the indexer walks up `_parents` flagging `_containsAttestations` and pushing to `_childrenByAttester` at each ancestor.
2. **Edge-based placement (PIN or TAG)**: When EdgeResolver processes an edge whose definition is a structural Anchor, it calls `indexer.propagateContains(definition, attester)` which performs the same upward walk.

In practice this means:
- Alice creates `apple.mp3` (Anchor) under `/music/`. `_childrenByAttester[musicUID][alice]` gets `apple.mp3`. Direct anchor creation.
- Bob PINs a DATA into Alice's `apple.mp3` Anchor. EdgeResolver calls `propagateContains(apple.mp3, bob)` → `_containsAttestations[musicUID][bob]` is set and `apple.mp3` is pushed to `_childrenByAttester[musicUID][bob]`.

**UI implication**: `getChildrenByAddressList(musicUID, [alice, bob])` walks the global `_children` array and O(1)-checks `_containsAttestations`. Both alice’s and bob’s contributions appear without duplicates.

## Efficient Client Traversal
When a web client needs to load a directory:
1. It queries the Indexer contract for the list of names (Anchors) inside the target Folder.
2. For each name returned, the client receives the associated resolved state (the newest/most valid Data or Property attestation).
3. Under the hood, this requires indexing based on the *schema type* and the *attester's address*, as the active state of a directory is a subjective compilation based on a specific user's web of trust or explicit lens request.

## Edge Indexing via EdgeResolver

Edge attestations (PIN and TAG) are handled by a single `EdgeResolver` contract — distinct from `EFSIndexer`. Both schemas register `EdgeResolver` as their resolver. ADR-0041 explains why one shared resolver implements two cardinality regimes rather than two separate contracts.

### Schema-Aware Active-Edge Map
EdgeResolver maintains a single active-edge map keyed by a **schema-aware** hash:

```
mapping(bytes32 edgeHash => bytes32 activeUID) _activeEdge
edgeHash = keccak256(abi.encodePacked(attester, targetID, definition, schema))
```

The `schema` term keeps PIN and TAG entries at the same `(attester, target, definition)` triple in independent slots — they cannot corrupt each other. Aggregate counters that intentionally sum across schemas (`_activeCount`, `_activeTotalByDefAndAttester`) use a schema-blind `_targetDefHash(targetID, definition)` and compose correctly because each schema's `wasActive` check is isolated.

### PIN: Per-Slot Singleton
For PIN attestations, EdgeResolver writes `_activeBySlot[definition][attester][targetSchema]` as a `SlotEntry { pinUID, targetID }`. A new PIN at the same slot but a different target supersedes the prior PIN in O(1): the prior `edgeHash` row is cleared from `_activeEdge`, counters are decremented, and the slot updates atomically. There is no "logical supersede" delay or special revoke handling — re-attestation *is* the supersede.

EAS revoke of a PIN clears the slot iff the held `pinUID` matches; revoking a stale (already-superseded) PIN is a no-op.

### TAG: Per-Slot List with Inline Weights
For TAG attestations, EdgeResolver appends to `_activeByAAS[definition][attester][targetSchema]` a `TagEntry { tagUID, weight }`. The struct-of-tuple shape is load-bearing per ADR-0041: it lets on-chain consumers read `(uid, weight)` tuples in one bulk SLOAD per slot, avoiding the N+1 SLOAD pattern that would arise if weight lived in a side mapping. Re-attesting the same `edgeHash` (same `(attester, target, definition)`) updates the entry's UID and weight in place. EAS revoke swap-and-pops the entry.

`_activeByAASIndex[definition][attester][schema][edgeHash] → uint256 (index+1, 0 = absent)` enables O(1) swap-and-pop. The schema-aware `edgeHash` ensures TAG removals never touch PIN bookkeeping.

### Shared Discovery Indices
EdgeResolver maintains append-only discovery indices that are **schema-blind** — both PIN and TAG contribute:
- **Definitions by Target**: which definitions have ever been attested against a target (`_edgeDefinitions[targetID]`).
- **Targets by Definition**: which targets have ever been attested under a definition (`_targetsByDef[definition]`).
- **Children with Edge by Parent**: child anchors with an active edge under a definition, scoped by parent (`_childrenWithEdge[parentUID][definition]`).

These indices only grow; revoked entries are **not** removed. Consumers cross-reference active-state queries (e.g. `isActiveEdgeAnySchema`) to filter out stale entries.

### Definition Storage for Descriptive TAG Labels
Descriptive label definitions (e.g. `#nsfw`) are stored as normal Anchors under a reserved `/tags/` folder, created at deploy time. The UI hides `/tags/` from standard browsing while keeping definitions discoverable via `resolvePath(tagsAnchorUID, "tagName")`. Folder-visibility TAGs use a schema UID (e.g. `DATA_SCHEMA_UID`) directly as the definition — no `/tags/` anchor required.

### EFSIndexer Integration
EdgeResolver is wired to EFSIndexer: `onAttest` calls `indexer.index(uid)` and `onRevoke` calls `indexer.indexRevocation(uid)`. PIN and TAG attestations are fully registered in EFSIndexer's generic discovery indices alongside other schemas:

```
indexer.getReferencingAttestations(targetUID, PIN_SCHEMA_UID, 0, 100, false)
  → all PIN attestations targeting a given anchor or address
indexer.getReferencingAttestations(targetUID, TAG_SCHEMA_UID, 0, 100, false)
  → all TAG attestations targeting a given anchor or address
indexer.getOutgoingAttestations(attester, PIN_SCHEMA_UID, 0, 100, false)
  → all PINs made by a specific user
```

**Schema-aware queries are the correct pattern**: callers must specify the schema UID for schema-specific results. Mixing PIN and TAG in a generic query is intentional only when building a unified history view.

### On-Chain Query Functions
**Schema-blind aggregate (PIN ∪ TAG):**
- `hasActiveEdge(targetID, definition)` — Returns true if any attester has any active edge (PIN or TAG) on the pair. O(1) via `_activeCount`.
- `hasActiveEdgeFromAny(targetID, definition, attesters[])` — Lens-scoped: true iff any of `attesters` has an active edge (PIN or TAG). Two SLOADs per attester.
- `isActiveEdgeAnySchema(attester, targetID, definition)` — True iff a specific attester has an active edge of either kind. Two SLOADs.
- `getEdgeDefinitions(targetID, start, length)` and `getEdgeDefinitionCount(targetID)` — Paginated discovery: which definitions have been attested against the target.
- `getTargetsByDefinition(definition, start, length)` and `getTargetsByDefinitionCount(definition)` — Paginated discovery: which targets have been attested under the definition.
- `getChildrenWithEdge(parentUID, definition, start, length)` and `getChildrenWithEdgeCount(parentUID, definition)` — Paginated discovery: child anchors with an active edge under a definition, scoped by parent.

**Schema-specific (caller picks the cardinality they want):**
- `isActiveEdge(attester, targetID, definition, schema)` — Boolean for one specific schema.
- `getActiveEdgeUID(attester, targetID, definition, schema)` — Active UID for one specific schema (zero if none).

**PIN readers (Shape A — singular):**
- `getActivePin(definition, attester, targetSchema) → bytes32 pinUID` — O(1) read of the active PIN UID.
- `getActivePinTarget(definition, attester, targetSchema) → bytes32 targetID` — O(1) read of the active PIN's target. **Primary read for Shape A consumers** (file placement, PROPERTY value binding, contentType).
- `getActivePinSlot(definition, attester, targetSchema) → SlotEntry` — both fields in one return.

**TAG readers (Shape B — list):**
- `getActiveTagEntries(definition, attester, schema, start, length) → TagEntry[]` — Primary list reader. Returns `(tagUID, weight)` tuples in one bulk SLOAD per slot — sortable by weight without an N+1 SLOAD pattern.
- `getActiveTags(definition, attester, schema, start, length) → bytes32[]` — Convenience: drops weights, returns UIDs only.
- `getActiveTargetsByAttesterAndSchema(definition, attester, schema, start, length) → bytes32[]` — Resolves entries back to their target IDs (one EAS read per entry; prefer `getActiveTagEntries` when you also need the weight).
- `getActiveTagsCount(definition, attester, schema)` — Count of active TAG entries in the slot.

### Lens-Aware Label Filtering
When filtering a directory listing by descriptive TAG labels, the client uses direct per-attester reads — not a global definition scan. Labels target specific DATA UIDs (for file items) or Anchor UIDs (for folder items), not the shared Anchor UID of the file slot.

**Terminology (ADR-0041 + ADR-0042):**
- **Active TAG** (kernel): an unrevoked TAG edge. Weight is opaque kernel metadata — does not affect activity.
- **Effective TAG** (client convention, ADR-0042): an active TAG with `weight >= 0`. Applied only in the explorer's include/exclude filter (`FileBrowser.resolveTagSet`). Tags with `weight < 0` remain kernel-active but are excluded from the filter set. Do not call `weight < 0` tags "inactive" in shared code.

**Algorithm (`resolveTagSet(tagName)` in `FileBrowser`):**

1. **Resolve the tag definition**: `resolvePath(tagsAnchorUID, tagName)` → `definitionUID`. Definitions can be nested (e.g. `/tags/nsfw/language/`).
2. **Iterate per attester, per target schema**: For each `targetSchema` in `[DATA_SCHEMA_UID, ANCHOR_SCHEMA_UID]` and each attester in the lenses list:
   a. `getActiveTagsCount(definitionUID, attester, targetSchema)` — skip bucket if count is 0.
   b. Paginate (500-entry pages) with two parallel reads: `getActiveTagEntries(...)` → `(tagUID, weight)` tuples; `getActiveTargetsByAttesterAndSchema(...)` → resolved target IDs.
   c. Iterate to `min(entries.length, targets.length)` (guards against a revocation landing between the two RPC calls). For each pair: if `weight >= 0`, add `targetID` to the effective-targets set.
3. **Match against directory items**: a directory item matches the filter if its DATA UID (file items) or Anchor UID (folder items) is in the effective-targets set returned by step 2.

This approach reads directly from the per-attester active-TAG buckets (`_activeByAAS[definition][attester][schema]`). It does **not** use `getTargetsByDefinition` for filtering — that function returns an append-only list of ever-attested targets including revoked ones and is only appropriate for discovery/history views.

**Lens isolation**: tagging User A's lens of `test.txt` as "nsfw" (stores the tag under User A's attester key) does not cause User B's DATA UID for the same file to match the filter — each attester's active-TAG bucket is independent.

### Edge Cases and Caveats
- **Updated DATA (new uploads)**: When a user uploads a new version, they PIN the new DATA at the file Anchor — the prior PIN supersedes automatically. Descriptive labels (TAGs) on the old DATA UID do not carry over to the new DATA UID; users must re-tag after a new upload.
- **Cross-user tagging**: User B can TAG User A's DATA UID directly. The tag lives in User B's bucket under `_activeByAAS[definition][userB][DATA_SCHEMA_UID]`. When the filter iterates User B's lenses, User A's DATA UID will appear in the effective-target set. This is intentional: cross-user curation is supported by design.
- **Folder-level tags**: TAGs on Anchor UIDs use `ANCHOR_SCHEMA_UID` as the target schema bucket, checked in the same loop alongside `DATA_SCHEMA_UID`. No DATA indirection.
- **Non-atomic RPC reads**: `getActiveTagEntries` and `getActiveTargetsByAttesterAndSchema` are two independent RPC calls. A revocation between them can return arrays of different lengths. The `min(entries.length, targets.length)` bound guards against an out-of-bounds read; the mismatched entry would have been stale anyway.

### Off-Chain Indexer API Patterns
For a responsive web UI, off-chain indexers should expose these additional query patterns:
1. **Attestations by Tag and Schema**: `getAttestationsByTag(definitionUID, targetSchemaUID, cursor)` — Paginated list of items with a specific tag, filtered by the target's schema type.
2. **Addresses by Tag**: `getAddressesByTag(definitionUID, cursor)` — Paginated list of user addresses (from the `recipient` field) possessing a specific tag.
3. **Tags for Target**: `getTagsForTarget(targetID)` — All active tags applied to a specific file, folder, or address.
4. **Boolean State Check**: `checkIfTargetHasTag(targetID, definitionUID)` — Optimized boolean check for tag membership.

## Sort Overlay Indexing via EFSSortOverlay

The SORT_INFO schema is handled by `EFSSortOverlay`. It is registered in EAS with `EFSSortOverlay` as its resolver.

Sort overlays are **not populated in the resolver hook** — they are populated lazily off-hook by `processItems` calls. The resolver hook only validates and caches the sort config.

### Shared Sorted Linked Lists

The `EFSSortOverlay` maintains a shared doubly linked list **per `(sortInfoUID, parentAnchor)` pair**. All attesters contribute to a single ordering per directory. Lens filtering is applied at read time via `getSortedChunkByAddressList`.

```
_sortNodes[sortInfoUID][parentAnchor][itemUID]  → Node { prev, next }
_sortHeads[sortInfoUID][parentAnchor]           → head UID (bytes32(0) = empty)
_sortTails[sortInfoUID][parentAnchor]           → tail UID (bytes32(0) = empty)
_sortLengths[sortInfoUID][parentAnchor]         → item count
_lastProcessedIndex[sortInfoUID][parentAnchor]  → kernel items acknowledged
```

The kernel (EFSIndexer) remains the source of truth. The sort overlay is a secondary index providing a different ordering.

### Resolver Hook Behaviour

- **SORT_INFO `onAttest`**: Validates `refUID != bytes32(0)` (naming Anchor required) and `sortFunc != address(0)`. Caches `SortConfig { sortFunc, targetSchema, valid, revoked }`.
- **SORT_INFO `onRevoke`**: Sets `config.revoked = true`. `processItems` will revert for revoked sorts; `getSortStaleness` returns 0.

### On-Chain Query Functions

**Sorted pagination:**
- `getSortedChunk(sortInfoUID, parentAnchor, startNode, limit, showRevoked)` — Cursor-based pagination. `startNode = bytes32(0)` starts at head. Returns `(items[], nextCursor)`. Hard cap: `limit ≤ 100`. Use `getSortedChunkByAddressList` for lens-filtered reads.
- `getSortLength(sortInfoUID, parentAnchor)` — Sorted item count.
- `getSortHead(sortInfoUID, parentAnchor)` — First (smallest) item UID.
- `getSortTail(sortInfoUID, parentAnchor)` — Last (largest) item UID.
- `getSortNode(sortInfoUID, parentAnchor, itemUID)` — Raw `Node { prev, next }` for a specific item.

**Staleness and progress:**
- `getSortStaleness(sortInfoUID, parentAnchor)` — `kernelCount - lastProcessedIndex`. How many kernel items are unprocessed.
- `getLastProcessedIndex(sortInfoUID, parentAnchor)` — Physical kernel index to resume from.

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

// EdgeResolver (handles both PIN and TAG schemas — ADR-0041)
onAttest → indexer.index(attestation.uid)           // makes PIN/TAG attestations discoverable
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
