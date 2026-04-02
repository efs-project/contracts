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

### Gas Limits, Spam, and O(1) Operations
Because EAS is permissionless, anyone can attest files to a folder. To prevent Out-Of-Gas (OOG) errors:
- **Read Pagination**: The indexer’s read functions (like `getChildren`) require `start` and `length` offset parameters, allowing frontends to paginate through massive directories without hitting block limits.
- **O(1) Data Removals**: When an attestation is revoked (`onRevoke`), the indexer must remove it from the arrays. To prevent O(N) array scanning, the contract maintains a `_uidIndices` struct that tracks the exact array index of every UID across all relationship sets. Removals use an O(1) "swap-and-pop" mechanism.

## Editions (Address-Based Namespaces)
To support subjective file resolution natively onchain, the Indexer maintains additional append-only mappings:
- **Core Referencing History**: `_allReferencing` and `_referencingByAttester` track immutable history, ensuring revocations do not break the chain of edits.
- **Subjective File Content**: `_dataAttestationsByAddress` tracks user iterations of a file payload. Clients use `getDataByAddressList` with a list of trusted addresses to auto-fallback and resolve the highest-trusted active file version in fast time.
- **Round-Robin Directory Listings**: To merge an unbiased directory listing curated by multiple users, the `getChildrenByAddressList` API implements a gas-safe round-robin cursor pagination, scanning across existing user-specific arrays rather than iterating over global spam-filled lists.

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

## List Indexing via EFSListManager

LIST_INFO and LIST_ITEM schemas are handled by a dedicated `EFSListManager` contract (separate from `EFSIndexer` and `EFSTagResolver`). Both schemas are registered in EAS with `EFSListManager` as their resolver.

### Per-Attester Doubly Linked Lists

The `EFSListManager` maintains a doubly linked list **per `(listInfoUID, attester)` pair**:

```
_listNodes[listInfoUID][attester][itemAttUID]  → Node { prev, next }
_listHeads[listInfoUID][attester]              → head UID (bytes32(0) = empty)
_listTails[listInfoUID][attester]              → tail UID (bytes32(0) = empty)
_listLengths[listInfoUID][attester]            → item count
```

This mirrors the `_childrenByAttester` pattern in `EFSIndexer`. Each attester's list is independently ordered; the SPA merges them via the Four-Tier Resolution Engine.

### Discovery Indices (Append-Only)

To avoid requiring `eth_getLogs` for common UI queries, the `EFSListManager` maintains two append-only discovery indices:

- **Lists by Anchor**: `_listsByAnchor[anchorUID]` — all LIST_INFO UIDs whose `refUID` points to a given Anchor. Populated on LIST_INFO `onAttest` when `refUID != bytes32(0)`. Enables "show all editions of this list" without event scanning.
- **Attesters by List**: `_listAttesters[listInfoUID]` — ordered list of unique attester addresses who have ever added items to a given LIST_INFO. Populated on LIST_ITEM `onAttest` with a dedup guard (`_hasAttested` flag). Enables "who has touched this list" without event scanning.

Both indices only grow; revocations do not remove entries.

### Resolver Hook Behaviour

- **LIST_INFO `onAttest`**: Caches `listType` and `targetSchemaUID`. Sets a validity flag (`_isValidListInfo`) used by LIST_ITEM hooks to avoid calling back into EAS from within a resolver. If `refUID != bytes32(0)`, records the LIST_INFO in `_listsByAnchor[refUID]`.
- **LIST_INFO `onRevoke`**: Sets `_isRevokedListInfo` flag. Does not delete nodes (too expensive); `getSortedChunk` returns empty for revoked lists.
- **LIST_ITEM `onAttest`**: Validates `refUID` points to a valid non-revoked LIST_INFO using internal flags. If `targetSchemaUID` is set and `itemUID != bytes32(0)`, validates the item's schema via `_eas.getAttestation(itemUID).schema`. Records the attester in `_listAttesters` (once per attester per list). Appends to the attester's linked list tail.
- **LIST_ITEM `onRevoke`**: Unlinks the node in O(1) — bridges prev/next neighbours, updates head/tail if needed, decrements length. Does **not** remove the attester from `_listAttesters` (append-only).

### On-Chain Query Functions

**Pagination:**
- `getSortedChunk(listInfoUID, attester, startNode, limit)` — Cursor-based pagination. `startNode = bytes32(0)` starts at head; otherwise starts FROM `startNode` (inclusive). Returns `(items[], nextCursor)`. Hard cap: `limit ≤ 100`.
- `getListLength(listInfoUID, attester)` — Item count for an attester's list.
- `getListHead(listInfoUID, attester)` — First LIST_ITEM UID.
- `getListTail(listInfoUID, attester)` — Last LIST_ITEM UID.
- `getNode(listInfoUID, attester, nodeUID)` — Raw `Node { prev, next }` for a specific item.
- `getListType(listInfoUID)` — Cached `listType` (0=Manual, 1=Chronological).
- `getTargetSchema(listInfoUID)` — Cached `targetSchemaUID` constraint.

**Discovery:**
- `getListsByAnchorCount(anchorUID)` — Number of LIST_INFOs pinned to a given Anchor.
- `getListsByAnchor(anchorUID, start, length)` — Paginated LIST_INFO UIDs under an Anchor.
- `getListAttesterCount(listInfoUID)` — Number of unique attesters who have ever added items.
- `getListAttesters(listInfoUID, start, length)` — Paginated attester addresses for a list.

See [Lists and Collections](./06-Lists-and-Collections.md) for full architecture including the Four-Tier Resolution Engine and fractional index ordering.
