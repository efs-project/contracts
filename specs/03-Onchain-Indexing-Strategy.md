# Onchain Indexing Strategy

EFS is designed to work fully onchain without offchain centralized dependencies, which requires key data lookups to be highly efficient. Because EFS uses intermediary naming schemas (Anchors as seen in [Data Models and Schemas](./02-Data-Models-and-Schemas.md)), this presents a unique indexing challenge for smart contracts and the frontend client.

For practical queries utilizing this index, see [Core Workflows](./04-Core-Workflows.md).

## The Two-Level Attestation Challenge
In a typical filesystem, a folder contains items (files or properties). In EFS, to associate a name with an item inside a folder, we use a two-step link involving an Anchor.

The logical flow is:
`Folder (Topic)` -> `Anchor (File/Property Name)` -> `Property / Data`

Because Ethereum cannot natively query "all properties where the name's parent is X" without an index, EFS contracts must explicitly track two levels of relationships.

## Contract Indexing Approach
To make fast directory browsing possible, the smart contracts maintain an internal index of the children for a given Topic (Folder). EFS utilizes the **EAS SchemaResolver** pattern. The `EFSIndexer` contract is registered as the resolver for all EFS schemas.

When a user creates a new file (a `Data` attestation pointing to an `Anchor` pointing to a `Folder`):
1. EAS automatically calls `onAttest` on the `EFSIndexer` in the same transaction.
2. The indexer verifies the schema constraints and records the association between the `Folder UID` and the underlying `Anchor UID`.
3. The indexer also records mapping data for the `Anchor UID` and the newest `Data` or `Property` attestation linked to it.

Essentially, the contract maintains a real-time tracking list for any given Folder. This allows a client to query a single function to fetch the directory contents.

### Gas Limits, Spam, and Append-Only Storage
Because EAS is permissionless, anyone can attest files to a folder. To prevent Out-Of-Gas (OOG) errors:
- **Read Pagination**: All indexer read functions accept `start` and `length` parameters for cursor-based pagination through large directories.
- **Append-Only Kernel**: EFSIndexer is the append-only kernel. Arrays are never modified after a write. When an attestation is revoked, `onRevoke` sets `_isRevoked[uid] = true` but leaves all arrays intact. This eliminates O(N) removal overhead and makes the storage model simpler and cheaper to write (deploy gas: ~2.35M vs ~3.8M for the old swap-and-pop design; revoke gas: ~90k vs ~200k).
- **`showRevoked` filtering**: Every read function accepts a `bool showRevoked` parameter. When `false` (the default), the function scans forward and skips revoked UIDs, returning only active items. When `true`, revoked items are included — useful for history views and admin tooling.

## Editions (Address-Based Namespaces)
To support subjective file resolution natively onchain, the Indexer maintains additional append-only mappings:
- **Core Referencing History**: `_allReferencing` and `_referencingByAttester` track immutable history, ensuring revocations do not break the chain of edits.
- **Subjective File Content**: `_dataAttestationsByAddress` tracks user iterations of a file payload. Clients use `getDataByAddressList` with a list of trusted addresses to auto-fallback and resolve the highest-trusted active file version in fast time.
- **Deduplicated Directory Listings**: `getChildrenByAddressList` walks the global `_children` array (unique, insertion order) and includes only items where any of the provided attesters has contributed — no duplicates possible. Use this for rendering a flat directory view filtered to a set of trusted addresses.
- **Round-Robin Directory Listings**: `getChildrenByAddressListInterleaved` implements fair round-robin pagination across per-attester arrays — gives each attester equal representation. May return the same anchor more than once when multiple attesters contributed to it. Use this for "whose work appears most" views or balanced multi-attester feeds.

### `_childrenByAttester` Propagation Behaviour
`_childrenByAttester[parentUID][attester]` is not limited to items the attester *created*. When an attester submits **any** attestation whose `refUID` chains up to a directory, the attester is considered "active" in that directory and the relevant ancestor anchors are pushed into their perspective arrays. In practice this means:

- Alice creates `apple.mp3` (Anchor) under `/music/`. `_childrenByAttester[musicUID][alice]` gets `apple.mp3`. ✓ Expected.
- Bob attests DATA to Alice’s `apple.mp3`. `_childrenByAttester[musicUID][bob]` also gets `apple.mp3` — because Bob is now active in `/music/` via his DATA contribution.

**UI implication**: The two directory listing APIs handle this differently:
- `getChildrenByAddressList(musicUID, [alice, bob])` — dedup version. Walks the global `_children` array and O(1)-checks `_containsAttestations`. If alice has 6 anchors and bob contributed DATA to 3 of alice’s, the result is exactly 9 unique anchors. No client-side deduplication needed.
- `getChildrenByAddressListInterleaved(musicUID, [alice, bob])` — round-robin version. Returns 12 items (alice×6 + bob×6), with the 3 shared anchors appearing twice. Use when fair per-attester representation matters more than uniqueness. The UI must deduplicate if a flat unique list is needed.

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

### On-Chain Query Functions
- `getActiveTagUID(attester, targetID, definition)` — Returns the active tag attestation UID for a specific triple. Returns zero if no active tag exists (never set, revoked, or the active attestation was for a different triple).
- `getTagDefinitionCount(targetID)` — Number of distinct definitions ever applied to a target.
- `getTagDefinitions(targetID, start, length)` — Paginated list of definitions applied to a target.
- `getTaggedTargetCount(definition)` — Number of distinct targets ever tagged with a definition.
- `getTaggedTargets(definition, start, length)` — Paginated list of targets tagged with a definition.

### Edition-Aware Tag Filtering
When filtering a directory listing by tags, the client must account for editions. Each file Anchor can have multiple DATA attestations (one per user). Tags target specific DATA UIDs, not the shared Anchor UID. The filtering algorithm is:

1. **Resolve the tag definition**: `resolvePath(tagsAnchorUID, tagName)` returns the definition Anchor UID.
2. **Fetch tagged targets**: `getTaggedTargets(definitionUID, 0, count)` returns all DATA UIDs ever tagged with this definition.
3. **For each file item in the directory listing**:
   a. Determine the relevant attesters: `editionAddresses` (if viewing specific editions) or `[connectedAddress]` (if viewing own files).
   b. For each attester, call `getDataByAddressList(anchorUID, [attester], false)` to get their current DATA UID.
   c. If **any** of those DATA UIDs appears in the tagged targets set, the item matches the filter.

This ensures that tagging User A's edition of `test.txt` as "nsfw" does not cause User B's edition to appear when filtering by "nsfw".

### Edge Cases and Caveats
- **Append-only discovery**: `getTaggedTargets` returns UIDs that were ever tagged, including revoked ones. A strict filter should additionally verify each candidate via `getActiveTagUID` or by checking the `applies` field of the active attestation.
- **Updated DATA (new uploads)**: If a user uploads a new version of a file, `getDataByAddressList` returns the latest DATA UID. Tags on the old DATA UID do not carry over to the new version. Users must re-tag after uploading a new version.
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

**How EFSSortOverlay uses this:**
```
onAttest → indexer.index(attestation.uid)        // makes SORT_INFO discoverable
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
