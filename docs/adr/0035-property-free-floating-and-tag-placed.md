# ADR-0035: PROPERTY as free-floating value placed via TAG

**Status:** Accepted
**Date:** 2026-04-18
**Related:** ADR-0002 (DATA standalone), ADR-0003 (TAG-based placement), ADR-0005 (superseded — contentType moved to PROPERTY), ADR-0014 (edition-scoped PROPERTY lookup), ADR-0034 (`name` PROPERTY)

## Context

Until now, PROPERTY attestations were modeled as `(string key, string value)` attached to their target via `refUID`:

```
PROPERTY(refUID = dataUID, key = "contentType", value = "image/jpeg", attester = alice)
```

The key was inlined into the PROPERTY payload; the target was the `refUID`. `EFSIndexer.onAttest` enforced that `refUID` pointed to either a DATA attestation or an `Anchor<PROPERTY>`-typed anchor.

Meanwhile DATA had been refactored to the opposite shape: free-floating content identity (`refUID = 0x0`), placed at a path via a TAG (ADR-0002 / ADR-0003). The asymmetry surfaced while drafting ADR-0034:

- DATA is free-floating; its *placement* is a TAG under an `Anchor<DATA>(name="cat.jpg")`.
- PROPERTY was bound to its target via `refUID`, with the key inlined — no TAG, no separable placement.

The user flagged the mismatch: "no real reason for PROPERTY and DATA to be different." Treating them the same — "anchors are the static tree; values float and are placed via TAG" — collapses two mental models into one.

A secondary problem: the PROPERTY `refUID` validator in `EFSIndexer.onAttest` rejected PROPERTY attestations whose `refUID` was an Address-as-bytes32, a schema UID, or a non-PROPERTY anchor. That made ADR-0034's original "just attest `PROPERTY(refUID=address, key='name')`" design fail at runtime — the EAS call reverted on the refUID check. Moving PROPERTY to the free-floating + TAG-placed model sidesteps this entirely: placement lives in the TAG, not in the PROPERTY, and TAGs already accept any container via `_validateDefinition` (ADR-0033).

## Decision

### 1. Schema change

`PROPERTY` schema becomes:

```
field definition:  string value
revocable:         false
```

The `key` field is removed. PROPERTY is a standalone value — `refUID = 0x0`, `recipient = 0x0`, non-revocable. This is a new schema UID; the previous `(string key, string value)` PROPERTY schema is abandoned (no on-chain data yet — pre-launch).

### 2. Placement via TAG under a key anchor

A PROPERTY value is bound to a container `C` under a key `K` as:

```
Anchor<PROPERTY>(parent=C, name="<K>", schemaUID=PROPERTY_SCHEMA_UID)
  ← TAG(definition=thatAnchor, refUID=propertyUID, applies=true, attester=alice)
    → PROPERTY(value="<V>")
```

The *key* is the `name` of a PROPERTY-typed anchor. The *value* is the PROPERTY's sole field. The *binding* is the TAG. Per-attester singleton comes free from `TagResolver._activeByAAS[keyAnchor][attester][PROPERTY_SCHEMA_UID]`: re-TAGging replaces the previous value.

For address containers, the key anchor is created with `recipient = addr` instead of `refUID = C` — the anchor schema already permits this (specs/02 §Anchor, ADR-0033).

Container `C` can be any bytes32: an anchor UID, a DATA UID, an address-as-bytes32, a schema UID, or an attestation UID. No per-kind validation is needed in the indexer — placement lives in the TAG, and TAG's definition validator (`TagResolver._validateDefinition`) already accepts all of these.

### 3. Removal

PROPERTY is non-revocable, like DATA. Values are permanent. The *binding* is what moves:

- **Remove a value** — revoke the TAG, or attest a new TAG with the same `(attester, definition, target)` and `applies=false`. The old TAG is logically superseded per ADR-0003.
- **Change a value** — attest a new PROPERTY with the new value, then a new TAG from the same attester to the same key anchor. The new TAG supersedes the previous one per `_activeByAAS` singleton semantics.

### 4. Indexer simplification

`EFSIndexer.onAttest`'s PROPERTY branch collapses to match DATA:

```solidity
} else if (schema == PROPERTY_SCHEMA_UID) {
    if (attestation.refUID != EMPTY_UID) return false;
    if (attestation.revocable) return false;
    emit PropertyCreated(attestation.uid, attestation.attester);
    return true;
}
```

No refUID-type dispatch. No anchor-schema lookup. Generic indices (`_referencingBySchemaAndAttester` etc.) continue to work because they're populated by `_indexGlobal` for every attestation.

### 5. Migration — contentType

The ADR-0005 shape:

```
PROPERTY(refUID = dataUID, key = "contentType", value = "image/jpeg")
```

becomes:

```
Anchor<PROPERTY>(refUID = dataUID, name = "contentType")
  ← TAG(definition = that anchor, refUID = property, applies = true)
    → PROPERTY(value = "image/jpeg")
```

The router's `_getContentType` (EFSRouter.sol) and any simulator / test that sets contentType updates to this three-attestation pattern. Upload flows batch all three (plus the DATA and the file-anchor TAG) into a single `multiAttest`.

### 6. Reserved key anchors

The two reserved keys from ADR-0005 and ADR-0034 become reserved anchor *names*:

- `"contentType"` — MIME type (always on DATA containers). ADR-0005 → this ADR.
- `"name"` — display name (any container). ADR-0034.

Other non-reserved conventional keys (`"description"`, `"icon"`, `"previousVersion"`) follow the same pattern.

## Consequences

**Enables**

- Symmetric mental model: anchors are the static tree; DATA and PROPERTY are free-floating values, both placed via TAG. One model to reason about.
- PROPERTY on any container (address, schema, attestation) works without indexer-side kind dispatch — the TAG validator handles it.
- Per-attester singleton for "Alice's current value of contentType on this DATA" is automatic from `_activeByAAS`; no separate lookup structure.
- Name-anchors give containers a navigable structure for metadata. `/<addr>/name/` resolves to the name anchor; a future UI can show all values attested by all editions without a bespoke query.
- ADR-0034's `name` PROPERTY, ADR-0005's `contentType`, and future PROPERTYs all use the same attestation shape.

**Costs**

- Three attestations where the old shape used one (key anchor + property + tag). Mitigated by `multiAttest` batching. The cost is accepted in exchange for uniformity.
- Schema UID churn — the PROPERTY schema's new UID invalidates any existing `(key, value)` PROPERTYs. Pre-launch, so no real data is affected.
- Key-anchor creation is idempotent but not free — clients check `resolveAnchor(C, key, PROPERTY_SCHEMA_UID)` first to avoid duplicate-name reverts.
- Reads must walk one extra hop (container → key anchor → TAG → PROPERTY) vs. the old direct lookup. Still O(1) per hop via existing indices.

**Load-bearing**

- `TagResolver._activeByAAS` singleton semantics are the per-attester "current value" store. Without it, reads would have to scan all historical PROPERTYs to find the latest.
- PROPERTY non-revocability pairs with TAG revocability: "the value exists forever; the assertion that it applies here can be withdrawn." This mirrors DATA's "the bytes exist forever; the placement can be moved" invariant.

## Alternatives considered

1. **Keep the old `(key, value)` shape; fix only the refUID validator.** Rejected: keeps the DATA/PROPERTY asymmetry the user flagged. Doesn't collapse the mental model. Still needs per-kind refUID validation.
2. **Put the key in the TAG instead of an anchor.** Rejected — TAG's `definition` is a bytes32 container, not a string. Encoding the key as a string-inside-TAG would need a new TAG variant.
3. **A dedicated KV schema (`bytes32 target, string key, string value`).** Rejected — redundant with PROPERTY + TAG + Anchor, and doesn't get free per-attester singleton from `_activeByAAS`.
4. **Anchor `name` = key AND value in one field.** Considered. Rejected because values are often long strings ("image/jpeg" ok, "Vitalik Buterin" ok, but `description` values can be paragraphs) and would bloat the `_nameToAnchor` directory.

## Note on supersession

ADR-0005 ("ContentType moved from DATA to PROPERTY") is marked **Superseded by ADR-0035**. Its core insight — contentType is not part of DATA identity and belongs on the outside — remains correct. Only the PROPERTY attestation shape has changed.
