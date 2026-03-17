# Data Models and Schemas

EFS is composed of a "Quad-Schema" model (four core EAS schemas), adhering to the principles outlined in [System Architecture](./01-System-Architecture.md). These schemas interact through `refUID` links to create a hierarchical, permissionless filesystem state natively on Ethereum. For details on how these are tracked, refer to the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

## 1. Anchor Schema
**Purpose**: Acts as a "Schelling Point" or a shared naming reference for a given Topic.
**Structure**:
`refUID = Parent Anchor UID (or User Address / bytes32(0))`
- `name` (string)
- `schemaUID` (bytes32) - Enforces what type of data can be attached to this anchor (e.g., Folder vs File vs Property).

**Details**: An Anchor represents a name (like a folder name or a file name) within a specific context. It references (is a child of) an attestation in its EAS `refUID` field. Other attestations reference these Anchors in their `refUID` fields when they need to be associated with that specific name. Names are considered unique within their direct hierarchy level relative to the parent entity.

## 2. Property Schema
**Purpose**: Key-value pairs for metadata or settings.
**Structure**:
`refUID = Anchor UID (for the property name)`
- `value` (string)

**Details**: A Property must reference an Anchor in its `refUID` to be associated with a name. It is an onchain string containing simple text data easily usable by contracts and users (e.g., an icon URL, a descriptive text, or metadata).

## 3. Data Schema
**Purpose**: File system metadata directly linking names to content URIs.
**Structure**:
`refUID = Anchor UID`
- `uri` (string) - URI resolving to the content (e.g., web3://, ipfs://, ar://, or plain HTTPS).
- `contentType` (string) - Valid MIME type (e.g., `image/jpeg` or `text/markdown`).
- `fileMode` (string) - Defines the file type (e.g., normal file, `tombstone` for deletion, symlink, etc).

**Details**: Data attestations must reference an Anchor in their `refUID` to be given a name within a folder. They contain file system data such as whether an item is a 'normal file', a 'symlink', a 'hardlink', 'deletion info', or 'rename info'. They directly embed the `uri` and `contentType` avoiding the need for a separate physical BLOB attestation.

## 4. Tag Schema
**Purpose**: Subjective categorization, labeling, and filtering via the "Type as Topic" pattern.
**Structure**:
`refUID = Target Attestation UID` or `recipient = Target Ethereum Address`
- `definition` (bytes32) - The Anchor UID that defines the label of the tag. This points to a "Type as Topic" definition, such as the UID for the `/tags/nsfw` or `/tags/favorites` anchor. By forcing tags to reference an Anchor UID (rather than a raw string), the tag namespace remains hierarchical, collision-resistant, and indexable.
- `applies` (bool) - `true` means the tag is active and applies to the target. `false` means the tag is explicitly negated or removed.

**Details**: Tags create a graph layer that overlays the strict tree-like directory structure. A single file can have many tags without data duplication, enabling many-to-many relationships.

Tags target either an attestation (via `refUID`) or an Ethereum address (via `recipient`), keeping the custom payload minimal. The `EFSTagResolver` contract enforces a **singleton tagging pattern**: only one active tag exists per `(attester, target, definition)` triple. When a user applies a new tag matching an existing combination, the resolver logically supersedes the old tag by overwriting its internal mapping. This ensures query functions always return the latest state as a clean single source of truth.

Complex aggregation logic (Sybil resistance, reputation weighting, running averages) is entirely delegated to upper-layer indexers and client UIs, not computed on-chain.

### Tag Definitions as Anchors
Tag definitions are stored as normal Anchors under a reserved `/tags/` folder, which is itself a standard Anchor created under the filesystem root at deploy time. For example, the "nsfw" tag definition is the Anchor UID resolved by `resolvePath(tagsAnchorUID, "nsfw")`. This keeps tag definitions within the single unified anchor tree while the UI hides the `/tags/` folder from standard file browsing.

Creating a new tag with a name that does not yet exist under `/tags/` requires a two-step process: first create the definition Anchor, then create the Tag attestation referencing it.

### Edition-Specific Tagging (DATA UID Targeting)
When tagging files, tags should target the **DATA attestation UID** (the specific edition) rather than the Anchor UID (the shared filename). This is critical because multiple users can attach different DATA attestations to the same file Anchor, and each edition should be independently taggable.

**Example**: User A and User B both have a `test.txt` file (same Anchor). User A tags their DATA attestation as "nsfw". Because the tag targets User A's DATA UID specifically, User B's edition is not affected. When filtering by "nsfw":
- Viewing User A's edition: their DATA UID is in the tagged set, so the file appears.
- Viewing User B's edition: their DATA UID is not tagged, so the file is hidden.

For folder-level tags (e.g., marking a folder as "important"), the tag targets the Anchor UID directly since folders have no per-user DATA attestations.

### Tag Removal
Tags can be removed through two mechanisms:
1. **Revocation**: Calling `eas.revoke()` on the active tag attestation UID. The `EFSTagResolver` clears the active mapping if the revoked UID matches the currently active one. This is the preferred removal method.
2. **Superseding with `applies=false`**: Creating a new Tag attestation with the same `(attester, target, definition)` triple but `applies=false`. The new attestation logically supersedes the old one. The active UID is updated to the negation attestation. This leaves an on-chain record of the explicit removal.

## Schema Hierarchy
To represent a standard filesystem interaction where a file has a name within a folder:
1. **Parent Topic** (e.g., Folder "memes") ->
2. **Anchor** (name: "vitalik.jpg", `refUID` points to Parent Topic) ->
3. **Data** (`refUID` points to Anchor, securely holds `uri` answering directly to an IPFS, Web3, or external link alongside `contentType`).
