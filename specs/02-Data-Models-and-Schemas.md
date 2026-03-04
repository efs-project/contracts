# Data Models and Schemas

EFS is composed of five core EAS schemas, adhering to the principles outlined in [System Architecture](./01-System-Architecture.md). These schemas interact through `refUID` links to create a hierarchical, permissionless filesystem state natively on Ethereum. For details on how these are tracked, refer to the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

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
**Purpose**: File system metadata linking names to BLOBs.
**Structure**:
`refUID = Anchor UID`
- `blobUID` (bytes32)
- `fileMode` (string) - Defines the file type (e.g., normal file, `tombstone` for deletion, symlink, etc).

**Details**: Data attestations must reference an Anchor in their `refUID` to be given a name within a folder. They contain file system data such as whether an item is a 'normal file', a 'symlink', a 'hardlink', 'deletion info', or 'rename info'. If denoting a normal file, the `data` field typically contains an EAS link to a BLOB UID.

## 4. BLOB Schema
**Purpose**: Raw data storage and content resolution.
**Structure**:
`refUID = empty (bytes32(0))`
- `mimeType` (string) - Valid MIME type (e.g., `image/jpeg`).
- `storageType` (uint8) - Denotes where the data is stored (0 = Onchain, 1 = IPFS, 2 = HTTPS, etc).
- `location` (bytes) - The raw bytes of the file, or an encoded URI/Hash based on `storageType`.

**Details**: BLOBs contain information on where the actual data resides. The `data` field contains the bytes of the file itself or a URI (like an IPFS hash or HTTPS link) determining where to find the data. By utilizing `contentType`, it strictly relies on standard MIME types (e.g., `image/jpeg`, `video/mp4`) to define the nature of the file.

## 5. Tag Schema
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
3. **Data** (`refUID` points to Anchor, holds info linking to BLOB) ->
4. **BLOB** (Holds actual bytes or IPFS link).
