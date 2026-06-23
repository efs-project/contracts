# Data Models and Schemas

EFS arranges its EAS schemas in three conceptual layers, adhering to the principles outlined in [System Architecture](./01-System-Architecture.md). The **Sepolia freeze set is nine schemas** — ANCHOR, DATA, MIRROR, PIN, TAG, PROPERTY, LIST, LIST_ENTRY, REDIRECT (SORT_INFO is documented below but **deferred / not in the freeze set**). These schemas interact through `refUID` links and edge attestations (PIN / TAG) to create a hierarchical, permissionless filesystem state natively on Ethereum. For details on how these are tracked, refer to the [Onchain Indexing Strategy](./03-Onchain-Indexing-Strategy.md).

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
- `forSchema` (bytes32) - Enforces what type of data can be attached to this anchor (e.g., Folder vs File vs Property).

**Write-time guards** (`EFSIndexer.onAttest`): `revocable` must be `false`; `expirationTime` must be `0` (anchors are permanent — EAS expiry is never honored); the payload must be the exact canonical `abi.encode(name, forSchema)` with no trailing bytes (else `NonCanonicalPayload`); `name` must pass canonical-name validation (below); names are unique per `(parent, name, forSchema)`.

**Details**: An Anchor represents a name (like a folder name or a file name) within a specific context. It references (is a child of) an attestation in its EAS `refUID` field. Other attestations reference these Anchors in their `refUID` fields when they need to be associated with that specific name. Names are considered unique within their direct hierarchy level relative to the parent entity.

### Canonical anchor-name encoding (NFC + percent-encode)

The `name` field carries the **canonical encoding** of a human-facing name, never the raw human string. The encoding is fixed so that independent clients deterministically resolve the same human name to the same anchor UID — the Schelling-point property. A name is encoded in two steps (ADR-0048, supersedes ADR-0025's reject-only rule):

1. **Unicode NFC normalization (client-side).** The human name is normalized to Unicode Normalization Form C. This collapses canonically-equivalent code-point sequences (e.g. precomposed `é` U+00E9 vs `e`+combining-acute U+0065 U+0301) to one form. **NFC is the client's responsibility** — the full NFC tables are far too large to run in Solidity, so the on-chain resolver does **not** and **cannot** verify normalization. Clients MUST normalize before encoding; a non-normalized input produces a different (still byte-valid) anchor that silently misses the intended Schelling point.
2. **Percent-encoding of the reserved set (client-side, then resolver-validated).** Every byte in the **reserved set** is replaced with `%XX` using **UPPERCASE** hex. All other bytes — including high-bit (≥ `0x80`) UTF-8 bytes for non-ASCII names — are left as-is.

**Reserved set** (must be percent-encoded):

- the C0 control range `0x00`–`0x1F` and DEL `0x7F`;
- space `0x20`;
- `%` (`0x25`) — itself, so an escape is unambiguous;
- the URI/path-special bytes: `"` `#` `&` `/` `:` `=` `?` `@` `[` `\` `]` `^` `` ` `` `{` `|` `}`.

**Unreserved set**: every other byte, used literally (ASCII letters, digits, `.` `-` `_` `~`, sub-delims like `!` `$` `'` `(` `)` `*` `+` `,` `;`, and all `≥ 0x80` UTF-8 bytes).

**Canonicalization rules enforced on-chain** (`EFSIndexer._isValidAnchorName`, single byte-pass, cheap): there is exactly **one** valid representation per name. The resolver **rejects**:

- empty names, and the reserved relative segments `.` and `..`;
- a **bare reserved byte** (it must be percent-encoded) — e.g. a literal space or `&`;
- a malformed or truncated escape — `%`, `%2`, `%ZZ`;
- a **lowercase-hex** escape — `%2f` is rejected; only `%2F` is canonical, so `%2f` and `%2F` can never both exist.

The resolver validates only the byte-level canonical form (percent-encoding + uppercase hex); NFC is trusted from the client per step 1.

**Worked example.** Human name `Q&A: Episode 5` → NFC (no change, already normalized) → percent-encode `&`, `:`, and the two spaces → on-chain `name` = `Q%26A%3A%20Episode%205`. A simple name like `readme.txt` has no reserved bytes and encodes to itself.

## 2. Property Schema
**Purpose**: Free-floating value attached to a container via PIN placement under a *key anchor*. Symmetric with DATA (see §3) — both are standalone values placed via an edge attestation, not via `refUID`.
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- `value` (string)

**Revocable**: `false` (ADR-0052) — a PROPERTY value is dumb, shared, *interned* content (an "anchor for a string"), not a claim. Many PINs can point at one value (best-effort dedup); nobody owns the value. Non-revocability is what makes a value safely shareable — a shared value can't be yanked out from under the other bindings that point at it. This is symmetric with DATA (§3): value = content, claim = edge. The revocable *claim* is the **PIN** (the binding): which container the value applies to, from which attester. Removal or change of a property is done by revoking or superseding the PIN, never the value (see Removal below). The reserved-key `contentHash`/`size` claims (ADR-0049) are likewise interned values bound by a PIN; retracting one means revoking its PIN.

**Write-time guards** (`EFSIndexer.onAttest`): `revocable` must be `false`; `expirationTime` must be `0`; `refUID` must be zero (standalone); the payload must be the exact canonical `abi.encode(value)` with no trailing bytes (else `NonCanonicalPayload`).

**Details**: Per ADR-0035 (superseded by ADR-0041 for the cardinality story), PROPERTY no longer carries a `key` field and no longer targets a container via `refUID`. Instead:

1. The **key** is the `name` of a PROPERTY-typed anchor (`forSchema = PROPERTY_SCHEMA_UID`) under the target container.
2. The **value** is the PROPERTY attestation's sole field.
3. The **binding** is a **PIN** with `definition = keyAnchorUID`, `refUID = propertyUID`. PIN is cardinality-1 (ADR-0041) — re-PINning the same key anchor from the same attester supersedes the previous binding in O(1).

`EFSIndexer.onAttest` enforces that PROPERTY is standalone (`refUID = 0x0`) and non-revocable (rejects `attestation.revocable`, exactly like ANCHOR and DATA) — no target-kind validation. On a successful attest it emits `PropertyCreated(propertyUID, attester, valueHash)` where `valueHash = keccak256(bytes(value))` is the value's canonical content key (ADR-0052; ties to the forthcoming canonical-hashing spec) — the indexed topic clients use to find an existing value to dedup against. The binding's per-attester singleton is a hard guarantee from `EdgeResolver._activeBySlot[keyAnchor][attester][PROPERTY_SCHEMA_UID]`; a revoked PIN is excluded from reads by default (ADR-0051), which is how a property is removed. Reads are lens-scoped per ADR-0014.

### Example — contentType on a DATA

```
DATA()                                                      // free-floating content identity (empty, ADR-0049)
  ↑ refUID
Anchor<PROPERTY>(name = "contentType", forSchema = PROPERTY) // key anchor under the DATA
  ↑ definition
PIN(refUID = propertyUID, attester = alice)                  // binding (cardinality 1)
  ↓
PROPERTY(value = "image/jpeg")                               // free-floating value
```

### Example — display name on an address

For address containers the key anchor is created with `recipient = addr` instead of `refUID` (specs/02 §1 permits this; ADR-0033 relies on it):

```
Anchor<PROPERTY>(recipient = 0xAbC…, name = "name", forSchema = PROPERTY)
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

The PROPERTY value is non-revocable interned content (ADR-0052) — removal and change happen at the **PIN** (the binding), never the value:

- **Unbind a slot:** revoke the PIN with `eas.revoke(pinUID)`. The binding is gone — the key anchor's slot becomes empty for that attester until a new PIN is attested, and the slot is excluded from default reads (ADR-0051). The shared value attestation is untouched and other bindings that point at it are unaffected.
- **Change a value:** attest a new PIN at the same slot pointing at a (new or existing, interned) PROPERTY; the old PIN is superseded automatically in O(1) (no extra revoke needed, ADR-0041).

A single value attestation may be shared across many bindings (best-effort dedup — the upload flow can hardlink an existing value rather than mint a new one). Because the value is non-revocable, sharing is safe: unbinding one PIN never withdraws the value from the others.

## 3. Data Schema
**Purpose**: Standalone file identity — pure, empty, non-revocable, location-independent.
**Field string**: `""` (empty — no fields)
**Structure**:
`refUID = 0x0 (standalone — no parent reference)`
- *(no fields)* — a DATA attestation's payload is zero-length.

**Revocable**: `false` — DATA is permanent. Once a file identity exists, it cannot be removed.

**Write-time guards** (`EFSIndexer.onAttest`): `revocable` must be `false`; `expirationTime` must be `0`; `refUID` must be zero (standalone); the payload must be **empty** (zero-length) — any bytes are rejected, keeping the empty-DATA canonical invariant.

**Details**: DATA is **pure identity** (ADR-0049). A DATA attestation asserts only "a file identity exists"; its EAS UID *is* the file's identity. DATA carries no fields — the on-wire payload is empty (zero-length). MIRRORs, folder placements (PIN), and metadata (PROPERTY) all reference the DATA **UID**, never a content hash. EFS is **not** content-addressed at the identity layer: two uploads of the same bytes get two distinct DATA UIDs.

DATA attestations are standalone (refUID = 0x0) and non-revocable. They represent file identity, not file location. A DATA is placed at a path via a PIN attestation (see Pin Schema below). The same DATA can be pinned into multiple paths by different attesters without duplication.

**`contentHash` and `size` are reserved-key PROPERTYs** (ADR-0049), not DATA fields. A content hash is client-supplied and unverifiable on-chain, so it is an attester *claim*, not authenticated identity. Each is bound to the DATA UID via the standard key-anchor + cardinality-1 PIN pattern (see §2), **lens-scoped per attester** — a reader trusts the hash/size from an attester they trust, and multiple coexisting claims (keccak, sha2-256, CID) may coexist. Reserved key anchor names: `contentHash`, `size` (and optionally `cid`). Hash values are self-describing (multibase multihash / CID) per the conventions spec.

Content-addressed *dedup* is therefore no longer an intrinsic on-chain index. Prevention is best-effort client-side (query the property index for a trusted `contentHash` claim before upload, then hardlink via a new PIN instead of a new DATA); resolution of an existing duplicate to a canonical DATA is the REDIRECT primitive (ADR-0050). The legacy `EFSIndexer.dataByContentKey` mapping is retained as a declared (storage-order-preserving) but unused/advisory slot — it is no longer written.

Other metadata (content type, description, version history) is likewise stored as PROPERTY attestations bound to the DATA UID. Retrieval URIs are stored as MIRROR attestations referencing the DATA UID.

## 3a. Mirror Schema
**Purpose**: Retrieval method for a DATA attestation — maps a transport type to a URI.
**Structure**:
`refUID = DATA UID`
- `transportDefinition` (bytes32) — Anchor UID for the transport type (e.g., `/transports/ipfs`)
- `uri` (string) — retrieval URI (e.g., `ipfs://QmXxx`, `ar://yyy`, `web3://0xABC`)

**Revocable**: `true`

**Write-time guards** (`MirrorResolver.onAttest`): `revocable` must be `true` (`NotRevocable`); `expirationTime` must be `0` (`HasExpiration`); the payload must be the exact canonical `abi.encode(transportDefinition, uri)` with no trailing bytes (else `NonCanonicalPayload`); `uri` must be non-empty (`InvalidData`) and ≤ `MAX_URI_LENGTH` (`URITooLong`) — **there is no URI scheme allowlist** (ADR-0056, see below); `transportDefinition` must be a `/transports` descendant (`InvalidTransport`); only the canonical MIRROR schema is accepted (foreign schemas → `WrongSchema`).

**Details**: MIRRORs attach retrieval methods to a DATA. The `MirrorResolver` contract validates that `refUID` points to a valid DATA attestation and `transportDefinition` points to a valid Anchor. No singleton enforcement — multiple mirrors per transport type per attester are allowed.

**No URI scheme allowlist** (ADR-0056, supersedes ADR-0023): the resolver does **not** restrict the URI scheme. A scheme check on an immutable contract is not a security boundary (an allowed `https://` mirror serves malicious HTML just as well), is trivially evaded (case / zero-width / whitespace / percent-encoding), is un-patchable, and can't anticipate future transports — so any non-empty, length-bounded URI under a valid `/transports` anchor is accepted, including `data:`, `javascript:`, and future schemes. **Scheme and render safety move entirely to the client** (sandboxed rendering; never render a raw mirror URI as a live link or navigate to it) — see `specs/overview.md` load-bearing invariants. The transport *vocabulary* still lives in `/transports/<scheme>` anchors (below), and length (`MAX_URI_LENGTH`) + transport-ancestry remain enforced.

### Transport Definition Anchors
Well-known transport types are created at deploy time under `/transports/` — fresh deploys seed **twelve** default transport definition anchors. New transports are added permissionlessly by authoring a `/transports/<scheme>` anchor (ADR-0011); the contract no longer gates the scheme set (ADR-0056):
- `/transports/onchain` — `web3://` URIs pointing to SSTORE2 chunk managers
- `/transports/arweave` — `ar://` URIs
- `/transports/ipfs` — `ipfs://` URIs
- `/transports/magnet` — `magnet:` URIs
- `/transports/https` — `https://` URIs
- `/transports/data` — RFC-2397 `data:` URIs for small inline mirrors (ADR-0063)
- `/transports/ftp` — `ftp://` URIs
- `/transports/s3` — `s3://` URIs
- `/transports/gs` — `gs://` URIs
- `/transports/dat` — `dat://` URIs
- `/transports/rsync` — `rsync://` URIs
- `/transports/bittorrent` — `bittorrent://` URIs

The transport preference order for serving keeps the original five ranked per ADR-0012: `web3://` (onchain) > `ar://` > `ipfs://` > `magnet:` > `https://`. Every other scheme (`data:` inline mirrors per ADR-0063, `ftp/s3/gs/dat/rsync/bittorrent`, and any future or arbitrary scheme post-ADR-0056) shares the lowest priority tier with `https://` (router `_getBestMirrorURI` `else` → priority 4) — so it is *served* but not *rankable* above the named five without a router change (the router is a redeployable view; per-transport priority as a `/transports` PROPERTY is the freeze-safe follow-up — ADR-0056 Consequences). All non-`web3://` schemes are served as `message/external-body` redirects; only **same-chain** `web3://` is read on-chain (SSTORE2) — a `web3://<addr>:<otherChainId>` mirror (chainId ≠ the router's chain) is redirected like the off-chain schemes, since the router can only `extcodecopy` contracts on its own chain (ADR-0058). See ADR-0012 for the priority rationale.

## 4. Pin Schema (cardinality 1)
**Purpose**: Singleton edge — at most one active PIN per `(attester, definition, targetSchema)` slot. Used for file placement, PROPERTY value binding, and any predicate where "this slot holds exactly one thing" is the right semantic. ADR-0041.
**Structure**:
`refUID = Target Attestation UID` or `recipient = Target Ethereum Address`
- `definition` (bytes32) — The Anchor UID that names the slot. For file placement, this is the path Anchor (e.g., the `cat.jpg` Anchor under `/memes/`). For PROPERTY value binding, this is the key anchor (e.g., the `contentType` anchor under a DATA).

**Revocable**: `true`

**Write-time guards** (`EdgeResolver.onAttest`): `revocable` must be `true` (`NotRevocable`); `expirationTime` must be `0` (`HasExpiration`); the payload must be exactly 32 bytes — `abi.encode(bytes32 definition)` — any other length is rejected (`NonCanonicalPayload`).

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

**Write-time guards** (`EdgeResolver.onAttest`): `revocable` must be `true` (`NotRevocable`); `expirationTime` must be `0` (`HasExpiration`); the payload must be exactly 64 bytes — `abi.encode(bytes32 definition, int256 weight)` — any other length is rejected (`NonCanonicalPayload`).

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
- **Effective TAG** — client-layer projection (ADR-0042). For the explorer's descriptive-label include/exclude filter (`FileBrowser.resolveTagSet`), an active TAG is *effective* iff `weight >= 0`. Negative-weight TAGs remain active on-chain but are suppressed for filter sets. `weight = 0` is effective. The same projection is also available to on-chain consumers with caller-chosen thresholds via `EFSFileView.getDirectoryPageFiltered(... excludeTagDefs[], minWeights[] ...)` (ADR-0054) — parallel arrays (one threshold per exclude tag, union across them), the view layer compares `weight >= minWeights[k]`; the kernel still never interprets weight (ADR-0041 §4).

This distinction applies only to the descriptive-label filter path. Folder visibility (ADR-0038), `hasActiveTagFromAny`, sort overlays, and all contract helpers use the kernel "active = unrevoked" definition unchanged.

### Choosing PIN vs TAG

| Predicate shape | Schema | Example |
|---|---|---|
| Singular value per `(attester, slot)` | **PIN** | File placement, contentType, name |
| List of values per `(attester, slot)` | **TAG** | Folder visibility, labels, vote sets |

If you write a PIN where a TAG is correct, the slot can only hold one value (subsequent writes supersede instead of accumulating). If you write a TAG where a PIN is correct, on-chain consumers can't read "the value" without ambiguity (which entry is canonical?). The schema choice is the API selector — pick deliberately.

## 5. Sort Info Schema

> **Deferred — NOT in the Sepolia freeze set.** SORT_INFO remains a working overlay design (see `07-Sort-Overlay-Architecture.md`); it is documented here but is not registered as a frozen schema in the nine-schema freeze set.

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
**Field string**: `"bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries"`
**Resolver**: `ListResolver` (validates shape; stateless)
**Revocable**: `false`

**Fields**:
- `allowsDuplicates` (bool) — if false, each identity key may appear at most once per attester's lens
- `appendOnly` (bool) — if true, entries may not be revoked (enforced at write time by `ListEntryResolver`)
- `targetType` (uint8) — `0` = ANY (opaque bytes32 key), `1` = ADDR (address in recipient), `2` = SCHEMA (attestation UID with schema check)
- `targetSchema` (bytes32) — required for SCHEMA mode (specifies which EAS schema the target attestation must belong to); must be `bytes32(0)` for ANY/ADDR modes
- `maxEntries` (uint256) — per-attester cap; `0` = unlimited. Must be nonzero when `appendOnly && allowsDuplicates` to bound storage. Widened from `uint32` (ADR-0047) so planet-scale lists (continental/global populations > 2³²) can declare a real cap; free under ABI 32-byte-word padding

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

## Schema 10: REDIRECT

**Purpose**: The trust-scoped "this points at that" primitive (ADR-0050): canonical/dedup-resolution for duplicate DATA, version supersession, and path symlinks. Because DATA is pure identity (ADR-0049), identical bytes mint distinct DATA UIDs; REDIRECT is how an attester asserts "B is the same as / redirects to A."
**Field string** (FROZEN): `"bytes32 target, uint16 kind"`
**Resolver**: `AliasResolver` (write-time guards only)
**Revocable**: `true` (a redirect can be retracted)

**Fields**:
- `target` (bytes32) — destination DATA or Anchor UID (must be nonzero, must not equal the source).
- `kind` (uint16) — redirect-class discriminator. `uint16` (not `uint8`) per ADR-0050: `kind` is an open-ended relationship *vocabulary*, not a counter, and widening is free (both pad to one ABI word). **Only the field string is frozen; the kind taxonomy is resolver logic + client convention (versioned/upgradeable), NOT part of the UID.**

`refUID` = the **source**: the duplicate DATA for `sameAs`/`supersededBy`; the source path Anchor for `symlink`.

**Kinds taxonomy** (initial — evolvable, not in the UID):
- `0 = sameAs` — strong dedup. Source + target both DATA. Followed at read time.
- `1 = supersededBy` — version replacement. Source + target both DATA. Followed at read time.
- `2 = symlink` — path → target. Source ANCHOR; target ANCHOR or DATA. Followed one hop.
- `3+ = reserved` — recorded but **not type-checked** by the resolver (e.g. `relatedVersion`: a weak discovery hint that is **never** auto-followed). Follow rules for these are decided by the read-time resolution spec, not the resolver.

**Write-time guards enforced by `AliasResolver`** (correctness before any mainnet burn):
- `a.schema == redirectSchemaUID` (self-derived in `initialize()` against the proxy address; rejects foreign schemas pointed at the resolver) else `WrongSchema`.
- payload exactly 64 bytes else `BadPayload`.
- `target != 0` else `ZeroTarget`.
- `target != source` (no trivial self-loop) else `SelfLoop`.
- Per-kind typing (source/target schemas read via `eas.getAttestation(uid).schema`):
  - `sameAs` (0) / `supersededBy` (1): both source and target must be DATA (`SourceNotData` / `TargetNotData`).
  - `symlink` (2): source must be an ANCHOR (`SourceNotAnchor`); target must be ANCHOR or DATA (`TargetNotAnchorOrData`).
  - `kind >= 3`: no typing (reserved); only the `target != 0` / `target != source` guards apply.

**Read-time resolution is client/spec, not the resolver.** The resolver enforces only **write-time** correctness (direct self-loops, typing). **Multi-hop cycle handling** (resolve to the lowest UID in the strongly-connected component — start-independent), **chain following**, **depth caps** (`D_MAX`), **lens precedence** (ADR-0031), and **kind-following rules** all live in the client/router + a later Durable resolution spec (ADR-0050 §"Write-time guards vs read-time resolution"). The resolver cannot afford to walk the graph on each write.

**Reverse fan-in** ("what points at me?") is intentionally not indexed on-chain by `AliasResolver` — it is the off-chain indexer's job (a future on-chain advisory index is addable as upgradeable logic; ADR-0050 §4).

**Symlink / hardlink mapping**: a *hardlink* (one DATA PINned at many path Anchors) is native and untouched — no follow, no cycle. A *symlink* is `REDIRECT kind=2`. *Canonical/dedup* is `REDIRECT kind=0` (`sameAs`).

See [ADR-0050](../docs/adr/0050-redirect-canonical-symlink-schema.md) for full design rationale.

## Schema Hierarchy
To represent a standard filesystem interaction where a file has a name within a folder:
1. **Parent Folder** (e.g., Anchor "memes") →
2. **File Anchor** (name: "vitalik.jpg", `refUID` points to Parent Folder) →
3. **DATA** (standalone, `refUID = 0x0`, empty payload — pure identity per ADR-0049) — placed at the file Anchor via a **PIN** (cardinality 1 per ADR-0041).
4. **contentType / contentHash / size key anchors + PROPERTY + PIN** (ADR-0035 + ADR-0041 + ADR-0049): e.g. `Anchor<PROPERTY>(refUID=DATA UID, name="contentType")` + `PROPERTY(value="image/jpeg")` + `PIN(definition=that anchor, refUID=that property)`. `contentHash` and `size` are reserved-key PROPERTYs bound the same way (ADR-0049), lens-scoped per attester.
5. **MIRROR** (`refUID` = DATA UID, `transportDefinition = /transports/onchain`, `uri = web3://0xABC`) — retrieval method.
6. **Folder-visibility TAGs** (ADR-0038) — for every generic ancestor folder on the path from the file's parent up to root exclusive, if the uploader has no active `TAG(definition=DATA_SCHEMA_UID, refUID=ancestor)` yet, emit one. Cardinality N (an attester contains many such folders).

All of steps 3–6 are typically batched into a single `multiAttest` transaction for atomicity. The PROPERTY placement in step 4 is itself three attestations (anchor + property + pin) but all fit in the same batch. Step 6 is steady-state zero-cost (walk exits at the first already-tagged ancestor).
