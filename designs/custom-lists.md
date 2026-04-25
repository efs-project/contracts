# EFS Custom Lists — Design

**Status:** Draft
**Date:** 2026-04-25
**Permanence-tier:** Durable (sets stable conventions over Etched primitives; introduces no new schemas)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0041, ADR-0042; specs/02, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — exploratory thoughts, design history, parked ideas

---

## TL;DR

**An EFS list is a weighted TAG set.** A list anchor exists; weighted TAGs against it carry membership and rank. There is one underlying primitive and two member patterns:

| Member pattern | What the TAG targets | Recipe name | Best for |
|---|---|---|---|
| **direct** | The item itself (`refUID = item` or `recipient = address`) | "Item List" | Top-N favorites, ratings, allowlists, blocklists, registries |
| **wrapped** | An entry anchor that PINs to the item | "Entry List" | Annotated favorites, sequences with duplicates, anywhere a row needs its own identity |

Picker question: **"Is the item the identity, or is the entry the identity?"** A list anchor declares which pattern it uses via `memberMode = "direct" | "wrapped"`.

Folders are not lists. A sorted folder is just a folder with `SORT_INFO` applied.

v1 introduces no new EAS schemas, no new resolver contracts, no stand-alone view contracts. Lists are documented patterns over existing primitives (Anchors, PINs, TAGs, PROPERTYs). Smart contracts read via the existing `EdgeResolver` reader API plus three v1 extensions (generic graph-composition view methods that bundle the canonical multi-read patterns into single atomic calls).

---

## Why this matters

Lists will accumulate use cases for the next 100 years: top friends, favorite memes, blocklists, allowlists, ratings, ranked endorsements, bookmarks, playlists, syllabi, registries. Getting the conceptual model right at v1 sets the shape every downstream consumer (subgraphs, smart contracts, UIs) will encounter.

The core insight: **lists don't need a new primitive.** Ordered tagging already exists in EFS via `TAG(definition, refUID, weight)`. The only design question is what `refUID` points at — the item directly, or an entry anchor that wraps it. The two answers form a clean spectrum of one machinery.

**Smart contracts read these data structures directly.** The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK-side enforcement of invariants because contract consumers don't run the SDK. Where invariants can be enforced on-chain (or via on-chain helpers), they are. Where they can't, the design says so explicitly and adjusts the threat model accordingly.

---

## Non-goals

These use cases are intentionally NOT what lists are trying to be — distinguished from "deferred for v1" items in [Out of scope](#out-of-scope-for-v1--future-work) below. Future agents proposing to extend lists into these spaces should expect a different primitive, not a list extension.

- **Mutable per-item state machines.** Todos, shopping carts, kanban cards — items with their own lifecycle (pending → in-progress → done) tracked alongside list membership. Lists rank existing things; they don't track per-item state machines.
- **Real-time collaborative single-list editing.** Multiple authors mutating one shared list with conflict resolution (Google Docs cursors, shared Spotify queues). That's CRDT territory; lists are per-attester claims that compose at read time.
- **Computed lists from arbitrary queries.** "All DATA tagged `#scifi` by people I follow" is dynamic membership; lists are materialized membership claims authored by an attester.
- **Time-windowed temporal queries.** "Top friends this week" is an indexer concern over the historical attestation stream, not a list shape.
- **Cross-attester aggregation primitives at the kernel layer.** Sybil-resistant top-N globally requires governance scope; not a list primitive.
- **Reverse-lookup APIs as default UX surface.** Index-level reverse lookups exist (per ADR-0041 §8) but should not surface in default profile UX (see Pitfalls).

Lists are: **weighted membership claims by one attester at one anchor, ordered by `int256` weight, with optional per-entry metadata.** Fitting other shapes into this primitive degrades both the original primitive and the new use case.

---

## The two member patterns

### Direct member pattern (Item List recipe)

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

Address-target TAGs use `recipient` (no `refUID`). The kernel routes target via ADR-0041 §2 and stores under the `bytes32(0)` (`ADDRESS_TARGET`) schema slot — **no separate ANCHOR/DATA attestation is created to represent the address.** The TAG attestation itself names the address via `recipient`.

**Reorder cost:** O(1) — re-attest at same edgeHash with new weight (ADR-0041 §4 supersedes in place).

**Cost per item:** 1 attestation (just the TAG). Excluding metadata, 8 friends ≈ 9 attestations including the list anchor. A canonical direct list also needs `memberMode` + `itemSchema` metadata; if both key anchors are new, add ~6 one-time attestations (key anchor + PROPERTY + PIN for each), so 8 friends ≈ 15 attestations on first creation.

**Use cases:** top friends, top memes, favorites, ratings, allowlists, blocklists, plugin/schema/resolver registries.

**Limitations:**
- **No duplicates** of the same target by the same attester (edgeHash collision).
- **No per-entry metadata** that survives reorder (re-attesting changes the active TAG UID).
- **Single inner schema only** — TAGs land in `_activeByAAS[def][attester][targetSchema]` keyed by target schema. A direct list with mixed-schema TAGs (some DATA, some attestation, some address) silently fragments across schema buckets and looks like missing entries to a single-schema reader. Curators wanting mixed targets MUST use the wrapped pattern.
- **Migration to wrapped is not in-place — fork required.** Converting a direct list to wrapped requires creating a new list anchor and re-authoring entries; there is no silent migration. **If you might ever want notes, duplicates, or per-entry metadata, choose `wrapped` from the start** — the cost asymmetry (direct ~1 attestation/item vs wrapped ~3-6/entry) makes "upgrade later" tempting, but every list that needs to migrate becomes a fork operation. The decision lives at list creation, and the picker question MUST be answered honestly.

### Wrapped member pattern (Entry List recipe)

The TAG's target is an entry anchor that PINs to the item. The entry has its own identity and can carry per-entry metadata via PROPERTYs. Re-PINning behavior depends on `entryIdentity`: occurrence-derived entries can be re-PINned to a different target without disturbing weight or notes; target-derived entries are expected to keep name and PIN target aligned (see Pitfalls).

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

**Entry identity is declared via the `entryIdentity` PROPERTY on the list anchor.** Two values:

- **`"target"`** (set semantics): entry name = canonical lowercase hex of `targetID`. UID targets render as `0x` + 64 hex (66 chars); address targets render as `0x` + 40 hex (42 chars; canonical Ethereum address form, low 160 bits of `targetID`). The first curator creates the entry anchor; later curators for the same target reuse that resolved anchor — multi-attester editions converge on shared schelling-point entries. Use for unique annotated favorites.
- **`"occurrence"`** (sequence semantics): entry name = `lowercase 0x + 64 hex of keccak256(abi.encode("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce))`. The same target can appear at multiple distinct entries. Use for playlists, syllabi, ranked ballots, exhibits.

`clientNonce` MUST be a `bytes32` value with at least 128 bits of CSPRNG entropy. **Sequential or monotonic nonces are forbidden** — they enable squatting attacks where an attacker pre-computes the next entry anchor name.

The convention is per-list (declared once at creation, applies to all entries). Mixing identities within one list is unsupported.

**Reorder cost:** O(1) — re-attest the TAG at same edgeHash with new weight. Entry anchor and metadata survive.

**Cost per entry:** ~3 attestations without notes (entry anchor + PIN + TAG); ~6 with one note field. Excluding list metadata, 3 books ≈ 10 attestations, ~19 with one note field each. A canonical wrapped list also needs `memberMode` + `entryIdentity` metadata (~6 one-time attestations if both key anchors are new), plus ~3 more if it declares `itemSchema`.

**Use cases:** annotated favorites, playlists with duplicates, syllabi, ranked ballots, exhibits, anywhere a row needs its own state independent of the target.

---

## List metadata

Three PROPERTYs on the list anchor (per ADR-0034 reserved-key idiom; bound via PIN per ADR-0041 §4):

| Key | Values | Required? | Purpose |
|---|---|---|---|
| `memberMode` | `"direct"` \| `"wrapped"` | **Yes** for curated lists | Tells the reader which member pattern is used. Locked v1 enum. |
| `itemSchema` | A schema UID, or `bytes32(0)` for address targets | **Required for `direct`**; recommended for `wrapped` | The logical item type. For `direct`, the TAG's `targetSchema`. For `wrapped`, the schema each entry's PIN binds to. |
| `entryIdentity` | `"target"` \| `"occurrence"` | **Required for `wrapped`** | Entry naming convention; affects duplicate semantics and validation. Locked v1 enum. |

Apps MAY attach generic display PROPERTYs (`title`, `description`, `icon`, `cover`, etc.) using ADR-0034 conventions. These are not part of the canonical lists spec; conventions emerge from practice and graduate to spec only if they earn cross-app interop value.

**Reserved keys this design adds**: `memberMode`, `itemSchema`, `entryIdentity`, `note`. Apps SHOULD NOT shadow these with conflicting semantics. Other PROPERTY keys are app-defined and unconstrained.

**Wire encoding rules:**

- Enum string values (`"direct"`, `"wrapped"`, `"target"`, `"occurrence"`) MUST be lowercase ASCII, no leading/trailing whitespace, exact match.
- Schema UIDs encoded as `"0x"` + 64 lowercase hex characters (66-char total).
- Address sentinel encoded as `"0x0000000000000000000000000000000000000000000000000000000000000000"` (32 zero bytes).
- Anchor names (entry anchors, key anchors) encoded per ADR-0025 validation: lowercase printable ASCII; entry anchor names are exact-length hex strings (42 chars for address targets, 66 chars for UID targets).

**`memberMode` v1 enum is locked.** Future expansion (e.g., a third pattern) lands as a versioned PROPERTY (`memberModeV2`) rather than a new value. Readers MUST treat unknown values as advisory failure (render empty/warning state); they MUST NOT silently coerce.

**Why required `itemSchema` for `direct`?** A direct-mode reader must query `_activeByAAS[listAnchor][attester][itemSchema]` to enumerate; without `itemSchema`, the bucket is unknown. A missing PROPERTY means the curator forgot it; readers SHOULD render a warning state. (Address-only direct lists explicitly set `itemSchema = bytes32(0)`; this is distinct from "absent.")

**Why singular `itemSchema` instead of an allowlist?** v1 keeps it simple. Mixed-schema lists are expressed as wrapped lists where entries PIN to different schemas. Direct lists with mixed-schema TAGs silently fragment (different schema buckets) — the picker rule routes mixed curators to wrapped.

**`memberMode` is renderer intent, not contract proof.** The kernel does not enforce that storage matches the declared mode. Clients treat it as advisory and degrade gracefully on mismatch (see Pitfalls).

---

## Reading lists

Smart contracts and clients read lists via `EdgeResolver` reader APIs. Because contract consumers can't run an SDK, the public reader API surface MUST cover both modes' canonical reads in a single call wherever feasible, with snapshot consistency naturally provided by atomic transaction execution.

### Public reader API (v1 commitments)

These methods on `EdgeResolver` ship in v1 and are immutable post-1.0. They bundle the underlying reads (`_activeByAAS` enumeration + EAS attestation field extraction + entry anchor PIN resolution) into single calls so callers — especially smart contracts — get correct results without reinventing multicall plumbing.

**Existing readers used by lists** (already in ADR-0041 §8 reader API):
- `getActiveTagEntries(definition, attester, targetSchema, start, length) → (tagUID, weight)[]` — paginates active TAGs in a bucket.
- `getActivePinTarget(definition, attester, targetSchema) → targetID` — resolves a PIN's current target. Returns `bytes32(0)` on missing slot (already true in code; documented).
- `isActiveEdge(attester, targetID, definition, schema) → bool` — fast membership check (used by allowlist / blocklist consumers).

**New generic graph-composition readers shipping in v1** (committed pre-launch because data structures + public APIs are immutable post-1.0):

- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — bundles `getActiveTagEntries` + per-TAG target extraction. For each active TAG: returns the TAG's resolved target (`refUID` for UID-typed targets, `bytes32(uint160(recipient))` for address-typed targets when `tagTargetSchema = bytes32(0)`).
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends the previous: for each active TAG whose `tagTargetID` is itself an anchor (i.e., `tagTargetSchema = ANCHOR_SCHEMA_UID`), additionally resolves `pinTargetID` by reading the anchor's `schemaUID` field as `pinTargetSchema` and then calling `getActivePinTarget(tagTargetID, attester, pinTargetSchema)`. For non-anchor `tagTargetID`s, returns `pinTargetID = bytes32(0)` and `pinTargetSchema = bytes32(0)`. Generic over any "wrapped" pattern, not just lists.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic anchor-name consistency check. Reads the anchor's `schemaUID`, resolves its current PIN target via `getActivePinTarget(anchorUID, attester, anchor.schemaUID)`, computes the canonical hex name from that target (schema-aware: 42-char for `schemaUID = bytes32(0)` address targets, 66-char for UID-typed targets), and returns whether it matches the anchor's actual `name`. Returns false on missing PINs or mismatches. Useful for any self-naming anchor pattern (lists with target-derived `entryIdentity` use it; other patterns may also).

These three view methods are **named as generic graph operations**, not list-specific helpers, to keep `EdgeResolver` at the kernel/graph layer. Lists USE them; the methods themselves describe pure PIN/TAG composition. This avoids the layer leak of injecting list-overlay vocabulary into the generic resolver. **A future stand-alone `EFSListView` contract MAY emerge** if list-specific helpers prove desirable beyond what generic graph composition expresses, but is not in v1 scope.

Pre-launch cost: a few hundred lines of view code wrapping existing storage reads. Post-launch cost of NOT having them: every smart-contract consumer reinventing multicall plumbing and diverging on edge cases.

### Single-curator scope (default)

**Metadata authority is per-attester.** Because `memberMode`, `itemSchema`, and `entryIdentity` are PROPERTYs (and PROPERTYs are edition-scoped per ADR-0041 §4), a list read is canonically scoped to **one curator attester**. Read the curator's `memberMode`, their `itemSchema`, their `entryIdentity`, their TAGs, their entry anchors' PINs, and their entry metadata — all from the same attester.

Multi-attester reads (compare/merge UI) are an explicit opt-in (see Editions section). Default reads are single-curator-scoped.

### Reader recipes

**Direct mode (Item List) — using bundled reader:**
```
1. Read listAnchor's metadata PROPERTYs (memberMode, itemSchema) PINned by curator.
   - Validate memberMode == "direct" and itemSchema present.
2. Call EdgeResolver.getActiveTagTargetsWithWeights(listAnchor, curator, itemSchema, start, length).
   - Returns (tagTargetID, tagUID, weight, attester)[] in active TAG bucket order.
   - tagTargetID is the actual item (DATA UID, attestation UID, or address-as-bytes32).
3. Apply default total order: sort by weight desc, tie-break by tagTargetID asc, then tagUID asc.
4. Truncate to client-chosen displayLimit.
```

**Wrapped mode (Entry List) — using bundled reader:**
```
1. Read listAnchor's metadata PROPERTYs (memberMode, itemSchema, entryIdentity) PINned by curator.
   - Validate memberMode == "wrapped"; entryIdentity ∈ {"target","occurrence"}.
2. Call EdgeResolver.getActiveTagPinTargetsWithWeights(listAnchor, curator, ANCHOR_SCHEMA_UID, start, length).
   - Returns (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[] in active TAG bucket order.
   - tagTargetID is the entry anchor UID; pinTargetID is the underlying inner target;
     pinTargetSchema is the entry anchor's declared schemaUID field.
3. For each entry: if pinTargetID == bytes32(0), render warning state (missing inner PIN).
4. If entryIdentity == "target": for each entry, optionally call
     EdgeResolver.validateAnchorNameMatchesPinTarget(tagTargetID, curator) — false → render warning.
5. For metadata: resolve key anchor under entry (e.g., "note"); read PROPERTY value via
     getActivePinTarget(keyAnchor, curator, PROPERTY_SCHEMA_UID).
6. Apply default total order: sort by weight desc, tie-break by tagTargetID (entry-anchor UID) asc, then tagUID asc.
7. Truncate to client-chosen displayLimit.
```

**Lower-level fallback (no bundled reader):** clients lacking the new view methods (or wanting to avoid them for any reason) can compose `getActiveTagEntries` + per-TAG `eas.getAttestation` + `getActivePinTarget` manually. The bundled readers are atomicity-and-convenience; the underlying graph operations remain available.

### Default total order

Where order matters and the curator hasn't declared an alternative scheme:

1. **Weight (`int256`) descending** — higher sorts earlier.
2. **Tie-break by target identity ascending** — for direct mode, by `targetID`; for wrapped mode, by entry-anchor UID.
3. **Final tie-break by `tagUID` ascending** — guarantees deterministic ordering across implementations.

Apps may declare alternative orderings via custom PROPERTYs (e.g., `weightDirection = "asc"`); these are app conventions, not part of the canonical spec. Default direction is descending.

### Sparse weights for manual ordering (SDK SHOULD)

For lists where the curator manually orders items (top-N favorites, playlists, ranked ballots), SDK helpers SHOULD use sparse `int256` weights with periodic rebalance — e.g., initial spacing of 2^32 between items, with rebalance when adjacent weights collide. This is the standard CRDT-style sparse-key approach (Logoot et al.) and gives O(1) insertions without cascade reorder.

Sparse weights are NOT a universal MUST. Lists where weights have semantic meaning — ratings (1–5 stars), votes (count), scores (numeric) — use meaningful weights and accept that "rerank" means "rescore." The `weight desc + tie-break` default works regardless.

### Pages are NOT sorted by weight

`getActiveTagEntries` paginates the active TAG bucket in insertion order (with swap-and-pop on revoke per ADR-0007). Clients producing a sorted top-N MUST fetch all entries, sort locally, then truncate. For very large lists (>>1000 entries), use an off-chain indexer.

**Recommended pagination cap:** `length ≤ 100` per call (matching `EFSSortOverlay.MAX_PAGE_SIZE`) to bound `eth_call` time on multi-read clients.

### Snapshot consistency

Active TAG buckets are NOT snapshot-stable across multiple RPC calls. Swap-and-pop on revoke (per ADR-0007) can shift later array positions between pagination calls; a client paginating may double-count an entry or miss one.

**Smart contracts** calling the v1 readers in a single transaction are naturally snapshot-consistent — the EVM provides atomicity per call. The new bundled helpers (`getActiveTagTargetsWithWeights`, `getActiveTagPinTargetsWithWeights`) preserve this property by completing all reads within one external view call, eliminating multi-call inconsistency for on-chain consumers.

**Off-chain clients** (frontends, indexers) paginating across multiple RPC calls or composing PROPERTY + PIN + TAG reads MUST pin all reads in a single render to the same `blockTag`. Default `wagmi`/`viem` setups do NOT pin `blockTag` automatically across paginated queries — SDK helpers wrapping list reads MUST handle this internally.

**Governance / on-chain consumers** SHOULD read from finalized (or sufficiently confirmed) blocks to avoid reorg sensitivity in vote tallies, membership checks, etc. Reading from `latest` exposes consumers to short-range reorgs that can flip membership between blocks.

### `EFSListView` future helper

A future stand-alone `EFSListView` helper contract MAY be added later if the v1 `EdgeResolver` extensions prove insufficient for emerging use cases. Not in v1 scope; the v1 readers above cover the canonical paths.

---

## Indexer notes (for subgraph implementers)

Subgraph and off-chain indexer implementations consuming list-related events should be aware of these state-tracking concerns:

**Event ordering between TAGs and metadata.** TAG attestations and metadata PROPERTY attestations arrive as separate EAS events. A subgraph processing list-related events MAY see TAG events for `listAnchor` before its `memberMode` PROPERTY exists in indexed state. Indexers SHOULD:
- Track unbound TAG events keyed by `(listAnchor, attester)`; resolve them when metadata appears.
- Render `memberMode = "unknown"` for lists with TAG events but no metadata; surface this state to clients.
- Reprocess pending TAG events when metadata arrives if typed projections matter.

**Active state vs historical state.** `_activeByAAS` reflects current active TAGs (post-revocation). Subgraphs reconstructing list state MUST track revocation events and apply swap-and-pop semantics to mirror the kernel's view (per ADR-0007). A naive "all attestations ever" view will include revoked entries. Use the `Attested`/`Revoked` event pair to maintain accurate active sets.

**Metadata mutability.** A curator can re-attest the metadata-binding PIN to flip `memberMode`, `itemSchema`, or `entryIdentity` post-creation (see Pitfalls). Indexers MUST track the latest declaration per `(attester, listAnchor)` as the active metadata; expose history as a separate query if needed. Treat metadata flips as visibly disruptive events.

**Reverse lookups.** Indexers MAY support "lists containing X" queries internally (different from the canonical UX anti-feature). Use `_targetsByDef` and `_edgeDefinitions` from `EdgeResolver` (per ADR-0041 §8) as ground truth. Apply per-application access policies (typically: subject opt-in only).

---

## Editions and multi-attester reads

Default list reads are **single-curator-scoped** (see Reading lists). Multi-attester is an opt-in for compare/merge UI.

Each attester writes their own TAGs against the same list anchor; per-attester storage in `_activeByAAS[def][attester][schema]` is independent. The design preserves edition independence at every layer.

**Direct mode:** per-attester reads are independent. Alice's top friends and Bob's top friends are separate `getActiveTagEntries` calls.

**Wrapped mode with `entryIdentity = "target"`:** entry anchors are SHARED schelling points — Alice and Bob's "entry for book X" land at the same anchor (the name is a deterministic hash of the target). Each writes their own PIN binding the entry to a target, and their own TAG with their own weight. Multi-attester reads filter by attester at the PIN and TAG level; the entry anchor is shared infrastructure.

**Wrapped mode with `entryIdentity = "occurrence"`:** entry anchors are per-curator (each curator's `clientNonce` differs). Alice's playlist and Bob's playlist have independent entry-anchor sets. A curator who *intentionally* wants to patch another's sequence can reuse an existing occurrence entry anchor and write their own TAG/PIN against it; standard editions semantics apply.

**Merge semantics are not part of this design.** Multi-attester rendering (priority chain, last-write-wins, side-by-side, aggregate, intersection) is client UX. Cross-system precedent (ADR-0031, ADR-0039) currently uses first-wins for path resolution; lists adopting different defaults requires its own ADR. **In v1, multi-attester reads are advisory and clients MUST preserve attribution** — if a merged view is rendered, every visible item carries the attester address that contributed it.

**Forking convention:** Bob "forks" Alice's list by creating his own list anchor (`bob.eth/his-favorite-books`) and writing his own TAGs/PINs/entries. Optionally, Bob's list anchor carries an `originList = <alice_list_uid>` PROPERTY documenting the provenance link. This is a writer convention; the kernel does nothing special for forks. Bob does NOT silently mutate Alice's list anchor — multi-attester writes against Alice's anchor are collaboration semantics, not forking.

---

## Conventions vs enforcement — long-tail risk

This design relies on convention enforcement for several invariants the kernel cannot validate: `memberMode` matches actual storage shape, target-derived entry names match PIN targets, `clientNonce` is CSPRNG-derived, schema buckets aren't fragmented in `direct` mode. **In a federated multi-client system over a 100-year horizon, the corpus will accumulate convention-violating lists** — clients differ in validation rigor; some will be buggy or hostile.

This is an acceptable trade for v1 because the kernel surface stays minimal (no new schemas, no resolver complexity, no Etched commitments). But it has a forcing function. If convention compliance drops below tolerance in the wild, a heavier mechanism becomes necessary.

**Explicit revisit triggers** — promote to a heavier mechanism if any of these become true post-launch:

- **Schema-fragmented `direct` lists exceed a measurable share of the corpus** at any indexed point → promote a `LIST_ITEM` schema OR move validation into a custom resolver on the `memberMode` key anchor.
- **Target-derived entry name mismatches exceed a measurable share of wrapped-target lists** → ship an on-chain validation helper widely OR move validation into a custom resolver.
- **Sequential `clientNonce` patterns appear at the indexer layer** → ship a kernel-side nonce-entropy resolver (rejects predictable nonce inputs at attestation time).
- **Smart-contract consumers report material gas-overhead pain** despite the v1 bundled readers → extend `EdgeResolver` further or ship a stand-alone `EFSListView`.
- **Cross-client divergence on `memberMode` mismatch handling** produces visibly inconsistent renders for the same list → ship a canonical reference SDK that becomes the de facto interpreter, OR move enforcement on-chain.

These triggers are not just operational concerns — they represent the conditions under which "convention only" becomes load-bearing technical debt. Operators MUST track them once lists ship; any firing should prompt an ADR. Specific quantitative thresholds (Y%, Z ms) are filled in by post-launch measurement; the principle is to have an explicit forcing function and avoid drift.

This section IS the design's escape hatch. Smart contracts that consume lists today operate under the assumption that conventions hold; if they don't hold widely, the contract layer has clear paths to shift enforcement on-chain without breaking the existing data model.

---

## Pitfalls and safety

### `memberMode` is renderer intent, not proof

The kernel does not enforce storage shape against `memberMode`. Clients MUST treat the PROPERTY as advisory:

- Declared `direct` but the TAG bucket is empty → render an empty state. Do NOT silently fall back to enumerating children as if it were a folder.
- Declared `wrapped` but no entry anchors exist (or no TAGs against the list with `targetSchema = ANCHOR_SCHEMA_UID`) → same empty/degraded treatment.
- Mixed shapes (some direct-target TAGs and some entry-anchor-target TAGs on the same list) → render a warning state and prefer the declared mode; do not silently interleave.
- Unknown `memberMode` value → advisory failure (render empty/warning). Do not coerce.

### Direct-mode mixed-schema TAGs silently fragment

A curator using `memberMode = "direct"` who writes TAGs against multiple target schemas (some DATA, some attestation, some address) creates entries across multiple `_activeByAAS` buckets. A reader querying with one `itemSchema` sees only that bucket — other entries silently disappear from the view.

This is a real footgun for "top things" lists where the curator wants heterogeneous targets. **The picker rule routes them to wrapped:** if your list contains heterogeneous targets, use `memberMode = "wrapped"` so the outer TAG bucket is uniformly `ANCHOR_SCHEMA_UID` and entries declare their own `schemaUID` for inner-target dispatch.

SDK clients SHOULD detect schema fragmentation when reading a `direct` list (e.g., scan `_edgeDefinitions` per ADR-0041 §8 for the curator's other schema buckets at this list anchor) and warn the user.

### Wrapped-list invalid-entry behavior

For each entry in a wrapped list, four invalid states are possible:

- **Missing PIN:** `getActivePinTarget(entry, curator, entry.schemaUID) == bytes32(0)` — curator wrote a TAG and an entry anchor but never PIN'd a target. Render warning state for that entry; do NOT treat as the address sentinel.
- **Schema mismatch:** entry's `schemaUID` is not in the list's `itemSchema` PROPERTY (when `itemSchema` is set on a wrapped list). Render warning; surface as a constraint violation.
- **Target-derived name mismatch:** with `entryIdentity = "target"`, the entry name doesn't match the canonical hex of the resolved target. Render warning state OR suppress the entry (see "Entry-anchor squatting" below).
- **Revoked PIN:** the curator revoked the entry's target PIN but didn't revoke the TAG. Active TAG against an entry with no active PIN — render warning; treat as missing PIN.

Clients MUST surface these conditions visibly; never silently render incorrect content.

### Entry-anchor squatting and target validation (`entryIdentity = "target"` only)

The protocol does NOT enforce that an entry anchor's name matches the target its PIN binds to. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target. For wrapped lists with `entryIdentity = "target"`, clients MUST validate name ↔ target consistency:

1. Read entry anchor's `schemaUID`.
2. Resolve target via `getActivePinTarget(entry, attester, entry.schemaUID)` — returns `bytes32(0)` on missing PIN; treat as invalid.
3. Compute expected name from `targetID`:
   - `schemaUID == bytes32(0)` (address) → `0x` + lowercase hex of low 160 bits (42 chars total)
   - else → `0x` + lowercase hex of full `targetID` (66 chars total)
4. Mismatch → render warning state OR suppress the entry; never silently treat as valid.

Smart contracts can perform this check via a single call: `EdgeResolver.validateAnchorNameMatchesPinTarget(entryAnchor, attester) → bool`. Same logic, atomic, no SDK needed.

For `entryIdentity = "occurrence"`, this validation does not apply — names don't encode the target. Re-PINning an occurrence-derived entry to a different target is the *intended* affordance.

### Target universe: not everything can be a TAG target

TAG `refUID` must point at an existing EAS attestation. **Raw schema UIDs are NOT valid TAG targets** — schemas exist in EAS as registry entries, not attestations. Schema registries (e.g., a list of trusted DATA schemas) MUST target schema-alias anchors per ADR-0033, not raw schema UIDs.

Similarly, `recipient` is the only valid path for address targets; addresses cannot be wrapped into "address attestations" without an explicit anchor or DATA representation.

When in doubt: if the thing you want to list has an EAS attestation UID or is an address, you can target it; if it doesn't (raw schemas, contract addresses without attestations, off-chain identifiers), it doesn't belong in an EFS list.

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

### `memberMode` mutability creates internally-inconsistent lists

`memberMode`, `itemSchema`, and `entryIdentity` are PROPERTYs bound to the list anchor via PIN (cardinality-1 per attester). Re-attesting the binding PIN with a new PROPERTY value supersedes the prior in O(1) — a curator can flip `memberMode = "direct"` to `"wrapped"` instantly without any TAG storage migration.

The list is now in an internally inconsistent state: declared `wrapped` but populated with direct-mode TAGs (or vice versa). Readers honoring the declaration drop the existing data; readers inferring from storage display old data labeled as new mode. **Two clients diverge.**

Mitigations:
- **SDK helpers MUST refuse to flip `memberMode` post-creation.** Curators wanting to change mode revoke the old list and create a new one; their old data stays under the old declaration with history preserved.
- **Smart contracts SHOULD validate** `memberMode` declaration against actual storage shape using the v1 readers — call `getActiveTagTargetsWithWeights` with the schema implied by `memberMode` and compare the result count to a separate query against alternative schemas.
- **Readers MUST detect mismatches** and render warning state (per `memberMode` is renderer intent, not proof above).
- **Future kernel mitigation** (long-tail risk trigger): constrain `memberMode` to single-write via a custom resolver on the metadata key anchor; not in v1 scope but escape-hatch documented.

The same logic applies to `entryIdentity` — flipping it post-creation invalidates entry name validation and breaks `validateAnchorNameMatchesPinTarget` semantics.

### `clientNonce` entropy is unenforceable at the kernel

The MUST that `clientNonce` ≥ 128 bits CSPRNG is **convention only**. Sequential nonces, monotonic counters, and CSPRNG output all look identical to the kernel — `keccak256(...)` produces a 32-byte hash regardless of input entropy. **The kernel cannot tell the difference.** SDK enforcement is the only gatekeeper, which means hostile or buggy SDKs can violate this convention freely.

**Smart contracts consuming wrapped-occurrence lists SHOULD treat the entry's UID as the trust unit, NOT the entry name pattern.** Specifically:

- Do not assume the entry name is unguessable. An attacker who guessed the curator's `clientNonce` could pre-create an entry anchor at the predicted name with a hostile PIN. The squatting validation rule for target-derived entries does NOT apply to occurrence-derived entries because the name doesn't encode the target.
- Validate by attestation chain: did the curator's TAG point at this entry UID? If so, the curator endorses this entry regardless of name structure. The TAG is the membership claim; the name is a label, not a credential.
- The `validateAnchorNameMatchesPinTarget` helper does NOT validate occurrence-derived entries. They have no on-chain validation primitive; the trust unit is the curator's TAG attestation itself.

This is the residual security risk from kernel-unenforceability. The worst case is "the curator's own client used weak nonces and someone preempted them" — the attacker still needs the curator to write a TAG against the squat anchor for it to be "in" the list, and the curator's own SDK should refuse to write that TAG (because it would detect that the anchor it expected to create already exists). Compromised curator client + compromised attacker = squatting attack succeeds; honest implementations are safe.

If sequential-nonce patterns appear at scale post-launch, the long-tail risk trigger fires and a kernel-side nonce-entropy resolver becomes necessary.

### ADR-0042 effective-TAG filter does NOT apply to lists by default

ADR-0042 establishes "effective TAG = active TAG with `weight ≥ 0`" as a client convention for the explorer's descriptive-label filter. **This convention does not apply to custom lists.** A blocklist with `weight = 0` is active membership; a rating with `weight = -3` is a meaningful low score. Apps MAY apply a `weight ≥ 0` filter for their own UX reasons, but the canonical default for list rendering is "active = unrevoked," with weight used only for ordering.

---

## Decisions resolved

These were the architectural decisions made during cross-agent design review.

1. **Two member patterns (direct, wrapped), one primitive (weighted TAG set).** Earlier drafts had P1/P1.5/P2 as distinct types; the previous P1.5 (target-keyed entry anchors) and P2 (occurrence-keyed) collapse into one wrapped pattern with `entryIdentity` distinguishing them.
2. **Folders are not lists.** Sorted folders are folders with `SORT_INFO`; no `memberMode` PROPERTY applies.
3. **Lists are not a new EAS primitive.** Existing PIN, TAG, ANCHOR, PROPERTY suffice. No new schemas; no Etched commitments at the schema layer.
4. **Smart contracts read directly; v1 ships the bundled readers as generic graph operations.** Three view methods on `EdgeResolver` ship in v1 — `getActiveTagTargetsWithWeights`, `getActiveTagPinTargetsWithWeights`, `validateAnchorNameMatchesPinTarget`. Named as graph composition (not list-specific) to keep `EdgeResolver` at the kernel layer. Lists USE them; the methods themselves describe pure PIN/TAG composition. Data structures + public APIs are immutable post-1.0; SDK enforcement cannot be assumed because smart contracts read directly.
5. **Multi-attester merge is informative, not normative.** Default reads are single-curator-scoped; multi-attester is opt-in for compare/merge UI; merge conventions need their own ADR (and would interact with ADR-0031/0039 alignment).
6. **Minimal metadata: `memberMode`, `itemSchema`, `entryIdentity`.** Display PROPERTYs are app convention until cross-app interop value emerges.
7. **`/lists/` ships empty.** Protocol identity does not seed predicates. EFS Team multi-sig may seed recommended predicates separately later.
8. **UX warnings are advisory.** Attribution labeling is the load-bearing safety primitive; first-publish confirmation is at client discretion.
9. **`specs/06` rewrite required before dev writes list data.** Will describe direct + wrapped patterns explicitly; supersede `specs/08`.
10. **`clientNonce` ≥128 bits CSPRNG is convention, not contract-enforced.** Kernel cannot distinguish weak nonces from CSPRNG output; smart contracts treat occurrence-derived entry UIDs (not names) as trust units.
11. **Default total order: weight desc, tie-break by target/entry UID asc, then tagUID asc.** Apps may declare alternatives via custom PROPERTYs.
12. **Sparse `int256` weights are an SDK SHOULD for manual ordering, NOT a universal MUST.** Ratings, votes, and scores use meaningful weights.
13. **Snapshot consistency MUST: pin paginated reads to a single `blockTag`.** On-chain single-call reads are naturally consistent; off-chain multi-call clients MUST pin. Governance consumers MUST read finalized blocks.
14. **Convention-violating lists are an accepted v1 risk with explicit revisit triggers.** See Conventions vs enforcement section. The design includes named conditions under which to promote enforcement on-chain post-launch.

---

## Out of scope for v1 / future work

- **Stand-alone `EFSListView` helper contract** — the v1 `EdgeResolver` extensions cover canonical read paths; a separate view contract MAY be added later if emerging use cases demonstrate need beyond what kernel-extensions provide.
- **`displayLimit`, `weightMeaning`, `weightDirection`, `tieBreak`, etc.** — apps use generic PROPERTYs; spec stays minimal until cross-app conventions emerge.
- **`itemSchemas` (plural) for declared multi-schema lists** — defer; mixed-schema lists are wrapped lists with diverse inner PINs.
- **Multi-attester merge conventions** — needs its own ADR; interacts with ADR-0031/0039 alignment.
- **Sort overlay extension for TAG sources** — `EFSSortOverlay` doesn't currently support TAG buckets; defer until concrete demand.
- **Cross-attester aggregation primitives** — Sybil-resistance scoping required.
- **Computed lists** — predicate-derived membership (iTunes Smart Playlist analog).
- **Reverse-lookup APIs as default UX** — see Non-goals; index-level reverse lookups exist but should not be canonical UX.
- **`specs/06` rewrite** — describe direct + wrapped patterns explicitly; supersede `specs/08`. **Required before dev writes list data.**
- **FractionalSort** — kept parked as a possible future read/index optimization for huge ordered lists; not part of the v1 list model.
- **`web3://<list-anchor>` ERC-5219 read shape** — router-layer concern; separate from list data model.
- **Custom resolver on `memberMode` key anchor** — to constrain post-creation flips. Long-tail risk trigger; not in v1 unless mutability proves harmful.
- **Kernel-side nonce-entropy resolver** — to reject sequential `clientNonce` at write time. Long-tail risk trigger.

---

## Appendix — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **One mode only** ("always-wrapped" — every list is wrapped) | Conceptually elegant but taxes the dominant case (top-N favorites, allowlists) at ~3× attestation cost and creates EAS state per address listed (asymmetry between "things in EFS" and "people on the network"). The simplification doesn't earn its weight. |
| **Three or four distinct types** (the previous P1 / P1.5 / P2 / P3 alphabet) | P1.5 and P2 are mechanically identical except for entry naming — they're one pattern with an `entryIdentity` marker, not two types. Folders aren't lists. Multi-pattern vocabulary creates classification burden without semantic payoff. |
| **New `LIST_ITEM` schema** | Permanent Etched commitment for marginal benefit. Existing primitives + advisory metadata cover the design space. |
| **JSON manifest as list metadata** | One DATA per list; bulk-readable but not independently rebindable. ADR-0034 individual-PROPERTY idiom is cheaper to update and matches existing convention. |
| **Contractual schema enforcement** (custom resolver rejecting non-allowed targets) | Federated systems can't enforce write-time type constraints meaningfully. Advisory + reader-side filtering is the durable primitive. |
| **Multi-attester merge as normative in core design** | Couples list semantics to client UX choices and conflicts with ADR-0031/0039's existing first-wins precedent. Deferring keeps the design portable; a separate merge ADR can land later. |
| **Allowlist `allowedTargetSchemas`** (CSV of multiple schema UIDs) | Mixed-schema lists are rare; can be expressed as wrapped lists with diverse inner PINs. Singular `itemSchema` keeps the v1 spec minimal and adds plural variant later only if needed. |
| **Stand-alone `EFSListView` contract in v1** | The bundled reader extensions on `EdgeResolver` (`getActiveTagTargetsWithWeights`, `getActiveTagPinTargetsWithWeights`, `validateAnchorNameMatchesPinTarget`) — named as generic graph operations, not list-specific helpers — cover the canonical paths smart contracts and frontends need without introducing a new contract or a kernel-level layer leak. A separate view contract may be added later if list-specific helpers prove desirable beyond what generic graph composition expresses. |
| **Deferring all bundled readers to post-launch** | Earlier rounds proposed shipping no helpers in v1 and adding them only on demand. Rejected after validation pass: data structures + public APIs are immutable post-1.0; SDK enforcement cannot be assumed because smart contracts read directly. The v1 `EdgeResolver` extensions are a small pre-launch commitment that prevents post-launch fragmentation across consumers reinventing multicall plumbing. |
| **Positional anchors + FractionalSort for sequences** | Sparse `int256` weights with periodic rebalance handle reorder in O(1) using ordinary TAG-weight machinery. FractionalSort and `a0/a1/a2` naming buy nothing the unified design doesn't already provide. |
| **`entryIdentity` as writer convention only** | Without machine-readable declaration, clients couldn't reliably determine when name-target validation applies. Promoting to a required PROPERTY for wrapped lists is honest about the policy. |
| **Universal sparse-weight MUST** | Ratings, votes, and scores use meaningful weights; forcing sparse spacing breaks those use cases. Sparse weights are an SDK SHOULD for manual ordering only. |

---

## Implementation sketch (informative)

For an eventual implementation plan; not prescriptive here.

**v1 shipping units (committed pre-launch):**
1. **`EdgeResolver` extensions** — three new generic graph-composition view methods:
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]`
   - `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool`

   These bundle existing reads into single atomic calls. Named as generic graph operations to avoid layer-leaking list vocabulary into the kernel resolver.

2. **Reserved-key anchor names** (`memberMode`, `itemSchema`, `entryIdentity`, `note`) — added to deploy script alongside ADR-0034 reserved keys.
3. **SDK helpers** (`efs.lists.read`, `efs.lists.write`) wrapping the reader API + write conventions:
   - `canonicalEntryAnchorName(targetID, schemaUID) → string` — single source of truth for name canonicalization
   - `cryptoRandomNonce() → bytes32` — CSPRNG `clientNonce` generator
   - `readListPagedSnapshot(listAnchor, attester, opts)` — internally pins `blockTag` across paginated reads (default `wagmi`/`viem` doesn't); enforces single-curator scope
   - Mode-flip guard: refuses to re-attest `memberMode`, `itemSchema`, or `entryIdentity` post-creation (per Pitfalls)
4. **Frontend list-renderer** in `packages/nextjs/` debug UI — minimal demonstration of direct and wrapped lists against seeded demo lists.
5. **Spec rewrite:** `specs/06-Lists-and-Collections.md` describes direct + wrapped patterns explicitly; `specs/08` marked as superseded design notes.
6. **Optional demo seed:** one direct list and one wrapped list under the demo tree (`08_seed_demo_tree.ts`), flagged demo-only.

**Likely ADR shape:**
- ADR-A: Custom Lists — direct + wrapped member patterns, metadata convention (`memberMode`, `itemSchema`, `entryIdentity`), reading conventions, ordering rule, edition independence, public reader API extensions on `EdgeResolver`.

**Spike candidates (parallel with ADR drafting):**
- Implement and gas-measure the three new `EdgeResolver` view methods. Each is a thin wrapper over existing reads; the spike validates assumed gas profiles for typical list sizes (8 friends, 50 favorites, 100 entries).
- End-to-end direct + wrapped contract test (validates ADR-0041 §4 in-place re-attest).
- Multi-attester edition test (validates shared schelling-point entry anchors under `entryIdentity = "target"`).
- Anchor-name validator dry-run on 42-char and 66-char hex.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, with parallel research subagents and a multi-round dialogue mediated by James Carnley. Six rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md).
