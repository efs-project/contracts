# ADR-0046: LIST_ENTRY as pure membership identity — order and label as properties

**Status:** Accepted
**Date:** 2026-05-31
**Permanence-tier:** Etched (changes the LIST_ENTRY EAS schema field string and `ListEntryResolver` storage layout — new schema UID; devnet-free, mainnet-frozen)
**Related:** ADR-0044 (LIST + LIST_ENTRY schemas — this revises its §4/§6/§7 and the `int256 weight` field), ADR-0041 (PIN/TAG cardinality; PROPERTY-via-PIN supersession), ADR-0035 (PROPERTY free-floating value placed via PIN), ADR-0034 (`name` PROPERTY convention), ADR-0009 (append-only kernel — why the sort overlay can't source list entries), ADR-0037 (pinned fork / deterministic deploy + schema-UID pin check)

## Context

ADR-0044 put `int256 weight` directly in the `LIST_ENTRY` schema as "opaque ranking metadata," stored inline in `EntryRecord` for cheap on-chain iteration. Two problems surfaced once the client matured:

1. **Reorder churns the entry UID and orphans metadata.** `weight` is in the entry's immutable EAS data, so changing an entry's order means revoke + re-attest → a brand-new entry UID. Any PROPERTY attached to that entry (a free-text label, any per-entry metadata) points at the old, now-revoked UID and is orphaned. ADR-0044 §7 acknowledged this and prescribed "reorder via SortOverlay rather than weight-rewrites" — but (see §"sort overlay" below) the overlay cannot operate on list entries without violating a hardened invariant. So in practice there was no reorder path that preserved per-entry metadata.

2. **The free-text label was capped at 31 bytes.** Because a stable place to hang an arbitrary-length name didn't exist (the entry UID wasn't stable, and a `string` schema field would have been a separate schema change), the client packed free text into the 32-byte `target` (`bytes32`), capping labels at 31 bytes — a wart the human flagged.

Both problems have **one root cause**: a *mutable* per-entry value (order) lives inside the *immutable* entry. The fix is to take it out.

### Why not the sort overlay (ADR-0044 §7's suggestion)

`EFSSortOverlay.processItems` validates every item against the kernel's child arrays (`_children[parent]` / `_childrenBySchema`). LIST_ENTRY UIDs are **not** kernel children — they live in `ListEntryResolver`'s per-attester `_entries` arrays. Making the overlay sort list entries would require either indexing LIST_ENTRY into the kernel (the kernel must not learn list semantics — hardened DB/overlay-separation invariant, ADR-0044 §"Why not" point 1) or building a dedicated list-sourced overlay variant. Both are larger and worse than the alternative below. List sorting is — and stays — **client-side**, exactly as the current `ListPreviewPane.sortedFromChain` already does it.

## Decision

### 1. LIST_ENTRY becomes pure membership identity

```
LIST_ENTRY schema (was: "bytes32 listUID, bytes32 target, int256 weight"):
  bytes32 listUID             // the LIST this entry belongs to
  bytes32 target              // SCHEMA: attestation UID; ANY: opaque member key; ADDR: must be 0
  revocable: true
  resolver:  ListEntryResolver
```

`int256 weight` is removed. A LIST_ENTRY now asserts only *membership* — "this target is in this list, under this attester's lens." This makes LIST_ENTRY symmetric with DATA: DATA is pure content identity and `contentType`/`name` hang off it as PROPERTYs; LIST_ENTRY is pure membership identity and order/label hang off it as PROPERTYs.

`EntryRecord` slims to `{ bytes32 entryUID; bytes32 identityKey; }`. The `ListEntryAttested` event drops its `weight` field. Both changes alter `ListEntryResolver` bytecode → new LIST_ENTRY schema UID (devnet-free per ADR-0044 §8; recorded here at acceptance).

### 2. Order is a per-entry PROPERTY on the (now stable) entry UID

Ordering is stored as a PROPERTY on the LIST_ENTRY UID via the standard `Anchor<PROPERTY>(refUID=entryUID, name="<order-key>") + PROPERTY(value) + PIN` pattern (ADR-0035/0041), cardinality 1. The value is the existing fractional-rank scheme (`computeInsertWeight`, `RANK_STEP`) serialized as a decimal string.

Because the order value lives in a PROPERTY bound by a **PIN (cardinality 1)**, reordering re-attests the PROPERTY value and re-PINs it — superseding the prior value in O(1) **without touching the entry UID**. The entry UID is now stable across reorder, so the label PROPERTY (§3) and any other per-entry metadata survive every move. ADR-0044 §7's "weight-rewrites orphan metadata" footgun is dissolved, not worked around.

### 3. Free-text label is a per-entry `name` PROPERTY — arbitrary length

The optional free-text label is an entry-scoped `name` PROPERTY (ADR-0034's reserved key), placed on the stable entry UID. It is an arbitrary-length `string` (PROPERTY values are strings) — **the 31-byte `bytes32` packing limit is removed.** It survives reorder for the same reason as the order property. References (anchor/file/address/attestation) remain the primary case; the label is the occasional override the human described.

### 4. Sorting stays client-side, sourced from the order PROPERTY

The client reads each entry's order PROPERTY (lens-scoped to the viewing attester, like all PROPERTY reads) and sorts ascending — identical to today's `sortedFromChain`, with the value sourced from a property instead of a schema field. Any on-chain consumer wanting ranked order reads the order PROPERTY per entry via the established `resolveAnchor → getActivePinTarget → getAttestation` path (`EFSRouter._getContentType` is the reference). Membership + type iteration is unchanged and still O(N) over `EntryRecord{entryUID, identityKey}` — the ADR-0044 §Context MUST is preserved.

## Consequences

**Enables**
- **Reorder preserves metadata.** Stable entry UID across reorder → labels and any per-entry PROPERTY survive. The core defect is gone.
- **Arbitrary-length free-text labels.** No 31-byte cap; no `string` schema field needed.
- **Conceptual symmetry with DATA.** Pure-identity entry + mutable metadata as properties — one consistent EFS pattern, easier for a 50-year reader.

**Costs**
- **Revises a load-bearing ADR-0044 decision.** §4 stored `weight` inline for cheap on-chain *ranked* iteration; §"Load-bearing" called slimming `EntryRecord` "a schema-UID-changing event." Removing weight means an on-chain consumer that wants ranked order now pays ~3–5 SLOADs + 2 calls per entry (property read) instead of an inline field. **Accepted because the inline-weight display-order optimization was a NICE, not a MUST** — the MUST (O(N) membership + type iteration with full type confidence) is untouched; only display order moved, and it was already client-side.
- **Revoked entries permanently orphan their order/label key-anchors.** Anchors are non-revocable (`revocable == false`), so revoking a LIST_ENTRY leaves its `"weight"`/`"name"` key-anchors and their PROPERTY values as permanent dust. Cosmetic and bounded; identical to how a revoked DATA's `contentType` anchor persists today. No correctness impact.
- **Higher write cost.** Add-with-order ≈ 4 attestations (entry + key-anchor + property + pin) vs 1 today; add-with-order-and-label ≈ 7. Reorder ≈ 2. A fully-annotated top-10 ≈ 70 attestations vs ~10. Consistent with EFS's "archival, gas-heavy by design" posture; EAS multi-attest batching amortizes overhead but not the count.
- **Schema-UID change.** New LIST_ENTRY schema UID + `ListEntryResolver` redeploy (nonce-deterministic on the pinned fork, ADR-0037; see §"Supersession scope" for the mechanism clarification). Free on devnet, before any real data; would be impossible post-mainnet-freeze — which is why it lands now.

**Load-bearing**
- **Order/label MUST be a PIN-bound (cardinality-1) PROPERTY**, so re-attesting supersedes in O(1) and keeps the entry UID stable. A TAG-bound (cardinality-N) order value would accumulate and reintroduce churn.
- **Sorting is client-side by design** (the overlay can't source list entries without kernel coupling). On-chain ranked iteration is a per-entry property read, not a kernel-overlay walk.

## Supersession scope

This ADR supersedes **only** the following parts of ADR-0044: the `int256 weight` field in the LIST_ENTRY schema (§1), the `weight` member of `EntryRecord` and the inline-weight rationale (§4), the `weight` field on `ListEntryAttested`/`ListEntryRevoked` (§6), and the "reorder via SortOverlay vs weight-rewrites" guidance (§7). It also directly amends ADR-0044's "Load-bearing" bullet *"Wide `EntryRecord[]` storage (not bare `bytes32[]`)… Slimming it is a schema-UID-changing event"* — `EntryRecord` slims from three fields to two (`{entryUID, identityKey}`), which is exactly the schema-UID-changing slim that bullet flagged; we take it deliberately, pre-data, for the reasons above. **Everything else in ADR-0044 stays Accepted and in force**: the two-schema LIST/LIST_ENTRY split, the three target modes and `identityKey` derivation, write-time shape enforcement, per-attester lenses and first-wins resolution, the LIST schema and `ListResolver`, `ListReader`'s typed accessors, the `_listAttesters` on-chain index, and the schema-UID freeze discipline (mechanism clarified below). ADR-0044's status line gains a forward pointer to this ADR for the revised parts.

Additionally clarifies ADR-0044's CREATE2 references (the §8 *"CREATE2 deterministic deploy + schema-UID invariant + CI pin check"* prescription, the *"Load-bearing"* CREATE2 bullet, the Migration paragraph's *"CREATE2, deterministic"* parenthetical, and the Note on status's *"record the CREATE2 resolver addresses"*): the shipped mechanism is **nonce-deterministic CREATE on the pinned fork (ADR-0037)** combined with deploy-time consistency assertions — the deployed address matches the precomputed CREATE address (since the schema UID hashes that address), and `ListEntryResolver.LIST_SCHEMA_UID()` matches the registered LIST schema UID. Functionally equivalent under the pinned-fork discipline; CREATE2 was the original §8 prescription and remains an option if the pinned-fork constraint ever loosens.

## Alternatives considered

1. **`string` field on LIST_ENTRY** (label rides the entry; keep weight-rewrite reorder). Fixes the label limit and is reorder-safe for the label, but leaves `weight` in the entry, so reorder still churns the UID and orphans *other* metadata. Solves the symptom, not the root cause. This ADR's approach removes the mutable field entirely — strictly more general.
2. **SortOverlay-based ordering** (ADR-0044 §7). Requires kernel coupling or a new overlay variant (see §"Why not the sort overlay"); larger and touches a hardened invariant for a NICE-tier feature.
3. **Keep `weight` inline, re-attach metadata on reorder.** ~5–6 txns per drag and a permanent footgun if any client forgets the re-attach. Rejected.
4. **Numeric order PROPERTY with on-chain numeric sort.** No signed string→int parser exists in the contracts, and PROPERTY values are human-readable strings; an on-chain comparator would need new parsing infra. Moot once sorting is client-side (§4).
5. **Single per-list ordering vector** (one PROPERTY on the LIST UID, per attester, holding the serialized ordered list of entry `identityKey`s). Cheaper on the hot paths: reorder and bulk-order are O(1) *writes* regardless of list length (~2 attestations flat vs ~2 per moved entry), adds can defer the vector rewrite, and reading order is one property fetch instead of N. **Rejected as the default** for three reasons: (a) it reintroduces a special-case ordering object, breaking the "LIST_ENTRY is pure identity; every mutable per-entry datum is a property *on the entry*" symmetry that motivates this ADR; (b) the vector is bounded by PROPERTY string size (~128 entry keys at an 8 KB ceiling), capping ordered lists, whereas per-entry order is unbounded; (c) it assumes total order and composes poorly with sparse/partial ordering. The cost gap is also narrower than it appears: a single drag-reorder is 2 attestations either way, because the fractional-rank scheme (`computeInsertWeight`) re-weights only the moved entry. **Noted as the optimization to revisit if gas on write-heavy or very large lists becomes the binding constraint** — at which point the order vector can be added as an alternative ordering source without disturbing the per-entry label/metadata story.

## Resolved sub-decisions

- **Order-property key-anchor name:** `"weight"` (continuity with ADR-0044 vocabulary). The client constant is a one-line change if ever revisited.
- **Scope:** the arbitrary-length `name`-label change (§3) shipped in the same PR as the weight removal (§1–2) — same root move, same schema cut.

## Recorded addresses (devnet, pinned Sepolia fork per ADR-0037)

- **ListEntryResolver:** `0x61363ac1c0f7B59c5F81bFd6d03216BF75aFFe7B` (nonce-deterministic on the pinned fork; unchanged from pre-ADR — only the schema *string* changed)
- **LIST_ENTRY schema UID (new):** `0xc303f11e9184c190b69cffab475c59c68a2075d53c417f287cd044886935a86e`
- **LIST schema UID (unchanged):** `0x8f052e9b349c6d9617707b85f4bce742e8df5fa271d27e0faa7db66ca2de54e7`

Validated on the deployed stack: contract suite (Lists unit+conformance 56/56, simulate-lists 42/42), client typecheck + listEncoding unit 23/23, and a deployed-stack round-trip of the property mechanism (10/10: 80-byte label round-trips, lens isolation, reorder/edit keep the entry UID and survive the label/order). `deployedContracts.ts` regenerated against the pinned fork.

## Implementation surface (delivered)

The PR touched:

- **Schema string** — `09_lists.ts` `LIST_ENTRY_DEFINITION` → `"bytes32 listUID, bytes32 target"`.
- **`ListEntryResolver.sol`** — `EntryRecord{entryUID, identityKey}` (drop weight); `onAttest`/`onRevoke` decode `(bytes32 listUID, bytes32 target)` (was 3-tuple); drop `weight` from the `EntryRecord` push and the `ListEntryAttested` event.
- **Decode-length guard** — any `EXPECTED_ENTRY_DATA_LEN`-style constant goes **96 → 64**; every `abi.decode(.., (bytes32,bytes32,int256))` site must drop to `(bytes32,bytes32)` — `ListReader.sol` (~L107, L119, L153 typed accessors + `_validateEntry`), `ListEntryResolver.sol` (~L120 attest, ~L188 revoke). Leaving the length at 96 silently reverts every write with `BadPayload`.
- **`IListReader.sol`** — drop `int256 weight` from the `Entry` struct; `ListReader.entries` stops setting it.
- **Client** — `ListPreviewPane.tsx` ABI/`Entry`/`encodeEntry`/`attestEntry`/`nextWeight`/`handleDrop`/edit-keep-rank and `sortedFromChain`; `listEncoding.ts` keeps `computeInsertWeight`/`RANK_STEP` but the value is written to the order PROPERTY (decimal string) not the entry; free-text label moves from `bytes32` packing to a `name` PROPERTY (arbitrary length).
- **Tests/sim** — `Lists.unit.test.ts`, `Lists.conformance.test.ts` (schema string + `encodeEntry`), `simulate-lists.ts` (drop weight assertions; add order/label-property round-trip incl. reorder-preserves-label).
- **Specs** — `overview.md`, `02-Data-Models-and-Schemas.md`, `06-Lists-and-Collections.md` (LIST_ENTRY field string + EntryRecord shape).
