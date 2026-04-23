# ADR-0041: PIN/TAG schema split for cardinality, with weighted edges

**Status:** Accepted
**Date:** 2026-04-22
**Permanence-tier:** Etched
**Supersedes:** ADR-0035 (PROPERTY-as-TAG-placed singleton claim)
**Related:** ADR-0003 (TAG-based placement), ADR-0007 (`_activeByAttesterAndSchema` swap-and-pop), ADR-0009 (append-only kernel), ADR-0014 (edition-scoped PROPERTY lookup), ADR-0034 (`name` PROPERTY), ADR-0038 (tag-only folder visibility)

## Context

ADR-0035 §3 stated that PROPERTY value rebinds were superseded in O(1) by `TagResolver._activeByAAS[keyAnchor][attester][PROPERTY_SCHEMA_UID]` "per-attester singleton semantics" and called this load-bearing. **The claim was incorrect.** `_activeByAAS` is an append-only array keyed by `compositeHash = keccak256(attester, targetID, definition)`. A value *change* uses a new PROPERTY attestation (new UID → new `targetID`), so the new TAG fires a fresh compositeHash and **pushes** a new entry rather than overwriting the old one. Observed: `PropertiesModal` rendered whichever entry happened to sit at index 0 — in steady state, the oldest push.

A defensive client-side fix (newest-by-EAS-time scan) shipped immediately, but that is O(N) and unusable for on-chain consumers — which defeats PROPERTY's purpose as a contract-readable config-value primitive.

The deeper problem ADR-0035 surfaced: **TAG was overloaded with two semantics.**

- **Shape A — "this slot holds exactly one thing"** (singleton). Examples: file placement at a path anchor, PROPERTY value binding under a key anchor (`contentType`, `name`, `description`, …), pinning the canonical schema-alias anchor for a schema.
- **Shape B — "this category contains N things"** (list). Examples: folder visibility (`TAG(definition=dataSchemaUID, refUID=folder)` per ADR-0038), schema-alias discovery walks, descriptive labels under `/tags/` (`#nsfw`, `#favorites`).

The conflation produced ADR-0035's confidently-wrong singleton claim. Either the kernel encodes one shape and breaks the other, or it encodes neither and pushes the disambiguation onto every consumer (including subgraph indexers, who'd then have to know the EFS-specific convention "PROPERTY rebinds use the newest by EAS time, but folder visibility uses the full set" — exactly the "weird EFS thing" we want to avoid).

### Cardinality is a coordination point

Cardinality of an edge predicate cannot live on the individual attestation. If Alice writes "singleton" and Bob writes "list" for the same `(definition, schema)`, the kernel cannot reconcile — there is no canonical answer to "what shape is this slot." Smart contracts need to know **at compile time** whether to call `read(x) → value` or `read(x) → value[]`; these are completely different APIs. The cardinality declaration must therefore be:

- **Permanent** (everyone agrees once, forever)
- **Coordinated** (one declaration per predicate, not per assertion)
- **Machine-readable** (subgraphs/exporters can derive types from it)
- **Located higher than the individual edge** (it's a predicate property, not an edge property)

The only slot in EFS that satisfies all four is **the EAS schema UID itself.** EAS schemas are immutable; their UIDs are the strongest globally-coordinated identifiers EFS has access to. Anything else — convention, metadata anchor, runtime PROPERTY — is mutable state layered on top of mutable state.

## Decision

### 1. Two sibling schemas, distinct by field signature

Split TAG into **PIN** and **TAG**. Both schemas describe an edge from an attester to a target under a definition (predicate). They differ only in cardinality, which lives in the schema UID.

```
PIN  schema:  bytes32 definition
              revocable: true
              resolver:  EdgeResolver

TAG  schema:  bytes32 definition, int256 weight
              revocable: true
              resolver:  EdgeResolver
```

PIN has one field; TAG has two. The on-wire shapes differ → the EAS-derived UIDs differ naturally with no field-name juggling. The resolver branches on `attestation.schema` *before* decoding to apply the right shape.

| Concept | OWL / RDF | Datomic | Neo4j | GraphQL |
|---|---|---|---|---|
| **PIN** | `owl:FunctionalProperty` | `:db.cardinality/one` | property edge with uniqueness constraint | singular field |
| **TAG** | regular property | `:db.cardinality/many` | weighted edge | list field |

A consumer (smart contract or subgraph indexer) reads the schema UID and knows the API shape with zero EFS-specific logic.

### 2. Targeting via native EAS fields

Both schemas carry only the predicate (`definition`) and, for TAG, a per-entry `weight`. The **target** of the edge is conveyed via native EAS fields on every attestation:

- `refUID = target attestation UID` (most common — points at a DATA, an Anchor, a PROPERTY, etc.)
- `recipient = target address` (when the target is an Ethereum address — addresses don't have attestation UIDs)

The resolver collapses both into a single `targetID`:

```solidity
function _resolveTargetID(bytes32 refUID, address recipient) private pure returns (bytes32) {
    if (refUID != EMPTY_UID) return refUID;
    if (recipient != address(0)) return bytes32(uint256(uint160(recipient)));
    revert MustTargetSomething();
}
```

This keeps the schema payload minimal and reuses primitives every EAS consumer already understands.

### 3. `int256 weight` on TAG (replaces the old `applies: bool`)

TAG carries a single `int256 weight` field. It is **generic per-entry metadata** that consumers and overlays can read — sort key, score, ranking, vote weight, recency, whatever a use case wants. The kernel does not interpret it; it stores it inline alongside the entry's UID so on-chain consumers can read `(uid, weight)` tuples in one bulk SLOAD.

This composes with — does not replace — SORT_INFO. SORT_INFO continues to declare *which* sort scheme a folder uses (sort function + target schema). `weight` becomes one new sort source available to sort overlays; existing schemes (alphabetical-by-name PROPERTY, by attestation time, etc.) continue to work via different sort functions.

### 4. No "supersede via negative weight"; removal is always EAS revoke

Earlier drafts of this design proposed using `weight ≤ 0` as a supersede signal (a widening of the old `applies: bool`). That coupling was rejected: it conflates two orthogonal concepts (existence vs. ranking) and it breaks the Datomic / OWL mental model where a property assertion *exists* or *doesn't*, distinct from any value the property carries.

**Either the edge exists (active) or it doesn't.** Removal is always via `eas.revoke()` on the attestation UID. Replacement is always via re-attestation at the same slot (PIN) or `edgeHash` (TAG) — `_onAttestPin` supersedes a prior PIN at the same slot when the target differs; `_onAttestTag` updates an existing entry's UID and weight in place when the same `edgeHash` re-attests.

### 5. One shared resolver contract: `EdgeResolver`

PIN and TAG describe the same shape of edge. They differ only in cardinality of the active set. Implementing them as **one shared resolver** means:

- Identical write-time index maintenance (same `_activeEdge`, `_activeCount`, `_edgeDefinitions`, `_targetsByDef`, `_childrenWithEdge` across both schemas).
- One mental model for kernel maintainers: "edges have an active set; cardinality determines storage shape."
- Reader APIs differ by name only (`getActivePin` vs `getActiveTags`), not by underlying machinery.

Conceptually: there is one edge primitive, dressed up as two schemas at the EAS layer to encode cardinality permanently.

### 6. Schema-aware edge hashes prevent cross-schema state corruption

The shared bookkeeping is **schema-aware**: `_edgeHash(attester, targetID, definition, schema)` includes the schema UID. PIN and TAG entries at the same `(attester, target, definition)` triple occupy independent slots in the active-edge map and cannot corrupt each other's state. Aggregate counts that intentionally sum across schemas (`_activeCount`, `_activeTotalByDefAndAttester`) use a schema-blind `_targetDefHash(targetID, definition)` and compose correctly because each schema's `wasActive` check is isolated.

Without this, mixing PIN and TAG at a single triple silently overwrites bookkeeping — a class of bug that is invisible until a downstream consumer trips it. Schema-awareness is the load-bearing invariant of the shared resolver design.

### 7. Per-schema active-set storage

```solidity
// PIN: cardinality 1, O(1) singleton per slot.
struct SlotEntry { bytes32 pinUID; bytes32 targetID; }
mapping(bytes32 def => mapping(address attester => mapping(bytes32 schema => SlotEntry)))
    private _activeBySlot;

// TAG: cardinality N, O(1) append + swap-and-pop list per slot.
struct TagEntry { bytes32 tagUID; int256 weight; }
mapping(bytes32 def => mapping(address attester => mapping(bytes32 schema => TagEntry[])))
    private _activeByAAS;
mapping(bytes32 def => mapping(address attester => mapping(bytes32 schema => mapping(bytes32 edgeHash => uint256))))
    private _activeByAASIndex;  // index+1; 0 = absent
```

`_activeByAAS` was widened from `bytes32[]` to `TagEntry[]` (struct-of-tuple storage) so on-chain consumers can read the full list with weights in one bulk SLOAD per slot. The alternative — plain `bytes32[]` plus a side `_weightByTag` map — would force any sort-by-weight reader into an N+1 SLOAD pattern (one for the array slot, one per entry to fetch its weight) that collides with block gas limits on long lists. Each TAG insertion now writes ~2 storage slots instead of 1 (≈+20k gas cold, ≈+5k warm); folder-visibility TAGs (ADR-0038) pay this even though they don't sort by weight, but those writes are rare (one per first-upload-into-a-new-subtree per attester) so the absolute cost is bounded.

### 8. Reader APIs

```solidity
// PIN — singular value
function getActivePin(bytes32 def, address attester, bytes32 targetSchema)
    external view returns (bytes32 pinUID);
function getActivePinTarget(bytes32 def, address attester, bytes32 targetSchema)
    external view returns (bytes32 targetID);
function getActivePinSlot(bytes32 def, address attester, bytes32 targetSchema)
    external view returns (SlotEntry memory);

// TAG — list
function getActiveTagEntries(bytes32 def, address attester, bytes32 schema, uint256 start, uint256 length)
    external view returns (TagEntry[] memory);
function getActiveTags(bytes32 def, address attester, bytes32 schema, uint256 start, uint256 length)
    external view returns (bytes32[] memory);                  // weights dropped
function getActiveTagsCount(bytes32 def, address attester, bytes32 schema)
    external view returns (uint256);

// Shared (PIN ∪ TAG)
function isActiveEdge(address attester, bytes32 targetID, bytes32 definition, bytes32 schema)
    external view returns (bool);                              // schema-specific
function isActiveEdgeAnySchema(address attester, bytes32 targetID, bytes32 definition)
    external view returns (bool);                              // PIN ∪ TAG (two SLOADs)
function hasActiveEdge(bytes32 targetID, bytes32 definition)
    external view returns (bool);                              // any attester, any schema
function hasActiveEdgeFromAny(bytes32 targetID, bytes32 definition, address[] attesters)
    external view returns (bool);                              // edition-scoped
function getEdgeDefinitions(bytes32 targetID, uint256 start, uint256 length)
    external view returns (bytes32[] memory);
function getTargetsByDefinition(bytes32 definition, uint256 start, uint256 length)
    external view returns (bytes32[] memory);
function getChildrenWithEdge(bytes32 parentUID, bytes32 definition, uint256 start, uint256 length)
    external view returns (bytes32[] memory);
```

Reader names are explicit about the cardinality the caller is asking for — there is no "give me whichever is there" ambiguity. A consumer that mismatches schema and reader gets a zero / empty result, not corrupted state.

### 9. Mapping decisions to use cases

| Use case | Schema | Why |
|---|---|---|
| File placement (DATA at file Anchor) | **PIN** | Each `(attester, file)` slot holds one DATA. Re-upload supersedes. |
| `contentType` value binding | **PIN** | One MIME type per attester per DATA. |
| `name` / `description` / `icon` value binding | **PIN** | One value per attester per container. |
| Schema-alias canonical pin | **PIN** | One canonical alias anchor per schema per attester. |
| Folder visibility (`TAG(def=dataSchemaUID, refUID=folder)`, ADR-0038) | **TAG** | An attester contains many such folders. |
| Schema-alias discovery walk | **TAG** | A schema may have many aliases over time. |
| Descriptive labels (`#nsfw`, `#favorites`, future) | **TAG** | A target carries many labels. |

Use-case authors pick PIN or TAG based on the nature of their predicate. The kernel does not enforce cross-schema consistency — a PIN and a TAG with the same `(def, attester, schema)` live in independent storage and read independently.

## Consequences

**Enables**

- **O(1) reads for Shape A consumers.** `getActivePinTarget` returns the current value in one SLOAD. The defensive newest-by-time scan in `EFSRouter._getContentType` and frontend `PropertiesModal` collapses to a single read. On-chain consumers of PROPERTY values are now feasible.
- **TAG list semantics preserved for Shape B.** Folder visibility, schema-alias discovery, descriptive labels continue to accumulate naturally.
- **Subgraph / exporter friendliness.** PIN maps to `:db.cardinality/one` / `owl:FunctionalProperty` / singular GraphQL field; TAG maps to `:db.cardinality/many` / regular property / list GraphQL field. The schema UID is the API selector with zero EFS-specific decoding.
- **Cross-schema corruption impossible.** Schema-aware `_edgeHash` isolates PIN and TAG state at the same triple. The same attester can write both a PIN and a TAG at the same `(target, definition)` and they coexist cleanly.
- **`int256 weight` opens a generic ranking primitive.** Sort overlays gain a new sort source; vote weight, score, recency, and other per-entry metadata fit naturally without new schemas.

**Costs**

- **New schema UIDs for PIN and TAG.** Both differ from the old TAG schema. Pre-launch — no on-chain data is affected, but `deployedContracts.ts` regenerates and the pinned Sepolia fork (ADR-0037) coordinates the change across environments.
- **TagResolver renamed → EdgeResolver.** Function names that referenced "tag" in the kernel pre-PR are renamed to "edge" where they describe the shared primitive. Per-schema reader names (`getActivePin*`, `getActiveTags*`) replace the single overloaded `getActiveTargetsByAttesterAndSchema`. A few legacy aliases remain (`getActiveTargetsByAttesterAndSchema*`) for callers still on the old name.
- **TAG insertion writes ~2 storage slots instead of 1.** ≈+20k cold / ≈+5k warm gas. Bounded — folder-visibility TAGs are rare (ancestor walk exits early).
- **Cardinality is permanent per predicate.** Once a use case picks PIN vs TAG, that choice cannot be downgraded without a new schema and a new resolver wiring. This is a feature, not a bug — it is the coordination guarantee the entire design is built on.
- **No `applies: bool`.** Removal is `eas.revoke()`; replacement is re-attestation at the same slot or edgeHash. Use cases that wrote `applies=false` to express "I take this back" must call `revoke` instead. This is closer to the EAS native model and removes a TAG-specific concept from the public API.

**Load-bearing**

- **Cardinality lives in the schema UID.** This is the only permanent, coordinated, machine-readable, predicate-level slot in EFS. Anything that tries to encode cardinality elsewhere (per-attestation, per-anchor metadata, runtime PROPERTY) fails the coordination test. **AGENTS.md hardened invariant.**
- **Schema-aware `_edgeHash`.** Required to keep PIN and TAG at the same triple from corrupting each other. Removal of the `schema` term from `_edgeHash` is a Tier-1 change.
- **`_activeByAAS` is `TagEntry[]` (struct-of-tuple), not `bytes32[]` plus side weight map.** Required for single-SLOAD bulk reads and on-chain sort feasibility. Splitting weight into a side map is a Tier-1 change.

## Alternatives considered

1. **`cardinality: bool` (or `singleton: bool`) field on the TAG attestation.** Rejected. Fails the coordination test (Alice and Bob can disagree per attestation; no canonical shape). Poisons the smart-contract read API (a reader has to fetch the attestation to learn the cardinality before knowing whether to call `getActivePin` or `getActiveTags` — round-trip and ambiguity). Becomes the "weird EFS thing" subgraph indexers have to code around.
2. **A "cardinality" PROPERTY attached to the definition anchor (declarative, graph-DB style).** Rejected. The cardinality declaration becomes mutable state (revocable, edition-scoped, contradictable across attesters). Bootstrapping circularity (what's the cardinality of "cardinality"?). Kernel read overhead per write (extra SLOAD + EAS read to look up the predicate's cardinality before routing storage). Still doesn't solve coordination.
3. **`weight ≤ 0` carries an "unassert" supersede signal.** Considered (wider than `applies: bool`, replacing it 1-for-1). Rejected because it conflates existence with ranking — orthogonal concepts that belong in distinct mechanisms. EAS already has revoke; using it keeps EFS edges aligned with the standard EAS lifecycle. The kernel reads cleaner without a "negative weight means gone" branch.
4. **Two separate resolver contracts (`PinResolver`, `TagResolver`).** Considered. Rejected. The two would duplicate identical write-time bookkeeping (active-edge map, counts, discovery indices). A coordinator or extra cross-contract reads would be needed for the shared aggregate counters. One contract that branches on `attestation.schema` is simpler, cheaper at write-time (no cross-contract calls in resolver hot paths — saves ≥2.6k gas per attestation per ADR-0030 mainnet permanence concern), and keeps the mental model coherent.
5. **Plain `bytes32[]` storage for TAG with weight in a side mapping.** Rejected. Any on-chain consumer trying to sort a TAG list by weight would hit an N+1 SLOAD pattern that collides with block gas limits on long lists. The struct-of-tuple cost (~+20k cold gas per insert) is the right trade for sort feasibility on the read side.
6. **Reuse the existing TAG schema and add cardinality enforcement in `EFSIndexer` / off-chain.** Rejected. Off-chain enforcement contradicts the on-chain-native design property. In-kernel enforcement requires a per-predicate "what's the shape" lookup that is exactly the runtime PROPERTY this ADR rejected in (2).
7. **Pin/Tag with file-system framing (the rejected naming from earlier design rounds).** Considered as a naming concern. The earlier objection was "Pin/Tag drags file-system primitives into the kernel." That objection was wrong. **PIN means "edge slot holds one thing"** (functional property in OWL terms). **TAG means "edge slot holds N things."** Both are graph primitives. The naming is friendly to file-system devs but the underlying concept is pure graph theory. EFS's file-system semantics are built *on top of* PIN/TAG, not inside them.

## Migration

- New PIN schema UID; TAG schema UID also changes (struct shape changed). Both registered at deploy time alongside EdgeResolver.
- `TagResolver.sol` is removed; `EdgeResolver.sol` replaces it.
- `EFSIndexer` constructor takes `pinSchemaUID` and `tagSchemaUID` (both public immutables).
- `deployedContracts.ts` regenerates deterministically against the pinned Sepolia fork (ADR-0037).
- Frontend writers and readers for Shape A consumers (file placement, PROPERTY value binding) move to PIN; Shape B consumers (folder visibility, schema-alias discovery) stay on the new TAG schema.
- Pre-launch — no user data migration concerns.

## Note on supersession

ADR-0035 ("PROPERTY as free-floating value placed via TAG") is marked **Superseded by ADR-0041**. Its core insight — PROPERTY is free-floating, placement is via an edge attestation under a key anchor — remains correct. Only the cardinality story has changed: the binding edge is now a **PIN** (cardinality 1, O(1) supersede on rebind), not a TAG.
