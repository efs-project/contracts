# ADR-0052: PROPERTY is non-revocable (interned shared value)

**Status:** Proposed
**Date:** 2026-06-10
**Related:** ADR-0051 (default-hide-revoked reads — applies to the revocable schemas: PIN/TAG/MIRROR/LIST_ENTRY/REDIRECT), ADR-0035 (PROPERTY free-floating — superseded by ADR-0041), ADR-0041 (PIN/TAG split; the PIN is the cardinality-1 binding), ADR-0049 (DATA empty; contentHash/size as reserved-key PROPERTYs), ADR-0048 + `docs/SEPOLIA_FREEZE_TABLE.md` (the freeze set), ADR-0004 (`dataByContentKey` — the rejected kernel-enforced dedup). **Freeze-gated — fixes PROPERTY's permanent UID.**

## Context

PROPERTY (`string value`) is the free-floating value placed on a container via a PIN under a key anchor (ADR-0035 → ADR-0041). The question this ADR settles: is a PROPERTY value revocable?

A revocable framing was briefly adopted (commit `79307e1`) on the argument that a value is "a claim the author can withdraw," unlike DATA which is an identity Schelling point. That commit flipped PROPERTY to `revocable: true`, recomputed its UID, and added revoked-value read handling (`EFSRouter._getContentType` skipping `isRevoked(propertyUID)`). It was never merged and is reversed here.

The reversal: **the value is not the claim.** A PROPERTY value — `image/png`, a display `name`, a reserved-key `contentHash`/`size` — is *dumb, shared, interned content*: an "anchor for a string" that many bindings can point at. The thing an author asserts and can withdraw is the **binding** — "*this* container has *this* value, from *me*" — and that binding is the PIN (cardinality-1, revocable, ADR-0041). Making the value itself revocable conflates the content with the claim and breaks sharing: if one author revokes a value that other PINs (from other attesters, or the same author at other slots) point at, it vanishes out from under all of them. Non-revocability is precisely what makes a value safe to share.

This restores **DATA-symmetry the right way**: DATA = non-revocable content, PIN = revocable placement claim; PROPERTY = non-revocable content, PIN = revocable value claim. Value is content; claim is the edge. (The earlier revocable argument got the symmetry backwards by treating the value as the claim.)

## Decision

**Register PROPERTY with `revocable: false`.** Field string (`string value`) and resolver (EFSIndexer proxy) are unchanged; only the revocable flag is fixed back to `false`. `EFSIndexer.onAttest` rejects a revocable PROPERTY attestation, exactly as it does for ANCHOR and DATA. Removal or change of a property is done entirely through the PIN: revoke the PIN to unbind, re-attest at the same slot to supersede (ADR-0041). ADR-0051's default-hide-revoked convention therefore operates on the revocable schemas (PIN/TAG/MIRROR/LIST_ENTRY/REDIRECT) — a revoked binding PIN drops the value from the default view — and **not** on PROPERTY itself.

**Dedup is best-effort at write time, never enforced in the kernel.** Identical values *may* share one PROPERTY attestation (a new PIN points at the existing value instead of minting a fresh one). Two complementary, opt-in lookup paths help a writer find an existing value:

- **Off-chain (JS clients):** `EFSIndexer` emits `PropertyCreated(propertyUID, attester, valueHash)` with `valueHash = keccak256(bytes(value))` as an indexed topic. This is the value's **canonical content key** (ties to the forthcoming canonical-hashing spec). An off-chain indexer keyed on `valueHash` answers "does a PROPERTY with this value already exist?" so the client can reuse its UID.
- **On-chain (future, opt-in):** an **intern registry** — a separate, redeployable, **non-kernel** contract exposing `intern(value) → uid` (return-or-mint). It is the *neutral canonical minter*, so "nobody owns the value." On-chain writers (other contracts) need it because they have no off-chain indexer to query. It is **opt-in** (so unique, never-shared values don't bloat it) and a **lookup, not an enforced gate** (so it can never cause a batch revert). Deferred to `docs/FUTURE_WORK.md`; not in this freeze.

## Consequences

- **Enables.** Safe value sharing (the dedup optimization the model allows) without the footgun of one author yanking a shared value. A clean conceptual split: content is permanent, the claim/binding is the revocable thing. Consistency — every *value/identity* schema (ANCHOR, DATA, LIST, PROPERTY) is non-revocable; every *claim/edge* schema (PIN, TAG, MIRROR, LIST_ENTRY, REDIRECT) is revocable.
- **Costs / implies.** Reverses commit `79307e1`: PROPERTY's UID recomputes back to the pre-flip value, the resolver re-rejects revocable PROPERTY, and `EFSRouter._getContentType` loses the (now-dead) value-revocation check. The `PropertyCreated` event gains a third indexed topic (`valueHash`) — an ABI change to a not-yet-deployed event, free now. There is **no** "withdraw the value everywhere" operation; that is by design — withdraw the binding instead.
- **Freeze.** PROPERTY's row in `docs/SEPOLIA_FREEZE_TABLE.md` is `revocable: false`; its UID is the pre-flip literal. No other schema UID is affected. Captured in the golden-vector test.
- **Kernel-enforced dedup stays rejected** (see Alternatives). The intern registry is a lookup primitive outside the kernel, not a write-time gate.

## Alternatives considered

- **PROPERTY revocable (commit `79307e1`).** Rejected and reversed: the value is shared content, not a claim; making it revocable breaks sharing (a shared value can be yanked from under other bindings) and conflates two distinct things. The revocable claim already exists — it's the PIN.
- **Kernel-enforced on-chain dedup (`intern` as a mandatory gate; cf. the removed `dataByContentKey`, ADR-0004).** Rejected: a write-time uniqueness gate in the append-only kernel causes **batch reverts** (one duplicate aborts a whole multi-attestation upload) and **permanent storage bloat** on values that are unique and never shared. Dedup must be a lookup the writer *chooses* to consult, not an invariant the kernel enforces. The future intern registry is exactly this — opt-in, non-kernel, return-or-mint, no revert.
- **No dedup affordance at all.** Rejected as needlessly wasteful: emitting the `valueHash` topic is free and gives clients a clean canonical key; the on-chain registry is deferred but the door is left open.
