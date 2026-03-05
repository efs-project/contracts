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
**Purpose**: Categorization, weighting, and filtering.
**Structure**:
`refUID = Target Attestation UID`
- `labelUID` (bytes32) - Refers to an Anchor UID defining the tag.
- `weight` (int256) - A numeric weight or score assigned to the tag (enabling crowd-sourced voting on tags).

**Details**: A tag has its `refUID` set to the attestation being tagged. The `definition` field holds the UID of the Anchor defining the tag itself (e.g., an Anchor representing "favorites" or "nsfw"). Tags are used for organizing lists and acting as frontend filters, such as hiding unwanted "nsfw" content for specific users.

## Schema Hierarchy
To represent a standard filesystem interaction where a file has a name within a folder:
1. **Parent Topic** (e.g., Folder "memes") ->
2. **Anchor** (name: "vitalik.jpg", `refUID` points to Parent Topic) ->
3. **Data** (`refUID` points to Anchor, securely holds `uri` answering directly to an IPFS, Web3, or external link alongside `contentType`).
