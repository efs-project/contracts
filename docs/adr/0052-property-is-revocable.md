# ADR-0052: PROPERTY is revocable

**Status:** Proposed
**Date:** 2026-06-10
**Related:** ADR-0051 (default-hide-revoked reads), ADR-0035 (PROPERTY free-floating — superseded by ADR-0041; argued PROPERTY non-revocable), ADR-0041 (PIN/TAG split), ADR-0049 (DATA empty; contentHash/size as reserved-key PROPERTYs), ADR-0048 + `docs/SEPOLIA_FREEZE_TABLE.md` (the freeze set). **Freeze-gated — changes PROPERTY's permanent UID.**

## Context

PROPERTY (`string value`) was non-revocable, inherited from ADR-0035's framing: PROPERTY is "symmetric with DATA — the value exists forever; only the binding (the edge) is withdrawn." Under that model, removing a property meant revoking its **PIN** binding (cardinality-1, ADR-0041), never the value attestation itself.

Revisiting this before the Sepolia freeze surfaced that the DATA-symmetry is imperfect. DATA earns permanence because it is a genuine **identity / Schelling point**: the entire MIRROR + PIN graph hangs off a DATA UID, and others coordinate on it. A PROPERTY value (`contentType = image/png`, a `name`, a label, or a reserved-key `contentHash`/`size` claim per ADR-0049) is **a claim/assertion about something**, not a focal point others independently converge on. A value may be *reused*, but reuse is not the same as being a Schelling point.

Applying the clean principle behind the whole freeze set — **non-revocable = identity/structure others build on; revocable = claims and placements the author can retract** — PROPERTY belongs with the revocable claim-schemas (PIN, TAG, MIRROR, LIST_ENTRY, REDIRECT), not with the permanent identities (ANCHOR, DATA, LIST). ADR-0051's "revoke = withdraw from the default view" frame makes this concrete: *a value you no longer trust → revoke → gone from the default view*, while the bytes persist (revocation never erases).

## Decision

**Register PROPERTY with `revocable: true`.** Field string (`string value`) and resolver (EFSIndexer proxy) are unchanged; only the revocable flag flips. This recomputes PROPERTY's schema UID — a permanent change, made now while nothing is registered on Sepolia.

Reads honor it per ADR-0051: the lens-scoped PROPERTY lookup (ADR-0014) treats a revoked PROPERTY value as absent by default (in addition to the existing check that its binding PIN is active), with the `includeRevoked` opt-in surfacing it.

This reverses the PROPERTY-non-revocable aspect of ADR-0035 (already superseded by ADR-0041 on other grounds); ADR-0041's PIN-binding model is unaffected.

## Consequences

- **Enables.** A clean "withdraw this value" operation consistent with every other claim-schema, and the intuitive default-hide behavior of ADR-0051. Reserved-key claims (`contentHash`, `size`, ADR-0049) become retractable — appropriate, since they are unverified attester claims, not authenticated identity.
- **Costs / implies.** EFSIndexer (and the view surfaces) must filter revoked PROPERTYs on read, not only revoked binding PINs — upgradeable logic, landed with this change and tested. The "removal via the PIN" path (ADR-0041) still works and remains the way to *change* or *unplace* a value; PROPERTY revocation additionally withdraws the value-statement itself.
- **One footgun, mitigated by convention.** If a single PROPERTY value attestation is shared across many bindings (a dedup optimization the model allows), revoking it withdraws it from *all* of them. Convention: mint a fresh PROPERTY per binding (already what the upload flow does, overview §upload step 4) and use the PIN to unbind in the shared case. Because revocation flags rather than erases, a shared value's bytes still persist regardless.
- **Freeze.** PROPERTY's row in `docs/SEPOLIA_FREEZE_TABLE.md` changes to `revocable: true`; its UID recomputes. No other schema UID is affected (each UID is independent). Captured in the golden-vector test.

## Alternatives considered

- **Keep PROPERTY non-revocable (status quo / ADR-0035 symmetry).** Rejected: the DATA-symmetry that justified it doesn't hold — a value is a claim, not a Schelling point — and it leaves PROPERTY as the lone claim-schema that can't be withdrawn, inconsistent with ADR-0051. The only real argument for it (shared-value safety) is mild, since removal already works via the revocable PIN and revocation never erases.
