# EFS Lists — Design

**Status:** Draft (round 11 — major revision)
**Date:** 2026-04-25
**Permanence-tier:** Etched-adjacent (introduces one new EAS schema; the data model is permanent post-1.0)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming) + James Carnley (architectural direction)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0041, ADR-0042; specs/02, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history, parked ideas, eleven rounds of refinement

---

## TL;DR

**A list is a folder where the entries are weighted.**

That's the entire model. Lists and folders are the same kind of thing — an anchor with child entries. The only difference: list entries have weights (via TAGs) for ordering, and the list anchor carries a permanent `LIST_DECLARATION` attestation marking it as a typed list.

```
Alice's list anchor (e.g., alice.eth/fav-friends)
              │
              ├── entry "0xBob"      ──PIN──▶ Bob's address
              │   └── weight TAG ──▶ 100 (against list anchor)
              │
              ├── entry "0xCarol"    ──PIN──▶ Carol's address
              │   └── weight TAG ──▶ 90
              │
              └── entry "0xDave"     ──PIN──▶ Dave's address
                  └── weight TAG ──▶ 80
```

Every entry can carry per-list metadata (notes, status, captions) via PROPERTYs on the entry anchor. Re-rank by re-attesting the entry's weight TAG (O(1) supersede). Migration story is trivial: any folder can be promoted to a list by adding entries' weights and a `LIST_DECLARATION`.

**One mode, one read pattern, one mental model.** No "Item List vs Entry List" picker. No `memberMode` PROPERTY that can flip mid-life. No cost asymmetry tax for "choosing wrong" at creation time.

The cost is uniformly ~3 attestations per entry (entry anchor + PIN + weight TAG). On L2 this is pennies. The win: single primitive, conceptual simplicity, every entry is extensible by default.

---

## What changed in round 11

This round merged two design strands into one primitive:

1. **Always-wrapped.** Round-5's "two-mode" design (direct + wrapped) collapses to one mode. The direct-mode optimization (cheaper attestations for membership-only lists) is dropped because the cost saving (~3x vs 1x) is pennies on L2 and the conceptual debt of two modes wasn't worth it.

2. **Lists ARE folders.** A folder's children are anchors with PINs to content (this is how files are placed in folders today in EFS). A list's entries are anchors with PINs to items, plus weights. Same machinery; different conventions on top. A folder becomes a list by adding a `LIST_DECLARATION` attestation and starting to write weight TAGs. Migration is trivial.

3. **Type marker is a permanent attestation, not a mutable PROPERTY.** Round-7's `memberMode` PROPERTY had a known fragility — curators could flip mode in O(1) via PIN re-attest, leaving the list internally inconsistent. The new `LIST_DECLARATION` schema is `revocable: false`, making list type permanent at attestation time.

4. **Shopping lists, todo lists, and other stateful items are core supported use cases.** Earlier non-goals listed "mutable per-item state machines" as out of scope. That was wrong — wrapped entries can carry mutable status PROPERTYs natively (PIN supersede on the binding). Removed from non-goals.

The resulting design is significantly simpler. The notes file preserves the 10 prior rounds for context.

---

## Why this matters

Lists will accumulate use cases for the next 100 years: top friends, favorite memes, blocklists, allowlists, ratings, playlists, syllabi, registries, shopping lists, todos, reading lists, ranked endorsements. Getting the conceptual model right at v1 sets the shape every downstream consumer encounters.

The core insight: **lists don't need their own primitive — they're folders with weights.** Folders already exist in EFS as anchors with child anchors that PIN to content. Adding weight TAGs to children and a permanent type marker to the parent gives us lists. One primitive, two metadata layers.

**Smart contracts read these data structures directly.** The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK-side enforcement of invariants because contract consumers don't run the SDK.

---

## The list primitive

A list is an anchor with two things that mark it as such:

1. **A `LIST_DECLARATION` attestation** (per-attester, non-revocable) that says "this anchor is a list, with these properties."
2. **One or more entries** — child anchors that PIN to items, with weight TAGs against the list anchor.

### Anatomy of an entry

```
parent: list anchor (Alice's list)
  │
  └── entry anchor                                  ← named per the list's entryIdentity convention
        │
        ├── PIN(definition=entry, refUID=item)      ← binds entry to actual item
        │
        ├── TAG(definition=parent,                  ← provides weight for ordering
        │       refUID=entry,
        │       weight=N)
        │
        └── PROPERTYs on entry                      ← optional per-entry metadata
              (notes, status, captions, dates, etc.)
```

### `LIST_DECLARATION` schema (NEW — Etched commitment)

```
LIST_DECLARATION schema:
  bytes32 itemSchema       // expected schema of inner targets; bytes32(0) = address-target or any
  uint8   entryIdentity    // 0 = target-derived names, 1 = occurrence-derived names
revocable: false
```

A list anchor MUST have exactly one `LIST_DECLARATION` attestation per curator attester (`refUID = listAnchor`). Because the attestation is non-revocable, the list type is permanent — no in-place mutation of `entryIdentity` or `itemSchema`. Curators wanting to change list type create a new list anchor and re-author entries.

`itemSchema` describes the schema the entry's PIN target should conform to. `bytes32(0)` permits address targets (recipient-typed PINs) or any schema. Apps may enforce stricter typing at write time.

`entryIdentity` declares the entry-naming convention:
- `0` (target-derived): entry name = canonical lowercase hex of `targetID`. Set semantics — same target lands at the same anchor across attesters. Use for unique annotated lists, top-N, blocklists, allowlists, registries.
- `1` (occurrence-derived): entry name = `lowercase 0x + 64 hex of keccak256(abi.encode("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce))`. Each occurrence is independent — same target can appear at multiple distinct entries. Use for playlists with duplicates, syllabi, ranked ballots.

`clientNonce` MUST be ≥128 bits CSPRNG entropy. Sequential or monotonic nonces are forbidden — they enable squatting attacks. (See Pitfalls — `clientNonce` is convention-only at the kernel.)

### Entry naming rules (deterministic, schema-aware)

For target-derived entries:
- UID-typed targets (DATA, attestations, anchors): name = `0x` + 64 lowercase hex (66 chars) of the target UID
- Address-typed targets (`itemSchema = bytes32(0)`, PIN uses `recipient`): name = `0x` + 40 lowercase hex (42 chars) of the address — the canonical Ethereum address form, NOT the zero-padded 32-byte form

For occurrence-derived entries:
- name = `0x` + 64 lowercase hex of the `keccak256` formula above; the `clientNonce` is per-entry-creation random

### Weights and ordering

The TAG carries an `int256 weight`. Default ordering is `weight desc`, with deterministic tie-break by entry-anchor UID asc, then `tagUID` asc. Apps may declare alternative orderings via custom PROPERTYs on the list anchor; not part of the canonical spec.

Re-attesting a weight TAG at the same `edgeHash = (attester, entryAnchor, listAnchor, TAG_SCHEMA)` supersedes the prior weight in O(1) (per ADR-0041 §4 — kernel updates the entry's UID and weight in place).

For lists where the curator manually orders entries, SDKs SHOULD use sparse `int256` weights (e.g., 2^32 spacing) with periodic rebalance. This is the standard CRDT-style approach (Logoot et al.). Sparse weights are NOT a universal MUST — ratings, votes, scores, and other lists use weights with intrinsic meaning.

### Per-entry metadata

PROPERTYs on the entry anchor carry per-entry state. Pattern (per ADR-0034):
- A reserved key anchor under the entry (e.g., `note`, `status`, `caption`, `purchasedAt`)
- A free PROPERTY attestation with the value
- A PIN binding the value at the key anchor (cardinality-1 per attester)

Updating a metadata value re-binds the PIN at the same slot — O(1) supersede. The entry anchor itself never changes, so metadata survives reorders, target rebinds (occurrence mode), and any other mutation.

**Reserved generic PROPERTY keys**: `note`, `title`, `description`, `icon`, `cover`, `status`. Apps SHOULD NOT shadow these with conflicting semantics. Other PROPERTY keys are app-defined.

---

## Lists are folders (the unification)

In EFS, a folder is an anchor with child anchors. A file in a folder is an anchor with a PIN to a DATA. That's the underlying graph structure.

A list is the same: an anchor with child anchors (entries), each with a PIN to a target. The differences are:
- The list anchor has a `LIST_DECLARATION` attestation (folders typically don't)
- Entries have weight TAGs (folder children typically don't)

There is no separate "list" data structure. **Lists ARE folders** with two extra layers of metadata:

```
plain folder:        anchor + child anchors + PINs to content
list:                anchor + LIST_DECLARATION + child anchors + PINs to content + weight TAGs
sorted folder:       anchor + child anchors + PINs to content + SORT_INFO applied
sorted list:         all of the above (LIST_DECLARATION + weights + SORT_INFO override possible)
```

A folder can be promoted to a list:
1. Attest a `LIST_DECLARATION`
2. Start writing weight TAGs against the existing children (or create new entries)

A list can fall back to folder-like reading (ignore weights, sort by name) if a client wants to.

This unification eliminates the round-5 picker question entirely. The only choice at creation is `entryIdentity` (set vs sequence).

---

## Reader API (v1 commitments)

Smart contracts and clients read lists via `EdgeResolver` view methods that bundle the canonical multi-step reads into single atomic calls. Three methods, all named as generic graph operations (no list-overlay vocabulary in the kernel ABI):

**Existing readers used by lists** (per ADR-0041 §8):
- `getActiveTagEntries(definition, attester, targetSchema, start, length) → (tagUID, weight)[]`
- `getActivePinTarget(definition, attester, targetSchema) → targetID` (returns `bytes32(0)` on missing)
- `isActiveEdge(attester, targetID, definition, schema) → bool`

**New readers shipping in v1** (committed pre-launch; immutable post-1.0):
- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — generic TAG bucket reader with target extraction. Useful for many list-shaped reads.
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends previous: for TAGs whose target is itself an anchor, additionally resolves the anchor's PIN target. **This is THE canonical list reader** — for a list, pass `tagTargetSchema = ANCHOR_SCHEMA_UID`; for each entry, get back `tagTargetID` (entry anchor), `pinTargetID` (the actual item), `pinTargetSchema` (item's schema), and `weight`.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic self-naming-anchor consistency check. Schema-aware (UID hex vs address hex). Used for target-derived list entries.

**Pagination cap (enforced):** `length` MUST be ≤ `MAX_LIST_PAGE_SIZE = 100`. Readers MUST revert with `PageSizeTooLarge()` on overflow.

**Pages are NOT sorted by weight.** Readers paginate the active TAG bucket in insertion order (with swap-and-pop on revoke per ADR-0007). Clients producing sorted top-N MUST fetch all entries, sort locally, then truncate. For very long lists (>>1000 entries), use an off-chain indexer.

### Canonical read recipe (single-curator scope, default)

```
1. Read listAnchor's LIST_DECLARATION attestation by curator.
   - Validate exists (revocable=false → if exists, it's permanent).
   - Read itemSchema and entryIdentity.

2. Call EdgeResolver.getActiveTagPinTargetsWithWeights(
     listAnchor,
     curator,
     ANCHOR_SCHEMA_UID,        // entries are anchors
     start,
     length
   ).
   - Returns (entryUID, tagUID, innerTargetID, innerTargetSchema, weight, attester)[].

3. For each entry: if innerTargetID == bytes32(0), render warning state.
   - Check innerTargetSchema matches itemSchema (or itemSchema == bytes32(0) for any).

4. If entryIdentity == 0 (target-derived), validate name consistency:
   - For each entry: call validateAnchorNameMatchesPinTarget(entryUID, curator).
   - On false: render warning OR suppress.

5. For metadata PROPERTYs (note, status, etc.):
   - Resolve the named key anchor under the entry; read PROPERTY value via getActivePinTarget.

6. Apply default total order:
   - Sort by weight desc, tie-break by entryUID asc, then tagUID asc.

7. Truncate to client-chosen displayLimit.
```

### Snapshot consistency

Smart contracts calling the v1 readers in a single transaction get atomic snapshot consistency for free — the EVM guarantees per-call atomicity. The bundled readers complete all reads within one external view call.

Off-chain clients paginating across multiple RPC calls (or composing PROPERTY + PIN + TAG reads) MUST pin all reads in a single render to the same `blockTag`. Default `wagmi`/`viem` setups do NOT pin `blockTag` automatically; SDK helpers wrapping list reads MUST handle this internally.

Governance / on-chain consumers SHOULD read from finalized blocks to avoid reorg sensitivity in vote tallies, membership checks, etc.

---

## Editions and multi-attester reads

Default reads are **single-curator-scoped**. The curator's `LIST_DECLARATION`, weight TAGs, entry PINs, and entry metadata all come from one attester.

Multi-attester views (compare/merge UI) are explicit opt-in. Each attester writes their own TAGs, PINs, and metadata; per-attester storage in `_activeByAAS` is independent. The design preserves edition independence at every layer.

**For `entryIdentity = 0` (target-derived):** entry anchors are SHARED schelling points — Alice and Bob's "entry for book X" land at the same anchor (deterministic name from target hash). Each writes their own PIN and weight TAG. Multi-attester reads filter at the PIN/TAG layer; the entry anchor is shared infrastructure.

**For `entryIdentity = 1` (occurrence-derived):** entry anchors are per-curator (each curator's `clientNonce` differs). Independent entry-anchor sets per attester. A curator who *intentionally* wants to patch another's sequence can reuse an existing occurrence entry anchor.

**Merge semantics are not part of this design.** Multi-attester rendering (priority chain, side-by-side, aggregate) is client UX. v1 says: default reads are single-curator-scoped; multi-attester is advisory and clients MUST preserve attribution. Merge conventions land in their own ADR if cross-client interop demands it.

---

## Use cases (exhaustive support analysis)

Every list-shaped use case I can identify, with how the unified design handles each:

| # | Use case | Mode | Key features used |
|---|---|---|---|
| 1 | Top-8 friends (addresses, ranked) | target-derived | Weight TAGs; PIN to address |
| 2 | Top-10 favorite memes (DATA, ranked) | target-derived | Weight TAGs; PIN to DATA |
| 3 | Top-N mixed targets (DATA + addresses + attestations) | target-derived | Each entry independently PINs to whatever schema |
| 4 | Annotated favorite books with notes per book | target-derived | `note` PROPERTY on entry |
| 5 | Ratings (1-5★ per item) | target-derived | weight = rating value |
| 6 | Allowlists (membership only, with optional reason) | target-derived | Weight = 0 or 1; optional `reason` PROPERTY |
| 7 | Blocklists (membership + reason) | target-derived | `reason` PROPERTY on entry |
| 8 | Reading list (books, ordered, removable) | target-derived | Weight = reading order; remove via revoke |
| 9 | **Shopping list (items with bought/unbought state)** | target-derived | `status` PROPERTY toggleable via PIN re-attest |
| 10 | **Todo list (items with status: not-started/in-progress/done)** | target-derived | `status` PROPERTY |
| 11 | Curated awesome-EFS guide (mixed targets, notes) | target-derived | Per-entry rationale, mixed inner schemas |
| 12 | DAO delegate slate (addresses, on-chain consumed) | target-derived | Weight = preference rank |
| 13 | Playlist with duplicates ("Bohemian Rhapsody" 2x) | occurrence-derived | Same DATA at multiple entries |
| 14 | Syllabus (lectures, ordered, repeated prereqs) | occurrence-derived | Per-step prose, duplicated targets |
| 15 | Schema/resolver/plugin registries | target-derived | Targets are schema-alias anchors per ADR-0033 |
| 16 | Tier list (S-tier/A-tier with sub-rank) | target-derived | weight encodes (tier × 10^9 + rank); or `tier` PROPERTY |
| 17 | "People I trust for X topic" (per-context quality) | target-derived | Per-list context note; same target in multiple lists |
| 18 | Cross-list reuse (same target, multiple lists) | target-derived | Independent list anchors; per-list weight |
| 19 | Annotated bookmarks (URLs + notes) | target-derived | URL via wrapper anchor (URLs need wrapping; see Pitfalls) |
| 20 | DAO membership lists | target-derived | Membership = active TAG |
| 21 | Following / friend graph | target-derived | Per-attester TAGs |
| 22 | Rolodex (contacts with notes) | target-derived | Notes per entry |
| 23 | Curated feed (per-attester recommendations + rationale) | target-derived | Rationale as `note` PROPERTY |
| 24 | Inventory / stock list | target-derived | `stock` and `price` PROPERTYs; updateable |
| 25 | Achievements / badges with date earned | target-derived | `earnedAt` PROPERTY |
| 26 | Wishlist (gifts, prioritized) | target-derived | Weight = priority |
| 27 | Playlist with skip count or play count | occurrence-derived | `skipCount` PROPERTY per occurrence |
| 28 | Course curriculum (lessons with status) | occurrence-derived | `status` per lesson; lessons can repeat across courses |

**Every use case maps to the same primitive.** The only choice at list creation is `entryIdentity` (set vs sequence — duplicates allowed?).

---

## Pitfalls and safety

### Entry-anchor squatting (target-derived only)

For target-derived entries, the entry name encodes the target. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target.

Clients MUST validate via `EdgeResolver.validateAnchorNameMatchesPinTarget(entryAnchor, attester)`. Mismatch → render warning OR suppress; never silently treat as valid.

Smart contracts can do this in a single call alongside `getActiveTagPinTargetsWithWeights` (same transaction, atomic).

For occurrence-derived entries, name validation does NOT apply — names don't encode the target. Re-PINning an occurrence-derived entry to a different target is the *intended* affordance.

### `clientNonce` convention is unenforceable at the kernel

Sequential nonces and CSPRNG output produce identical-looking `keccak256` hashes. The kernel cannot distinguish.

Smart contracts consuming occurrence-derived lists SHOULD treat the entry's UID and the curator's TAG attestation as the trust unit, NOT the entry name pattern. The squatting validation rule for target-derived entries does NOT apply. The TAG is the membership claim; the name is a label, not a credential.

The MUST-CSPRNG rule is convention enforced by SDK rigor. If sequential-nonce squatting attacks appear in the wild, the long-tail-risk-trigger response is a kernel-side nonce-entropy resolver (not in v1).

### Lists of people are public, durable, attribution-labeled

Publishing a list of addresses puts them on-chain durably. Clients SHOULD:
- **Label issuer attribution clearly**: "Alice's blocklist", not "blocked". Viewers must always know whose claim they're seeing.
- Treat these lists as durable; revocation removes the active claim but not the historical attestation.

Clients MAY surface a publish-confirmation modal at their discretion. v1 spec mandates no specific warning text.

### "Lists containing X" is an anti-feature in default UX

Anyone can put anyone on any list. Profile pages MUST NOT default-render reverse lookups ("lists this address appears on"). Reverse lookups MAY be exposed only to the viewing user themselves ("lists I'm on"), opt-in only.

### Target universe — not everything is a TAG target

PIN's `refUID` must point at an existing EAS attestation (DATA, anchor, attestation). **Raw schema UIDs are NOT valid PIN targets** — schemas exist as registry entries, not attestations. Schema registries MUST target schema-alias anchors per ADR-0033, not raw schema UIDs.

URLs and other off-chain identifiers similarly need a wrapper (DATA attestation with the URL as content, or a custom anchor scheme) to be PIN'd.

### ADR-0042 effective-TAG filter does NOT apply to lists

ADR-0042 establishes "effective TAG = active TAG with `weight ≥ 0`" for the explorer's descriptive-label filter. **This convention does not apply to custom lists.** A blocklist with `weight = 0` is active membership; a rating with `weight = -3` is a meaningful low score. Apps MAY apply a `weight ≥ 0` filter for their own UX reasons; the canonical default for list rendering is "active = unrevoked," with weight used for ordering.

---

## Indexer notes (for subgraph implementers)

Subgraph and off-chain indexer implementations consuming list-related events should be aware:

**Event ordering between TAGs and `LIST_DECLARATION`.** `LIST_DECLARATION` is a separate EAS event from weight TAGs and entry anchor creations. A subgraph processing list-related events MAY see TAGs against `listAnchor` before its `LIST_DECLARATION` exists. Indexers SHOULD:
- Track TAG events keyed by `(listAnchor, attester)`; resolve them when `LIST_DECLARATION` appears.
- Render lists without `LIST_DECLARATION` as plain folders (the unification means this is correct).

**Active state vs historical state.** `_activeByAAS` reflects current active TAGs (post-revocation). Track revocation events and apply swap-and-pop semantics (per ADR-0007).

**TAG supersession via re-attest at same edgeHash** (per ADR-0041 §4). Re-attesting a TAG updates the active entry's UID and weight in place, **without emitting a `Revoked` event for the prior TAG**. Indexers MUST detect this:
- When a new `Attested` event arrives for a TAG, compute `edgeHash = (attester, targetID, definition, schema)`.
- If a prior TAG with same `edgeHash` exists in active set, treat as superseded — replace, don't double-count.

**PIN supersession is slot-based, not edgeHash-based.** Metadata bindings (note, status, etc.) are PINs at slot `(definition, attester, targetSchema)`. Re-attesting a PIN at the same slot supersedes the prior — **even when the target changes** (target is part of edgeHash but NOT part of the slot). Indexers reconstructing active PIN state MUST key singleton slots by `(definition, attester, targetSchema)` and replace `(pinUID, targetID)` for that slot when a new PIN arrives.

**`LIST_DECLARATION` is non-revocable.** Indexers can cache the declaration once observed; it never changes.

**Discovery indexes vs active state.** `_targetsByDef`, `_edgeDefinitions`, etc. are append-only discovery indexes including historical entries; NOT ground truth for current active state. Cross-reference active-set storage.

---

## Conventions vs enforcement — long-tail risk

This design relies on convention enforcement for invariants the kernel cannot validate: `clientNonce` CSPRNG entropy, target-derived entry name consistency, single-list-per-anchor uniformity (a curator could attest two `LIST_DECLARATION`s — though the schema is non-revocable, they could attest a second one with different fields; clients should treat as ambiguous).

This is acceptable for v1 because the kernel surface stays minimal. But it has forcing functions. **Explicit revisit triggers** — promote to heavier mechanism if any become true post-launch:

- **Target-derived entry name mismatches exceed measurable share** of target-derived lists → ship on-chain validation enforcement via custom resolver.
- **Squatting-pattern signals appear post-launch** → ship kernel-side nonce-entropy or anchor-name-rate-limit resolver. Sequential nonce patterns aren't observable from hashes; the real signals are downstream effects (write-aborts on name pre-existence, successful squatting reports, anchor-name collision rates above birthday-paradox baseline).
- **Smart-contract consumers report material gas-overhead pain** despite the v1 bundled readers → extend `EdgeResolver` further or ship a stand-alone view contract.
- **Multiple `LIST_DECLARATION`s per anchor become a real problem** → add resolver-level uniqueness enforcement.
- **Cross-client divergence on read recipes** → ship a canonical reference SDK as the de facto interpreter.

These triggers are not just operational concerns — they represent the conditions under which "convention only" becomes load-bearing tech debt.

---

## Decisions resolved

These were the architectural decisions made across eleven rounds of cross-agent design review.

1. **Lists are folders with weighted entries.** One primitive, not two modes. The round-5 "direct vs wrapped" two-mode design was simplified to always-wrapped in round 11 after James's review.
2. **`LIST_DECLARATION` schema, non-revocable.** New EAS schema marking an anchor as a typed list. Replaces round-7's `memberMode` PROPERTY (which had a known mutability fragility).
3. **`entryIdentity` is permanent.** Encoded in `LIST_DECLARATION`, set once. Replaces the prior PROPERTY-based mutable `entryIdentity`.
4. **Smart contracts read directly via three new `EdgeResolver` view methods.** Generic graph-composition names (no list-overlay vocabulary in kernel ABI).
5. **Multi-attester merge is not in core design.** Default reads are single-curator-scoped; multi-attester is opt-in for compare/merge UI.
6. **`/lists/` ships empty.** Protocol identity does not seed predicates. EFS Team multi-sig may seed recommended predicates separately later.
7. **Default ordering: weight desc; tie-break by entry-UID asc, then tagUID asc.** Apps may declare alternatives.
8. **Sparse `int256` weights are an SDK SHOULD for manual ordering**, not a universal MUST. Ratings, votes, scores use meaningful weights.
9. **Page cap MUST = 100**, enforced via `PageSizeTooLarge()` revert.
10. **`clientNonce` ≥128 bits CSPRNG is convention** — kernel cannot enforce; smart contracts treat occurrence-derived entry UIDs as trust units.
11. **Snapshot consistency MUST**: smart contracts get atomicity in single calls; off-chain clients pin `blockTag`; governance reads finalized.
12. **Convention-violating lists are accepted v1 risk** with explicit revisit triggers.
13. **Shopping lists, todos, and stateful items are core supported use cases** (round-11 correction; was wrongly excluded in earlier rounds).
14. **Lists ARE folders** structurally. The unification eliminates the migration-as-fork problem and the picker-rule complexity.

---

## Out of scope for v1 / future work

- **Stand-alone `EFSListView` contract** — the v1 `EdgeResolver` extensions cover canonical paths; a separate view contract may emerge later if specialized list helpers become desirable beyond what generic graph composition expresses.
- **`displayLimit`, `weightMeaning`, `weightDirection`, `tieBreak` PROPERTYs** — apps use generic PROPERTYs; spec stays minimal until cross-app conventions emerge.
- **Multi-attester merge conventions** — needs its own ADR; interacts with ADR-0031/0039 alignment.
- **Sort overlay extension for TAG sources** — `EFSSortOverlay` doesn't currently support TAG buckets; defer until concrete demand.
- **Cross-attester aggregation primitives** — Sybil-resistance scoping required.
- **Computed lists** — predicate-derived membership (iTunes Smart Playlist analog).
- **Reverse-lookup APIs as default UX** — anti-feature in default UX; index-level reverse lookups exist for opt-in use.
- **`specs/06` rewrite** — describe the unified list-as-folder model; supersede `specs/08`. **Required before dev writes list data.**
- **FractionalSort** — kept parked as a possible future read/index optimization for huge ordered lists; not part of the v1 list model.
- **`web3://<list-anchor>` ERC-5219 read shape** — router-layer concern; separate from list data model.
- **Custom resolver enforcing `LIST_DECLARATION` uniqueness per attester** — long-tail-risk-trigger response.
- **Kernel-side nonce-entropy resolver** — to reject weak `clientNonce` at write time. Long-tail-risk-trigger response.

---

## Non-goals

These use cases are intentionally NOT what lists are trying to be — distinguished from "deferred" items above.

- **Real-time collaborative single-list editing.** Multiple authors mutating one shared list with conflict resolution (Google Docs cursors, shared Spotify queues). That's CRDT territory; lists are per-attester claims that compose at read time.
- **Computed lists from arbitrary queries.** "All DATA tagged `#scifi` by people I follow" is dynamic membership; lists are materialized membership claims authored by an attester.
- **Time-windowed temporal queries.** "Top friends this week" is an indexer concern over the historical attestation stream, not a list shape.
- **Cross-attester aggregation primitives at the kernel layer.** Sybil-resistant top-N globally requires governance scope; not a list primitive.
- **Reverse-lookup APIs as default UX surface.** Index-level reverse lookups exist (per ADR-0041 §8) but should not surface in default profile UX (see Pitfalls).
- **Complex per-item state machines with transitions and validations.** Simple status (`bought`, `done`, `unread`) is supported via mutable PROPERTYs. Multi-step workflows with transition validation, history, etc. are application-layer concerns, not list-primitive concerns.

Lists are: **weighted membership claims by one attester at one anchor, ordered by `int256` weight, with optional per-entry metadata.** Fitting other shapes into this primitive degrades both.

---

## Implementation sketch (informative)

**v1 shipping units (committed pre-launch):**

1. **New EAS schema: `LIST_DECLARATION`**
   - `bytes32 itemSchema, uint8 entryIdentity`
   - `revocable: false`
   - Registered in deploy script alongside other reserved schemas.

2. **`EdgeResolver` extensions** — three new view methods:
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool`
   All revert with `PageSizeTooLarge()` on `length > MAX_LIST_PAGE_SIZE = 100`.

3. **Reserved-key anchor names** — `note`, `title`, `description`, `icon`, `cover`, `status` — added to deploy script.

4. **SDK helpers** wrapping the reader API + write conventions:
   - `efs.lists.create(parentAnchor, name, opts)` — creates list anchor + LIST_DECLARATION
   - `efs.lists.addEntry(listAnchor, target, opts)` — creates entry anchor + PIN + weight TAG
   - `efs.lists.setMetadata(entryAnchor, key, value)` — PROPERTY-via-PIN binding
   - `efs.lists.read(listAnchor, attester, opts)` — reader with snapshot pinning
   - `canonicalEntryAnchorName(targetID, schemaUID) → string`
   - `cryptoRandomNonce() → bytes32`

5. **Frontend list-renderer** in `packages/nextjs/` debug UI — minimal demonstration of lists against seeded demo lists.

6. **Spec rewrite:** `specs/06-Lists-and-Collections.md` describes the unified list-as-folder model; `specs/08` marked as superseded.

7. **Optional demo seed:** one list under the demo tree (`08_seed_demo_tree.ts`), flagged demo-only.

**NatSpec requirements for the three new view methods:**

- `getActiveTagTargetsWithWeights` — document address-target encoding (`bytes32(uint160(recipient))`).
- `getActiveTagPinTargetsWithWeights` — document `pinTargetID = bytes32(0)` semantics + occurrence-derived trust model warning.
- `validateAnchorNameMatchesPinTarget` — document validation scope (name-to-PIN consistency, NOT membership).

**Required pre-launch tests (conformance matrix):**

| # | Category | Test |
|---|---|---|
| 1 | List creation | Create + LIST_DECLARATION + 5 entries + read |
| 2 | List | Reorder via re-attest weight TAG at same edgeHash |
| 3 | List | Revoke TAG at index 2 of 5 (swap-and-pop) |
| 4 | List | Address-target entries via PIN `recipient` |
| 5 | List | Negative weight stays active (ADR-0042 doesn't apply) |
| 6 | List | Add `note` PROPERTY to entry; update via PIN re-attest |
| 7 | List | Add `status` PROPERTY (toggleable) |
| 8 | List | `validateAnchorNameMatchesPinTarget` passes for valid + spoofed entry |
| 9 | List | Multi-attester at shared entry anchor (target-derived) |
| 10 | List | Two distinct entries pointing at same target (occurrence-derived) |
| 11 | List | Re-PIN occurrence-derived entry to different target |
| 12 | List | Missing PIN on entry; reader returns `pinTargetID = bytes32(0)` |
| 13 | Reader | Page-size cap revert at length=101 |
| 14 | LIST_DECLARATION | Non-revocable: revoke attempt fails |
| 15 | LIST_DECLARATION | Two attestations from same attester surface as ambiguity |
| 16 | Snapshot | Read at finalized block tag matches active state |
| 17 | Anchor names | Validator passes on 42-char address hex + 66-char UID hex |
| 18 | Adversarial | Squatter mismatch detected by validator |
| 19 | Indexer | TAG re-attest detected as supersession via edgeHash |
| 20 | Indexer | PIN re-attest at same slot detected as supersession (target may change) |
| 21 | Folder→list | Add LIST_DECLARATION to existing folder; works |

These 21 tests are required for v1 launch. Implementations failing any are not v1-conformant.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, plus independent validation passes from Gemini and a fresh Claude instance, mediated by James Carnley. Eleven rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md). Round 11 was a substantive simplification — collapsing the round-5 two-mode design into a single always-wrapped primitive, adding the `LIST_DECLARATION` schema for permanent typed declarations, and unifying lists with folders.
