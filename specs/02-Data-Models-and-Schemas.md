# Data Models and Schemas

EFS uses six core EAS schemas arranged in three conceptual layers, adhering to the principles outlined in [System Architecture](./01-System-Architecture.md). These schemas interact through `refUID` links and TAG-based placement to create a hierarchical, permissionless filesystem state natively on Ethereum. For details on how these are tracked, refer to the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

**Three-layer architecture:**
- **Paths** (Anchors) — Schelling points for names and locations
- **Data** (DATA + PROPERTY) — Standalone file identity and metadata
- **Retrieval** (MIRROR) — Transport-specific URIs for fetching content

Files are placed at paths via TAGs, not by direct `refUID` linking. This decouples identity from location: the same DATA can appear at multiple paths, and multiple users can independently place different DATAs at the same path.

## 1. Anchor Schema
**Purpose**: Acts as a "Schelling Point" or a shared naming reference for a given Topic.
**Structure**:
`refUID = Parent Anchor UID (or User Address / bytes32(0))`
- `name` (string)
- `schemaUID` (bytes32) - Enforces what type of data can be attached to this anchor (e.g., Folder vs File vs Property).

**Details**: An Anchor represents a name (like a folder name or a file name) within a specific context. It references (is a child of) an attestation in its EAS `refUID` field. Other attestations reference these Anchors in their `refUID` fields when they need to be associated with that specific name. Names are considered unique within their direct hierarchy level relative to the parent entity.

## 2. Property Schema
**Purpose**: Free-floating value attached to a container via TAG placement under a *key anchor*. Symmetric with DATA (see §3) — both are standalone values placed via TAG, not via `refUID`.
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- `value` (string)

**Revocable**: `false` — PROPERTY is permanent, like DATA. The *binding* (which container the value applies to, from which attester) lives in the TAG and is the only thing that can move.

**Details**: Per ADR-0035, PROPERTY no longer carries a `key` field and no longer targets a container via `refUID`. Instead:

1. The **key** is the `name` of a PROPERTY-typed anchor (`schemaUID = PROPERTY_SCHEMA_UID`) under the target container.
2. The **value** is the PROPERTY attestation's sole field.
3. The **binding** is a TAG with `definition = keyAnchorUID`, `refUID = propertyUID`, `applies = true`.

`EFSIndexer.onAttest` enforces only that PROPERTY is standalone (`refUID = 0x0`) and non-revocable — no target-kind validation. Per-attester singleton comes from `TagResolver._activeByAAS[keyAnchor][attester][PROPERTY_SCHEMA_UID]` — re-TAGging the same key anchor from the same attester supersedes the previous binding (ADR-0003). Reads are edition-scoped per ADR-0014.

### Example — contentType on a DATA

```
DATA(contentHash = …, size = 42)                            // free-floating content identity
  ↑ refUID
Anchor<PROPERTY>(name = "contentType", schemaUID = PROPERTY) // key anchor under the DATA
  ↑ definition
TAG(refUID = propertyUID, applies = true, attester = alice)  // binding
  ↓
PROPERTY(value = "image/jpeg")                               // free-floating value
```

### Example — display name on an address

For address containers the key anchor is created with `recipient = addr` instead of `refUID` (specs/02 §1 permits this; ADR-0033 relies on it):

```
Anchor<PROPERTY>(recipient = 0xAbC…, name = "name", schemaUID = PROPERTY)
  ↑ definition
TAG(refUID = propertyUID, applies = true, attester = alice)
  ↓
PROPERTY(value = "Vitalik Buterin")
```

### Reserved key anchors

- `"contentType"` — MIME type of a DATA (see ADR-0005 / superseded by ADR-0035).
- `"name"` — human-readable display name for any container (see ADR-0034). Clients render the hierarchy `ENS reverse-lookup (addresses only) → "name" key anchor resolved via TAG + PROPERTY scoped to the active editions → short-hex fallback`.

Other common (non-reserved) key anchors: `"previousVersion"` (value is a DATA UID of the prior version), `"description"`, `"icon"`.

### Removal

Revoke the TAG, or attest a new TAG with the same `(attester, definition, target)` and `applies=false`. Revocation of the PROPERTY itself is not supported (non-revocable).

## 3. Data Schema
**Purpose**: Standalone file identity — content-addressed, non-revocable, location-independent.
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- `contentHash` (bytes32) — keccak256 of the canonical file bytes
- `size` (uint64) — byte count

**Revocable**: `false` — DATA is permanent. Once a file identity exists, it cannot be removed.

**Details**: DATA attestations are standalone (refUID = 0x0). They represent file identity, not file location. A DATA is placed at a path via a TAG attestation (see Tag Schema below). The same DATA can be tagged into multiple paths without duplication.

Content-addressed deduplication: `EFSIndexer.dataByContentKey[contentHash]` stores the first DATA UID per content hash as the canonical entry. Subsequent DATAs with the same hash still get created (different UIDs) but the canonical lookup returns the first.

Metadata (content type, description, version history) is stored as PROPERTY attestations referencing the DATA UID. Retrieval URIs are stored as MIRROR attestations referencing the DATA UID.

## 3a. Mirror Schema
**Purpose**: Retrieval method for a DATA attestation — maps a transport type to a URI.
**Structure**:
`refUID = DATA UID`
- `transportDefinition` (bytes32) — Anchor UID for the transport type (e.g., `/transports/ipfs`)
- `uri` (string) — retrieval URI (e.g., `ipfs://QmXxx`, `ar://yyy`, `web3://0xABC`)

**Revocable**: `true`

**Details**: MIRRORs attach retrieval methods to a DATA. The `MirrorResolver` contract validates that `refUID` points to a valid DATA attestation and `transportDefinition` points to a valid Anchor. No singleton enforcement — multiple mirrors per transport type per attester are allowed.

### Transport Definition Anchors
Well-known transport types are created at deploy time under `/transports/`:
- `/transports/onchain` — `web3://` URIs pointing to SSTORE2 chunk managers
- `/transports/ipfs` — `ipfs://` URIs
- `/transports/arweave` — `ar://` URIs
- `/transports/magnet` — `magnet:` URIs
- `/transports/https` — `https://` URIs

The transport preference order for serving is: `web3://` (onchain) > `ar://` > `ipfs://` > `magnet:` > `https://`. See ADR-0012 for rationale.

## 4. Tag Schema
**Purpose**: Subjective categorization, file placement, and labeling via the "Type as Topic" pattern.
**Structure**:
`refUID = Target Attestation UID` or `recipient = Target Ethereum Address`
- `definition` (bytes32) - The Anchor UID that defines the label/location of the tag. For file placement, this is the path Anchor (e.g., the UID of the `cat.jpg` Anchor under `/memes/`). For labeling, this points to a tag definition Anchor (e.g., `/tags/nsfw`). By forcing tags to reference an Anchor UID (rather than a raw string), the tag namespace remains hierarchical, collision-resistant, and indexable.
- `applies` (bool) - `true` means the tag is active and applies to the target. `false` means the tag is explicitly negated or removed.

**Details**: Tags serve three primary roles:
1. **File placement**: `TAG(refUID=DATA_UID, definition=path_Anchor, applies=true)` — places a DATA at a path. This is how files appear in directories. The definition is the Anchor UID of the file's name within its parent folder.
2. **Labeling**: `TAG(refUID=DATA_UID, definition=label_Anchor, applies=true)` — applies a label like "nsfw" or "favorites" to a DATA. The definition is an Anchor under `/tags/`.
3. **Folder visibility** (ADR-0006 revised 2026-04-18): `TAG(refUID=folder_Anchor, definition=schema_UID, applies=true)` — declares "this folder contains content of `schema_UID` type in my edition." Required for the folder to appear in `getDirectoryPageBySchemaAndAddressList(parent, schema_UID, ...)` results. The client upload flow walks the ancestor chain on every file upload and emits this TAG at every generic ancestor the attester hasn't already claimed.

Tags create a graph layer that overlays the strict tree-like directory structure. A single DATA can be tagged into many paths and with many labels without duplication, enabling many-to-many relationships.

Tags target either an attestation (via `refUID`) or an Ethereum address (via `recipient`), keeping the custom payload minimal. The `EFSTagResolver` contract enforces a **singleton tagging pattern**: only one active tag exists per `(attester, target, definition)` triple. When a user applies a new tag matching an existing combination, the resolver logically supersedes the old tag by overwriting its internal mapping. This ensures query functions always return the latest state as a clean single source of truth.

`applies` is a per-attester assertion:
- File placement: `true` = "I place this file here", `false` = "I remove my placement"
- Labels: `true` = "I think this label applies", `false` = "I think this label does NOT apply"

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

## 5. Sort Info Schema
**Purpose**: Declares a named sort overlay attached to a directory or list.
**Structure**:
`refUID = Naming Anchor UID — the Anchor is a child of the directory being sorted (anchorSchema = SORT_INFO_SCHEMA)`
- `sortFunc` (address) — `ISortFunc` comparator contract. Implements `isLessThan(a, b, sortInfoUID)` and `getSortKey(uid, sortInfoUID)`.
- `targetSchema` (bytes32) — Which Anchor schema to sort. `bytes32(0)` = all children. `DATA_SCHEMA` = file anchors only.
- `sourceType` (uint8) — Source-list selector for what gets sorted. Reserved for future variants (kernel-shared vs per-attester children); current default is 0.
- Revocable: `true` — revoking signals "I'm done maintaining this sort; hide from menu"

**Details**: A SORT_INFO attestation names a sort by creating a naming Anchor as a child of the directory. The naming Anchor's `anchorSchema = SORT_INFO_SCHEMA` distinguishes it from file Anchors. The `EFSSortOverlay` contract is the resolver — it validates the `sortFunc` address and caches the sort config. The sorted data lives in the sort overlay's linked lists keyed by `(sortInfoUID, parentAnchor)` — **one shared list per parent**, not per-attester. Edition filtering is applied at read time via `getSortedChunkByAddressList`.

The `getSortStaleness(sortInfoUID, parentAnchor)` function reports how many kernel items are unprocessed. Any attester may call `processItems` to advance the shared sorted list.

See [Lists and Collections](./06-Lists-and-Collections.md) for the full architecture.

## Schema Hierarchy
To represent a standard filesystem interaction where a file has a name within a folder:
1. **Parent Folder** (e.g., Anchor "memes") →
2. **File Anchor** (name: "vitalik.jpg", `refUID` points to Parent Folder) →
3. **DATA** (standalone, `refUID = 0x0`, holds `contentHash` and `size`) — placed at the file Anchor via a TAG.
4. **contentType key anchor + PROPERTY + TAG** (ADR-0035): `Anchor<PROPERTY>(refUID=DATA UID, name="contentType")` + `PROPERTY(value="image/jpeg")` + `TAG(definition=that anchor, refUID=that property)`.
5. **MIRROR** (`refUID` = DATA UID, `transportDefinition = /transports/onchain`, `uri = web3://0xABC`) — retrieval method.

All of steps 3–5 are typically batched into a single `multiAttest` transaction for atomicity. The PROPERTY placement in step 4 is itself three attestations (anchor + property + tag) but all fit in the same batch.
