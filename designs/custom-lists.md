# EFS Custom Lists — Design

**Status:** Draft
**Date:** 2026-04-24
**Permanence-tier:** Durable (sets stable conventions over Etched primitives; introduces no new schemas)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming)
**Related:** ADR-0033, ADR-0034, ADR-0041, ADR-0042; specs/02, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — exploratory thoughts, design history, parked ideas

---

## TL;DR

**An EFS list is ordered tagging.** A list anchor exists; weighted TAGs against it carry membership and rank.

Two protocol modes:

| Mode | What the TAG targets | Best for |
|---|---|---|
| **Item List** | The item itself (`refUID = item` or `recipient = address`) | Top-N favorites, ratings, allowlists, blocklists, registries |
| **Entry List** | An entry anchor that PINs to the item | Annotated favorites, sequences with duplicates, anywhere a row needs its own identity |

Picker question: **"Is the item the identity, or is the entry the identity?"**

Folders are not lists. A sorted folder is just a folder with `SORT_INFO` applied.

v1 introduces no new EAS schemas, no new resolver contracts, no new view contracts. Lists are documented patterns over existing primitives (Anchors, PINs, TAGs, PROPERTYs). Smart contracts read via existing `EdgeResolver` reader API; clients compose multi-read via SDK multicall.

---

## Why this matters

Lists will accumulate use cases for the next 100 years: top friends, favorite memes, blocklists, allowlists, ratings, ranked endorsements, bookmarks, playlists, syllabi, registries. Getting the conceptual model right at v1 sets the shape every downstream consumer (subgraphs, smart contracts, UIs) will encounter.

The core insight: **lists don't need a new primitive.** Ordered tagging already exists in EFS via `TAG(definition, refUID, weight)`. The only design question is what `refUID` points at — the item directly, or an entry anchor that wraps it.

---

## The two modes

### Item List

The TAG's target IS the item. Cheapest possible list shape. No per-entry metadata, no duplicates of the same target by the same attester.

**Attestation graph (Alice's top 3 memes — DATA targets):**
```
ANCHOR(name="top-memes", refUID=alice_home)                     → listUID
TAG(definition=listUID, refUID=catDataUID,     weight=100, alice)
TAG(definition=listUID, refUID=hamsterDataUID, weight=90,  alice)
TAG(definition=listUID, refUID=dogDataUID,     weight=80,  alice)
```

**Attestation graph (Alice's top 3 friends — address targets):**
```
ANCHOR(name="fav-friends", refUID=alice_home)                   → listUID
TAG(definition=listUID, recipient=0xBob,   weight=100, alice)
TAG(definition=listUID, recipient=0xCarol, weight=90,  alice)
TAG(definition=listUID, recipient=0xDave,  weight=80,  alice)
```

Address-target TAGs use `recipient` (no `refUID`). The kernel routes target via ADR-0041 §2 and stores under the `bytes32(0)` (`ADDRESS_TARGET`) schema slot — **no separate ANCHOR/DATA attestation is created to represent the address.**

**Reorder cost:** O(1) — re-attest at same edgeHash with new weight (ADR-0041 §4 supersedes in place).

**Cost per item:** 1 attestation (just the TAG). 8 friends ≈ 9 attestations including the list anchor.

**Use cases:** top friends, top memes, favorites, ratings, allowlists, blocklists, plugin/schema/resolver registries.

**Limitations:** no duplicates of the same target by the same attester (edgeHash collision). No per-entry metadata that survives reorder. For these, use Entry List.

### Entry List

The TAG's target is an entry anchor that PINs to the item. The entry has its own identity and can carry per-entry metadata via PROPERTYs. Occurrence-derived entries can be re-PINned to a different target without disturbing weight or notes; target-derived entries are expected to keep their name and PIN target aligned.

**Attestation graph (Alice's annotated top 3 books):**
```
ANCHOR(name="favorite-books", refUID=alice_home)                              → listUID

# Per entry: anchor + target binding + weighted membership + (optional) metadata
ANCHOR(name="<entry-name>", refUID=listUID, schemaUID=DATA_SCHEMA_UID)        → entryA
PIN(definition=entryA, refUID=bookA_DATA, attester=alice)
TAG(definition=listUID, refUID=entryA, weight=100, attester=alice)
PROPERTY(value="Changed how I think about systems")                           → noteA_prop
ANCHOR(name="note", refUID=entryA, schemaUID=PROPERTY_SCHEMA_UID)             → noteA_key
PIN(definition=noteA_key, refUID=noteA_prop, attester=alice)
... (entryB, entryC similarly)
```

The entry anchor sets `schemaUID = innerTargetSchema` (e.g., `DATA_SCHEMA_UID` for a book; `bytes32(0)` for an address target). This mirrors specs/07 (sort naming anchors) and ADR-0033 (schema-alias anchors); clients use it to know which schema to pass to `getActivePinTarget`.

**Entry anchor naming is a writer convention, not a protocol type.** Two patterns:

- **Target-derived** (set semantics): `name = canonical lowercase hex of targetID`. UID targets render as `0x` + 64 hex (66 chars); address targets render as `0x` + 40 hex (42 chars; canonical Ethereum address form, low 160 bits of `targetID`). The first curator creates the entry anchor; later curators for the same target reuse that resolved anchor — multi-attester editions converge on shared entries. Use for unique annotated favorites.
- **Occurrence-derived** (sequence semantics): `name = lowercase 0x + 64 hex of keccak256("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce)`. Curator-generated nonce; the same target can appear at multiple distinct entries. Use for playlists, syllabi, ranked ballots.

The naming convention is per-list, not per-entry; clients pick by intent at list creation. There is no protocol-level enforcement that all entries in one list use the same convention — but mixing is confusing and clients SHOULD avoid it.

**Reorder cost:** O(1) — re-attest the TAG at same edgeHash with new weight. Entry anchor and metadata survive.

**Cost per entry:** ~3 attestations without notes (entry anchor + PIN + TAG); ~6 with one note field. 3 books ≈ 10 attestations, ~19 with one note field each.

**Use cases:** annotated favorites, playlists with duplicates, syllabi, ranked ballots, exhibits, anywhere a row needs its own state independent of the target.

---

## List metadata

Two PROPERTYs on the list anchor (per ADR-0034 reserved-key idiom; bound via PIN per ADR-0041 §4):

| Key | Values | Required? | Purpose |
|---|---|---|---|
| `listKind` | `"item"` (Item List) \| `"entry"` (Entry List) | **Yes** for curated lists | Tells the reader which mode to use |
| `itemSchema` | A schema UID, or `bytes32(0)` for address targets | Recommended | The logical item type. For Item List, the TAG's `targetSchema`. For Entry List, the schema each entry's PIN binds to. |

Apps MAY attach generic display PROPERTYs (`title`, `description`, `icon`, `cover`, etc.) using ADR-0034 conventions. These are not part of the canonical lists spec; conventions emerge from practice and graduate to spec only if they earn cross-app interop value.

**Why is `listKind` required?** Without it, readers must infer mode from the TAG's `refUID` schema — fragile if a list ever has mixed shapes. The PROPERTY makes curator intent explicit.

**Why singular `itemSchema` instead of an allowlist?** v1 keeps it simple. Mixed-schema lists are rare in practice and can be expressed as Entry Lists where entries PIN to different schemas. If concrete demand emerges for declared multi-schema constraints, a future plural variant can be added without breaking this design.

**`listKind` is renderer intent, not contract proof.** The kernel does not enforce that storage matches the declared kind. Clients treat it as advisory and degrade gracefully on mismatch (see Pitfalls).

---

## Reading lists

No new view contract in v1. Clients use `EdgeResolver.getActiveTagEntries(listAnchor, attester, targetSchema, start, length)` (per ADR-0041 §8) and resolve targets via SDK multicall.

**For Item List:**
- `targetSchema` is the list's `itemSchema` (e.g., `DATA_SCHEMA_UID`, or `bytes32(0)` for address targets)
- `getActiveTagEntries` returns `(tagUID, weight)[]` — for Item List, the TAG's own `refUID`/`recipient` is the target, so resolving requires reading each TAG attestation
- Sort client-side by weight; truncate per UI choice

**For Entry List:**
- `targetSchema` is always `ANCHOR_SCHEMA_UID` (the TAG's target is an entry anchor)
- `getActiveTagEntries` returns `(tagUID, weight)[]`; read each TAG attestation's `refUID` to get the entry anchor UID
- For each entry: read the entry anchor's `schemaUID`, then call `getActivePinTarget(entry, attester, entry.schemaUID)` for the actual underlying target; read PROPERTYs for metadata

**Pages are NOT sorted by weight.** `getActiveTagEntries` paginates the active TAG bucket in insertion order (with swap-and-pop on revoke per ADR-0007). Clients producing a sorted top-N MUST fetch all entries, sort locally, then truncate. For very large lists (>>1000 entries), use an off-chain indexer.

**Recommended pagination cap:** `length ≤ 100` per call (matching `EFSSortOverlay.MAX_PAGE_SIZE`) to bound `eth_call` time on multi-read clients.

**A future `EFSListView` helper** (analogous to `EFSFileView`) MAY be added if implementation pain proves it necessary — to bundle target resolution internally and reduce RPC overhead. **Not in v1 scope.** The burden of proof is on adding the helper, not on omitting it.

---

## Editions and multi-attester reads

Multi-attester views compose naturally with both modes. Each attester writes their own TAGs against the same list anchor; per-attester storage in `_activeByAAS[def][attester][schema]` is independent.

**Item List:** per-attester reads are independent. Alice's top friends and Bob's top friends are separate `getActiveTagEntries` calls.

**Entry List with target-derived naming (set):** entry anchors are SHARED schelling points — Alice and Bob's "entry for book X" land at the same anchor (the name is a deterministic hash of the target). Each writes their own PIN binding the entry to a target, and their own TAG with their own weight. Multi-attester reads filter by attester at the PIN and TAG level; the entry anchor is shared infrastructure.

**Entry List with occurrence-derived naming (sequence):** entry anchors are per-curator (each curator's `clientNonce` differs). Alice's playlist and Bob's playlist have independent entry-anchor sets. A curator who *intentionally* wants to patch another's sequence can reuse an existing occurrence entry anchor and write their own TAG/PIN against it.

**Merge semantics** (priority-first-wins, last-write-wins, side-by-side, etc.) are client UX, not part of this design. Clients pick how to render multi-attester data based on use case and application requirements. Future merge conventions can land as separate documentation without changing this design.

**Edition-flexibility property:** the design preserves per-attester storage independence at every layer. No mode forces merge to happen on-chain; all merging is client-side composition. This is a deliberate property — it lets future editions semantics ship without requiring contract changes.

---

## Pitfalls and safety

### `listKind` is renderer intent, not proof

The kernel does not enforce storage shape against `listKind`. Clients MUST treat the PROPERTY as advisory:

- Declared `item` but the TAG bucket is empty → render an empty state.
- Declared `entry` but no entry anchors exist (or no TAGs against the list with `targetSchema = ANCHOR_SCHEMA_UID`) → same empty/degraded treatment.
- Mixed shapes (some direct-target TAGs and some entry-anchor-target TAGs on the same list) → render a warning state and prefer the declared kind; do not silently interleave.

### Entry-anchor squatting and target validation (Entry List, target-derived naming only)

The protocol does NOT enforce that an entry anchor's name matches the target its PIN binds to. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target. For Entry Lists with target-derived naming, clients MUST validate name ↔ target consistency:

1. Read entry anchor's `schemaUID`.
2. Resolve target via `getActivePinTarget(entry, attester, entry.schemaUID)`.
3. Compute expected name from `targetID`:
   - `schemaUID == bytes32(0)` (address) → `0x` + lowercase hex of low 160 bits (42 chars total)
   - else → `0x` + lowercase hex of full `targetID` (66 chars total)
4. Mismatch → render warning state OR suppress the entry; never silently treat as valid.

For occurrence-derived naming, this validation does not apply — names don't encode the target.

### Lists of people are public, durable, attribution-labeled

Publishing a list of addresses puts them on-chain durably. Clients SHOULD:

- **Label issuer attribution clearly**: "Alice's blocklist", not "blocked". This is the load-bearing safety primitive — viewers must always know whose claim they're seeing.
- Treat these lists as durable; revocation removes the active claim but not the historical attestation.

Clients MAY surface a publish-confirmation modal at their discretion. v1 spec mandates no specific warning text — following / listing other users is normal social behavior, and consumer products don't gate it with friction.

### "Lists containing X" is an anti-feature in default UX

Anyone can put anyone on any list. Profile pages MUST NOT default-render reverse lookups ("lists this address appears on"). Surfacing this uninvited:
- Lets griefers pin "scammer of the week" lists onto someone's profile.
- Conflates attester-claims with subject-attributes.
- Creates negative social dynamics by default.

Reverse lookups MAY be exposed only to the viewing user themselves ("lists I'm on"), opt-in only.

---

## Decisions resolved

These were the architectural decisions made during cross-agent design review.

1. **Two list modes (Item List, Entry List), not three or four.** Earlier drafts had P1/P1.5/P2 as distinct types; the previous P1.5 (target-keyed entry anchors) and P2 (occurrence-keyed) collapse into one Entry List mode with naming as a writer convention.
2. **Folders are not lists.** Sorted folders are folders with `SORT_INFO`; no `listKind` PROPERTY applies.
3. **Lists are not a new EAS primitive.** Existing PIN, TAG, ANCHOR, PROPERTY suffice. No new schemas; no Etched commitments.
4. **`EFSListView` helper deferred.** v1 ships read paths via `EdgeResolver` + SDK multicall. Helper added later only if implementation pain demonstrates need.
5. **Multi-attester merge is client UX, not list design.** No merge semantics in the canonical design; clients compose per-attester reads however the use case demands.
6. **Minimal metadata: `listKind` + `itemSchema`.** Display PROPERTYs are app convention until cross-app interop value emerges.
7. **`/lists/` ships empty.** Protocol identity does not seed predicates. EFS Team multi-sig may seed recommended predicates separately later.
8. **UX warnings are advisory.** Attribution labeling is the load-bearing safety primitive; first-publish confirmation is at client discretion.
9. **`specs/06` rewrite deferred** until this design lands. Will describe Item List and Entry List explicitly; supersede `specs/08`.

---

## Out of scope for v1 / future work

- **`EFSListView` helper contract** — defer until implementation pain shows need.
- **`displayLimit`, `weightMeaning`, `weightDirection`, `tieBreak`, etc.** — apps use generic PROPERTYs; spec stays minimal until cross-app conventions emerge.
- **`itemSchemas` (plural) for declared multi-schema lists** — defer; mixed-schema lists are an Entry List with diverse PINs.
- **Multi-attester merge URL conventions** — client UX, future shared-conventions doc if cross-client interop demands it.
- **Sort overlay extension for TAG sources** — `EFSSortOverlay` doesn't currently support TAG buckets; defer until concrete demand.
- **Cross-attester aggregation primitives** — Sybil-resistance scoping required.
- **Computed lists** — predicate-derived membership (iTunes Smart Playlist analog).
- **Reverse-lookup APIs** — anti-feature in default UX; may be added behind explicit opt-in.
- **`specs/06` rewrite** — describe Item List + Entry List explicitly; supersede `specs/08`.
- **FractionalSort** — kept parked as a possible future read/index optimization for huge ordered lists; not part of the v1 list model.

---

## Appendix — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **One mode only** ("always-wrapped" — every list is an Entry List) | Conceptually elegant but taxes the dominant case (top-N favorites, allowlists) at ~3× attestation cost and creates EAS state per address listed (asymmetry between "things in EFS" and "people on the network"). The simplification doesn't earn its weight. |
| **Three or four distinct types** (the previous P1 / P1.5 / P2 / P3 alphabet) | P1.5 and P2 are mechanically identical except for entry naming — they're one mode with a writer convention, not two types. Folders aren't lists. Multi-pattern vocabulary creates classification burden without semantic payoff. |
| **New `LIST_ITEM` schema** | Permanent Etched commitment for marginal benefit. Existing primitives + advisory metadata cover the design space. |
| **JSON manifest as list metadata** | One DATA per list; bulk-readable but not independently rebindable. ADR-0034 individual-PROPERTY idiom is cheaper to update and matches existing convention. |
| **Contractual schema enforcement** (custom resolver rejecting non-allowed targets) | Federated systems can't enforce write-time type constraints meaningfully. Advisory + reader-side filtering is the durable primitive. |
| **Multi-attester merge in core design** | Couples list semantics to client UX choices. Deferring keeps the design portable across future merge conventions without breaking changes. |
| **Allowlist `allowedTargetSchemas`** (CSV of multiple schema UIDs) | Mixed-schema lists are rare; can be expressed as Entry Lists with diverse inner PINs. Singular `itemSchema` keeps the v1 spec minimal and adds plural variant later only if needed. |
| **`EFSListView` in v1** | Pre-launch, omitting it is the default; clients use `EdgeResolver` + SDK multicall. Add the helper when its absence demonstrably hurts. |
| **Positional anchors + FractionalSort for sequences** | Sparse `int256` weights with periodic rebalance handle reorder in O(1) using ordinary TAG-weight machinery. FractionalSort and `a0/a1/a2` naming buy nothing the unified design doesn't already provide. |

---

## Implementation sketch (informative)

For an eventual implementation plan; not prescriptive here.

**Likely shipping units:**
1. Reserved-key anchor names (`note`, `listKind`, `itemSchema`, etc.) — added to deploy script alongside ADR-0034 reserved keys.
2. Frontend list-renderer in `packages/nextjs/` debug UI — minimal demonstration of Item List and Entry List against seeded demo lists.
3. Spec rewrite: `specs/06-Lists-and-Collections.md` describes Item List + Entry List explicitly; `specs/08` marked as superseded design notes.
4. Optional demo seed: one `/lists/<predicate>` anchor in the demo tree, flagged demo-only.

**Likely ADR shape:**
- ADR-A: Custom Lists — Item List + Entry List structural model, metadata convention (`listKind`, `itemSchema`), reading conventions, edition independence.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, with parallel research subagents and a multi-round dialogue mediated by James Carnley. Five rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md).
