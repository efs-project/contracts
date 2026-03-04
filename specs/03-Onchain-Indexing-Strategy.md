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

## Efficient Client Traversal
When a web client needs to load a directory:
1. It queries the Indexer contract for the list of names (Anchors) inside the target Folder.
2. For each name returned, the client receives the associated resolved state (the newest/most valid Data or Property attestation).
3. Under the hood, this requires indexing based on the *schema type* and the *attester's address*, as the active state of a directory is a subjective compilation based on a specific user's web of trust or explicit edition request.
