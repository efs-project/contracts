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

### Discovery Indices
The resolver maintains append-only discovery indices:
- **Definitions by Target**: Which tag definitions have ever been applied to a given target.
- **Targets by Definition**: Which targets have ever been tagged with a given definition.

### On-Chain Query Functions
- `getActiveTagUID(attester, targetID, definition)` — Returns the active tag attestation UID for a specific triple.
- `getTagDefinitions(targetID, start, length)` — Paginated list of definitions applied to a target.
- `getTaggedTargets(definition, start, length)` — Paginated list of targets tagged with a definition.

### Off-Chain Indexer API Patterns
For a responsive web UI, off-chain indexers should expose these additional query patterns:
1. **Attestations by Tag and Schema**: `getAttestationsByTag(definitionUID, targetSchemaUID, applies, cursor)` — Paginated list of items with a specific tag, filtered by the target's schema type.
2. **Addresses by Tag**: `getAddressesByTag(definitionUID, applies, cursor)` — Paginated list of user addresses (from the `recipient` field) possessing a specific tag.
3. **Tags for Target**: `getTagsForTarget(targetID)` — All active tags applied to a specific file, folder, or address.
4. **Boolean State Check**: `checkIfTargetHasTag(targetID, definitionUID)` — Optimized boolean check for tag membership.
