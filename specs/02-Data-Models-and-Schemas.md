# Data Models and Schemas

EFS uses nine core EAS schemas arranged in three conceptual layers, adhering to the principles outlined in [System Architecture](./01-System-Architecture.md). These schemas interact through `refUID` links and edge attestations (PIN / TAG) to create a hierarchical, permissionless filesystem state natively on Ethereum. For details on how these are tracked, refer to the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

**Three-layer architecture:**
- **Paths** (Anchors) — Schelling points for names and locations
- **Data** (DATA + PROPERTY) — Standalone file identity and metadata
- **Retrieval** (MIRROR) — Transport-specific URIs for fetching content

Files are placed at paths via **edge attestations** (PIN / TAG) rather than direct `refUID` linking. This decouples identity from location: the same DATA can appear at multiple paths, and multiple users can independently place different DATAs at the same path.

**Edge cardinality lives in the schema UID** (ADR-0041). EFS provides two sibling edge schemas, distinguished by their on-wire shape so the EAS-derived UIDs differ naturally:

- **PIN** — cardinality 1. At most one active PIN per `(attester, definition, targetSchema)` slot. Re-attesting at the same slot supersedes in O(1). Maps to `owl:FunctionalProperty` / `:db.cardinality/one`.
- **TAG** — cardinality N. List of active TAGs per slot, one entry per distinct `(attester, target, definition)` edge. Each entry carries an `int256 weight` for sort/score/ranking metadata. Maps to a regular OWL property / `:db.cardinality/many`.

A use case picks PIN or TAG based on the nature of its predicate. Smart-contract readers and subgraph indexers see the schema UID and know the API shape with zero EFS-specific logic.

## 1. Anchor Schema
**Purpose**: Acts as a "Schelling Point" or a shared naming reference for a given Topic.
**Structure**:
`refUID = Parent Anchor UID (or User Address / bytes32(0))`
- `name` (string)
- `schemaUID` (bytes32) - Enforces what type of data can be attached to this anchor (e.g., Folder vs File vs Property).

**Details**: An Anchor represents a name (like a folder name or a file name) within a specific context. It references (is a child of) an attestation in its EAS `refUID` field. Other attestations reference these Anchors in their `refUID` fields when they need to be associated with that specific name. Names are considered unique within their direct hierarchy level relative to the parent entity.

## 2. Property Schema
**Purpose**: Free-floating value attached to a container via PIN placement under a *key anchor*. Symmetric with DATA (see §3) — both are standalone values placed via an edge attestation, not via `refUID`.
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- `value` (string)

**Revocable**: `false` — PROPERTY is permanent, like DATA. The *binding* (which container the value applies to, from which attester) lives in the PIN and is the only thing that can move.

**Details**: Per ADR-0035 (superseded by ADR-0041 for the cardinality story), PROPERTY no longer carries a `key` field and no longer targets a container via `refUID`. Instead:

1. The **key** is the `name` of a PROPERTY-typed anchor (`schemaUID = PROPERTY_SCHEMA_UID`) under the target container.
2. The **value** is the PROPERTY attestation's sole field.
3. The **binding** is a **PIN** with `definition = keyAnchorUID`, `refUID = propertyUID`. PIN is cardinality-1 (ADR-0041) — re-PINning the same key anchor from the same attester supersedes the previous binding in O(1).

`EFSIndexer.onAttest` enforces only that PROPERTY is standalone (`refUID = 0x0`) and non-revocable — no target-kind validation. Per-attester singleton is a hard guarantee from `EdgeResolver._activeBySlot[keyAnchor][attester][PROPERTY_SCHEMA_UID]`. Reads are lens-scoped per ADR-0014.

### Example — contentType on a DATA

```
DATA(contentHash = …, size = 42)                            // free-floating content identity
  ↑ refUID
Anchor<PROPERTY>(name = "contentType", schemaUID = PROPERTY) // key anchor under the DATA
  ↑ definition
PIN(refUID = propertyUID, attester = alice)                  // binding (cardinality 1)
  ↓
PROPERTY(value = "image/jpeg")                               // free-floating value
```

### Example — display name on an address

For address containers the key anchor is created with `recipient = addr` instead of `refUID` (specs/02 §1 permits this; ADR-0033 relies on it):

```
Anchor<PROPERTY>(recipient = 0xAbC…, name = "name", schemaUID = PROPERTY)
  ↑ definition
PIN(refUID = propertyUID, attester = alice)
  ↓
PROPERTY(value = "Vitalik Buterin")
```

### Reserved key anchors

- `"contentType"` — MIME type of a DATA (see ADR-0005 → ADR-0035 → ADR-0041).
- `"name"` — human-readable display name for any container (see ADR-0034). Clients render the hierarchy `ENS reverse-lookup (addresses only) → "name" key anchor resolved via PIN + PROPERTY scoped to the active lenses → short-hex fallback`.

Other common (non-reserved) key anchors: `"previousVersion"` (value is a DATA UID of the prior version), `"description"`, `"icon"`.

### Removal

Revoke the PIN with `eas.revoke(pinUID)`. The PROPERTY value itself is non-revocable (permanent), but the binding is gone — the key anchor's slot becomes empty for that attester until a new PIN is attested. Replacing the value is just a new PIN at the same slot pointing at a new PROPERTY; the old PIN is superseded automatically (no extra revoke needed).

## 3. Data Schema
**Purpose**: Standalone file identity — content-addressed, non-revocable, location-independent.
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- `contentHash` (bytes32) — keccak256 of the canonical file bytes
- `size` (uint64) — byte count

**Revocable**: `false` — DATA is permanent. Once a file identity exists, it cannot be removed.

**Details**: DATA attestations are standalone (refUID = 0x0). They represent file identity, not file location. A DATA is placed at a path via a PIN attestation (see Pin Schema below). The same DATA can be pinned into multiple paths by different attesters without duplication.

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

## 4. Pin Schema (cardinality 1)
**Purpose**: Singleton edge — at most one active PIN per `(attester, definition, targetSchema)` slot. Used for file placement, PROPERTY value binding, and any predicate where "this slot holds exactly one thing" is the right semantic. ADR-0041.
**Structure**:
`refUID = Target Attestation UID` or `recipient = Target Ethereum Address`
- `definition` (bytes32) — The Anchor UID that names the slot. For file placement, this is the path Anchor (e.g., the `cat.jpg` Anchor under `/memes/`). For PROPERTY value binding, this is the key anchor (e.g., the `contentType` anchor under a DATA).

**Revocable**: `true`

**Cardinality**: 1. Re-PINning the same `(attester, definition, targetSchema)` slot supersedes the prior PIN in O(1) — `EdgeResolver._activeBySlot` updates atomically and the prior PIN's edge entry is cleared from the active map.

**Details**: PIN maps to `owl:FunctionalProperty` / Datomic `:db.cardinality/one` / a singular GraphQL field. Smart-contract readers can call `getActivePin(definition, attester, targetSchema) → bytes32 pinUID` and `getActivePinTarget(...) → bytes32 targetID` for O(1) reads — no scanning, no newest-by-time disambiguation.

PIN targets either an attestation (via `refUID`) or an address (via `recipient`), keeping the custom payload minimal (just `definition`). The `EdgeResolver` contract is the schema's resolver and maintains both the per-slot singleton (`_activeBySlot`) and the shared discovery indices (children-with-edge, definitions-by-target, targets-by-definition).

### Use cases

- **File placement** — `PIN(refUID = DATA_UID, definition = file_Anchor)`. Each `(attester, file_Anchor)` slot holds one DATA. Re-uploading supersedes.
- **PROPERTY value binding** — `PIN(refUID = PROPERTY_UID, definition = key_Anchor)`. Each `(attester, key_Anchor)` slot holds one current value. Used for `contentType`, `name`, `description`, etc.
- **Schema-alias canonical pin** — points at the canonical schema-alias anchor for a schema UID (ADR-0033).

### Removal

Call `eas.revoke(pinUID)`. `EdgeResolver.onRevoke` clears the slot if the revoked UID matches the currently-held `pinUID`. Replacing a PIN at the same slot does not require a separate revoke — the new PIN supersedes the prior one automatically.

## 4a. Tag Schema (cardinality N)
**Purpose**: List-shaped edge — accumulates one entry per distinct `(attester, target, definition)` triple. Used for folder visibility, schema-alias discovery, descriptive labels (`#nsfw`, `#favorites`), and any predicate where "this category contains N things" is the right semantic. ADR-0041.
**Structure**:
`refUID = Target Attestation UID` or `recipient = Target Ethereum Address`
- `definition` (bytes32) — The Anchor UID, schema UID, or other bytes32 that names the category.
- `weight` (int256) — Generic per-entry metadata. Sort key, score, ranking, vote weight, recency — the kernel does not interpret it; consumers and sort overlays (see [07-Sort-Overlay-Architecture.md](./07-Sort-Overlay-Architecture.md)) read it inline alongside the entry's UID.

**Revocable**: `true`

**Cardinality**: N. Each `(attester, target, definition)` is a distinct edge; re-attesting the same triple updates the entry's UID and weight in place (no new entry, no duplication). Different targets under the same `(attester, definition)` accumulate as independent entries.

**Details**: TAG maps to a regular OWL property / Datomic `:db.cardinality/many` / a list GraphQL field. The `EdgeResolver` contract holds the active set as `TagEntry[]` in `_activeByAAS[definition][attester][targetSchema]` — a struct array of `(tagUID, weight)` tuples. On-chain consumers can fetch the full list with weights in one bulk SLOAD via `getActiveTagEntries(...)`, then sort by weight in memory without an N+1 SLOAD pattern.

`weight` composes with — does not replace — SORT_INFO. SORT_INFO declares which sort scheme a folder uses; "by edge weight ascending" becomes one option among several available sort functions. A TAG that doesn't care about ordering simply writes any weight (`1` is fine) and ignores it on the read side.

### Use cases

- **Folder visibility** (ADR-0038) — `TAG(refUID = folder_Anchor, definition = dataSchemaUID, weight = 1)`. An attester can mark many folders as containing their content; the upload flow walks ancestors and emits one per uncovered subtree.
- **Schema-alias discovery walk** — every alias anchor for a schema is a separate TAG entry; the discovery walk paginates through them.
- **Descriptive labels** — `TAG(refUID = DATA_UID, definition = /tags/nsfw, weight = score)`. A target can carry many labels.

### Tag Definitions as Anchors
Tag definitions for descriptive labels are stored as normal Anchors under a reserved `/tags/` folder (created at deploy time). For example, the "nsfw" tag definition is `resolvePath(tagsAnchorUID, "nsfw")`. The UI hides `/tags/` from standard browsing while keeping definitions discoverable. Folder-visibility TAGs use the schema UID itself as the definition — no `/tags/` anchor required.

### Lens-Specific Tagging (DATA UID Targeting)
When tagging files (descriptive labels), TAGs should target the **DATA attestation UID** (the specific lens) rather than the Anchor UID (the shared filename). This is critical because multiple users can attach different DATA attestations to the same file Anchor, and each lens should be independently taggable.

**Example**: User A and User B both have a `test.txt` file (same Anchor). User A tags their DATA attestation as "nsfw". Because the tag targets User A's DATA UID specifically, User B's lens is not affected.

For folder-level descriptive tags (e.g., marking a folder as "important"), the TAG targets the Anchor UID directly since folders have no per-user DATA attestations.

### Removal

Call `eas.revoke(tagUID)`. `EdgeResolver.onRevoke` swap-and-pops the entry from `_activeByAAS`. There is no `applies = false` mechanism (removed in ADR-0041) — TAGs follow the standard EAS revoke lifecycle.

Complex aggregation logic (Sybil resistance, reputation weighting, running averages) is delegated to upper-layer indexers and client UIs, not computed on-chain.

### Active vs Effective (client convention)

Two distinct concepts used in the codebase:

- **Active TAG** — kernel concept (ADR-0041 §4). A TAG is active if and only if it exists on-chain and is not EAS-revoked. Weight does not affect activity; `weight = -999` is still active.
- **Effective TAG** — client-layer projection (ADR-0042). For the explorer's descriptive-label include/exclude filter (`FileBrowser.resolveTagSet`), an active TAG is *effective* iff `weight >= 0`. Negative-weight TAGs remain active on-chain but are suppressed for filter sets. `weight = 0` is effective.

This distinction applies only to the descriptive-label filter path. Folder visibility (ADR-0038), `hasActiveTagFromAny`, sort overlays, and all contract helpers use the kernel "active = unrevoked" definition unchanged.

### Choosing PIN vs TAG

| Predicate shape | Schema | Example |
|---|---|---|
| Singular value per `(attester, slot)` | **PIN** | File placement, contentType, name |
| List of values per `(attester, slot)` | **TAG** | Folder visibility, labels, vote sets |

If you write a PIN where a TAG is correct, the slot can only hold one value (subsequent writes supersede instead of accumulating). If you write a TAG where a PIN is correct, on-chain consumers can't read "the value" without ambiguity (which entry is canonical?). The schema choice is the API selector — pick deliberately.

## 5. Sort Info Schema
**Purpose**: Declares a named sort overlay attached to a directory or list.
**Structure**:
`refUID = Naming Anchor UID — the Anchor is a child of the directory being sorted (anchorSchema = SORT_INFO_SCHEMA)`
- `sortFunc` (address) — `ISortFunc` comparator contract. Implements `isLessThan(a, b, sortInfoUID)` and `getSortKey(uid, sortInfoUID)`.
- `targetSchema` (bytes32) — Which Anchor schema to sort. `bytes32(0)` = all children. `DATA_SCHEMA` = file anchors only.
- `sourceType` (uint8) — Source-list selector for what gets sorted. Reserved for future variants (kernel-shared vs per-attester children); current default is 0.
- Revocable: `true` — revoking signals "I'm done maintaining this sort; hide from menu"

**Details**: A SORT_INFO attestation names a sort by creating a naming Anchor as a child of the directory. The naming Anchor's `anchorSchema = SORT_INFO_SCHEMA` distinguishes it from file Anchors. The `EFSSortOverlay` contract is the resolver — it validates the `sortFunc` address and caches the sort config. The sorted data lives in the sort overlay's linked lists keyed by `(sortInfoUID, parentAnchor)` — **one shared list per parent**, not per-attester. Lens filtering is applied at read time via `getSortedChunkByAddressList`.

The `getSortStaleness(sortInfoUID, parentAnchor)` function reports how many kernel items are unprocessed. Any attester may call `processItems` to advance the shared sorted list.

See [Lists and Collections](./06-Lists-and-Collections.md) for the full architecture.

---

## Schema 8: LIST

**Purpose**: Declares a curated collection. Permanent identity — non-revocable like DATA.
**Field string**: `"bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries"`
**Resolver**: `ListResolver` (validates shape; stateless)
**Revocable**: `false`

**Fields**:
- `allowsDuplicates` (bool) — if false, each identity key may appear at most once per attester's lens
- `appendOnly` (bool) — if true, entries may not be revoked (enforced at write time by `ListEntryResolver`)
- `targetType` (uint8) — `0` = ANY (opaque bytes32 key), `1` = ADDR (address in recipient), `2` = SCHEMA (attestation UID with schema check)
- `targetSchema` (bytes32) — required for SCHEMA mode (specifies which EAS schema the target attestation must belong to); must be `bytes32(0)` for ANY/ADDR modes
- `maxEntries` (uint32) — per-attester cap; `0` = unlimited. Must be nonzero when `appendOnly && allowsDuplicates` to bound storage

**Identity key by mode**:
- ANY: `target` field (must be nonzero)
- ADDR: `bytes32(uint256(uint160(recipient)))` — `address(0)` maps to `bytes32(0)`, which is valid
- SCHEMA: `target` field (the attestation UID; existence + schema checked at write time)

**Constraints enforced by `ListResolver`**:
- Payload must be exactly 160 bytes (5 × 32)
- `revocable` must be false; `expirationTime` must be 0; `refUID` must be zero; `recipient` must be zero
- `targetType <= 2`; SCHEMA mode requires nonzero `targetSchema`; non-SCHEMA modes require zero `targetSchema`
- `appendOnly && allowsDuplicates` requires `maxEntries != 0`

**Note**: A LIST attestation's UID is the permanent list identity — pass it as `listUID` in LIST_ENTRY attestations and in `ListReader` calls.

---

## Schema 9: LIST_ENTRY

**Purpose**: One entry in a curated LIST — pure membership identity (ADR-0046). Revocable (unless the list is `appendOnly`).
**Field string**: `"bytes32 listUID, bytes32 target"`
**Resolver**: `ListEntryResolver` (write-time enforcement + wide EntryRecord[] storage)
**Revocable**: `true`

**Fields**:
- `listUID` (bytes32) — UID of the LIST attestation this entry belongs to (must be nonzero)
- `target` (bytes32) — encoding depends on list's `targetType` (see LIST schema above)

**Order and labels** (ADR-0046): a LIST_ENTRY carries no inline ordering or metadata. Ordering and free-text labels are PIN-bound (cardinality-1) PROPERTYs placed on the **entry UID** (`"weight"` = decimal-string rank, `"name"` = arbitrary-length label), via the standard `Anchor<PROPERTY> + PIN + PROPERTY` pattern. Because the mutable value lives in a PROPERTY rather than the entry, reordering re-PINs the order PROPERTY in O(1) **without churning the entry UID**, so attached labels survive. Sorting is client-side, reading the per-entry order PROPERTY (lens-scoped). This makes LIST_ENTRY symmetric with DATA (pure identity; `contentType`/`name` hang off it as PROPERTYs).

**Storage**: `ListEntryResolver` maintains per-`(listUID, attester)` `EntryRecord[]` arrays with inline `identityKey` (wide storage, ADR-0041 pattern). Swap-and-pop gives O(1) removal. A separate `_entryCount[listUID][identityKey][attester]` counter enables O(1) duplicate detection and the `countOf` membership test.

**LIST declaration caching**: `ListEntryResolver` caches the decoded LIST declaration after first touch (stored in `_decl[listUID]`). LIST attestations are non-revocable, so the cache is permanently valid — no re-fetching needed.

**Constraints enforced by `ListEntryResolver`**:
- Payload exactly 64 bytes (2 × 32); `revocable` must be true; `expirationTime` must be 0; `refUID` must be zero
- `listUID` must reference a real LIST attestation (schema check)
- Per-mode encoding checks (see LIST identity key table above)
- SCHEMA mode: target attestation must exist and must have `schema == list.targetSchema`
- No-duplicates: rejected if `_entryCount != 0` and `!allowsDuplicates`
- Cap: rejected if `_entries[list][attester].length >= maxEntries` and `maxEntries != 0`
- Revocation blocked if `list.appendOnly`; silent no-op if entry is already removed (`_entryPosPlusOne == 0`)

**ListReader** (view contract, stateless, redeployable): `getMode(listUID)`, `length(listUID, attester)`, `entries(listUID, attester, start, len)`, `countOf(listUID, attester, identityKey)`, plus typed accessors `targetAsAddress`, `targetAsUID`, `targetAsMemberKey` and pure helpers `identityKeyForAddress`, `identityKeyForUID`, `identityKeyForMemberKey`.

See [ADR-0044](../docs/adr/0044-list-and-list-entry-schemas.md) and [Lists and Collections](./06-Lists-and-Collections.md) for full design rationale.

## Schema Hierarchy
To represent a standard filesystem interaction where a file has a name within a folder:
1. **Parent Folder** (e.g., Anchor "memes") →
2. **File Anchor** (name: "vitalik.jpg", `refUID` points to Parent Folder) →
3. **DATA** (standalone, `refUID = 0x0`, holds `contentHash` and `size`) — placed at the file Anchor via a **PIN** (cardinality 1 per ADR-0041).
4. **contentType key anchor + PROPERTY + PIN** (ADR-0035 + ADR-0041): `Anchor<PROPERTY>(refUID=DATA UID, name="contentType")` + `PROPERTY(value="image/jpeg")` + `PIN(definition=that anchor, refUID=that property)`.
5. **MIRROR** (`refUID` = DATA UID, `transportDefinition = /transports/onchain`, `uri = web3://0xABC`) — retrieval method.
6. **Folder-visibility TAGs** (ADR-0038) — for every generic ancestor folder on the path from the file's parent up to root exclusive, if the uploader has no active `TAG(definition=DATA_SCHEMA_UID, refUID=ancestor)` yet, emit one. Cardinality N (an attester contains many such folders).

All of steps 3–6 are typically batched into a single `multiAttest` transaction for atomicity. The PROPERTY placement in step 4 is itself three attestations (anchor + property + pin) but all fit in the same batch. Step 6 is steady-state zero-cost (walk exits at the first already-tagged ancestor).
