# EFS Custom Lists — Design

**Status:** Draft
**Date:** 2026-04-24
**Permanence-tier:** Durable (sets stable conventions over Etched primitives; introduces no new schemas)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming)
**Related:** ADR-0030, ADR-0031, ADR-0034, ADR-0038, ADR-0039, ADR-0041, ADR-0042; specs/02, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — exploratory thoughts, design history, parked ideas

---

## TL;DR

EFS lists are **not a new primitive**. They are documented patterns over existing primitives (PIN, TAG, ANCHOR, PROPERTY, SORT_INFO).

Three list-shaped patterns plus folders:

| Pattern | One-liner | Best for |
|---|---|---|
| **P1 — Ranked Set** | Weighted TAGs targeting items directly | Top-N, favorites, allowlists, ratings — no per-entry notes, no duplicates |
| **P1.5 — Entry-Anchor Set** | Entry anchors named by target hash; PIN to target, TAG-weight, PROPERTYs | Same as P1 but with per-entry metadata that survives reorders |
| **P2 — Occurrence Sequence** | Entry anchors named per-occurrence (keccak); same shape otherwise | Sequences with duplicates — playlists, syllabi, ranked ballots |
| **P3 — Sorted Folder** | Existing folder + optional SORT_INFO | File libraries; not a curated list |

P1, P1.5, and P2 are three points on one spectrum — same TAG-weight ordering, same `EFSListView` read primitive, same metadata convention. They differ only in whether/how entries wrap targets (per-target hash for P1.5; per-occurrence for P2) and which use cases each fits best.

**v1 ships P1, P1.5, P2, P3** plus a metadata convention and a stateless `EFSListView` read helper. The MySpace top-8 / top-10 use case lands cleanly on P1.

---

## Decisions resolved

These were the open decisions during cross-agent review. All resolved by the project owner; the design body below reflects them in detail.

### 1. Multi-attester merge — client convention, priority-union, rightmost wins

When viewing `alice.eth/fav_friends?editions=alice,bob,carol`, the recommended client default is **priority-union with rightmost wins** — items are pooled across all listed attesters; for items multiple attesters disagree on, the **rightmost** attester wins (matches URL/path specificity convention: most-specific-rightmost). So `?editions=alice,bob` reads naturally as "Alice base, Bob layered on top."

**This is a client rendering convention, not a data-layer commitment.** The contracts/kernel don't know about merge mode. The `EFSListView` read primitive is single-attester; clients call it once per attester and merge in their own code. Standardizing the URL convention (`?merge=`) lets multiple EFS clients agree on rendering, but no enforcement happens on-chain.

v1 client convention recommendations:
- **Default** (no `?merge=` flag): priority-union, rightmost wins
- **Opt-in** (`?merge=parallel`): render attesters' rankings side-by-side as separate columns
- **Other modes** (aggregate, intersection, explicit last-write): not v1-recommended; clients may implement but with use-case-specific reasoning

📎 [Full detail: Recommended URL conventions for clients](#recommended-url-conventions-for-clients)

### 2. `/lists/` ships empty

Protocol identity (`efs.eth` / deployer) creates `/lists/` as an empty root namespace at v1 deploy. No predicates seeded — protocol identity is reserved for system facts (schemas, deployment metadata), not curatorial recommendations. A separate EFS Team multi-sig will populate recommended predicates later (out of scope of this design).

📎 [Full detail: Discovery](#discovery)

### 3. P2 (Occurrence Sequence) folded into v1

P2 was previously deferred behind FractionalSort. It's now unified with P1.5 as "entry anchors named per-occurrence" (vs P1.5's "entry anchors named per-target-hash"). FractionalSort is unnecessary; sparse `int256` weights handle reorder. P2 ships in v1 alongside P1 and P1.5.

📎 [Full detail: P2 — Occurrence Sequence](#p2--occurrence-sequence)

### 4. UX warning softened from MUST to MAY

The previously-proposed `visibilityWarning` first-publish-confirmation modal was over-paternalistic — following / listing other users is normal social behavior, and consumer products don't gate it with friction. Spec language softened from MUST to MAY; the `visibilityWarning` PROPERTY remains as advisory metadata clients can use if they have a concrete safety-tier reason, but no spec-floor warning text is mandated.

📎 [Full detail: Pitfalls — Lists of people](#lists-of-people-are-public-durable-and-irreversible) and [Q2 — UX warning](#q2--ux-warning-language-for-social-lists-advisory-only)

### 5. `EFSListView` shipped as stateless redeployable

A stateless `EFSListView` contract (analogous to `EFSFileView`) ships in v1. Single-attester, single-schema, paginated by `(start, length)`. Solves the N+1 target-resolve problem without storage changes. No multi-attester merge helper in v1 — client-side composition is sufficient and keeps merge semantics out of the contract layer.

📎 [Full detail: Read primitive — EFSListView](#read-primitive--efslistview)

### 6. `specs/06` rewrite deferred until this design lands

`specs/06-Lists-and-Collections.md` will be rewritten around the unified P1/P1.5/P2/P3 alphabet, superseding `specs/08` as design notes. Deferred until this design fully settles to avoid wasted token spend on prose that may shift. Tracked as a follow-up task.

---

## Why this matters

EFS will accumulate user-curated lists for the next 100 years: top friends, favorite memes, blocklists, allowlists, ratings, registries, ranked endorsements, bookmarks. The shape we publish at v1 sets every list shape downstream consumers (subgraphs, smart contracts, UIs) ever encounter.

Two cross-agent research surveys converged on the same finding: **single-typed lists are the consumer sweet spot** (Letterboxd films, Spotify tracks, Pinterest pins), generic "anything" lists rot at trust boundaries, and allowlists work in bounded sets where each item carries a discriminator. EAS gives us a free discriminator (every attestation carries its `schema` UID), so the trichotomy reduces to "how many target schemas does this list permit?"

---

## Decisions and rationale

### D1 — Lists are not a new EAS primitive

**Decision:** Use existing PIN, TAG, ANCHOR, PROPERTY, SORT_INFO. No new `LIST` or `LIST_ITEM` schema is introduced.

**Why:**
- New EAS schemas are Etched and irreversible (schema UIDs hash field strings; no migration path).
- Existing primitives express the full design space cleanly when patterns are documented.
- ADR-0041's `int256 weight` on TAG was added explicitly to enable ranking metadata of this kind.
- A new primitive only earns its keep if existing patterns demonstrably can't express something. That bar isn't met.

**Alternative rejected:** a `LIST_ITEM` schema wrapping `(target, listDef, weight, targetSchema)`. Would yield cleaner subgraph types and contractual schema enforcement, but at cost of a permanent new schema UID and parallel resolver. Tier-1 commitment without justification.

### D2 — Three list shapes, picked by structural concerns

**Decision:** Picker rule:

```
Need duplicate occurrences of the same target?  → P2 (Occurrence Sequence)
Need per-entry metadata on unique targets?      → P1.5 (Entry-Anchor Set)
Else                                            → P1 (Ranked Set)
```

P3 (Sorted Folder) is not a curated list; it's an ordinary folder with a render order applied. Mentioned for completeness; nothing new needed.

**Why:** P1, P1.5, and P2 share the same machinery (TAG-weight ordering, `EFSListView` read primitive, metadata convention) and differ only in whether/how items are wrapped in entry anchors. The picker is honest about which use case each fits without forcing one pattern to cover all.

### D3 — Ranked Set (P1) is the v1 MySpace primitive

**Decision:** P1 is the canonical v1 path for top-N and favorites use cases.

```
TAG(definition=listAnchor, refUID|recipient=item, weight=rank, attester=alice)
```

**Why:**
- ~4 attestations for 3 items vs ~10 for positional anchors.
- O(1) reorder via re-attestation at same `edgeHash` (ADR-0041 §4 — "updates an existing entry's UID and weight in place").
- Per-attester storage is naturally sortable: `_activeByAAS[def][attester][schema] → TagEntry[]`, single bulk SLOAD per ADR-0041 §7.
- Items keep their own canonical home; the list is pure weighted membership claim from an attester.
- Multi-attester editions handled natively via priority chain (ADR-0039).
- Native handling of address targets (`recipient`) and attestation targets (`refUID`) — covers "top 8 friends" (addresses) and "top 10 memes" (DATA) uniformly.

### D4 — Anchor scope (personal vs global) is convention, not kernel concern

**Decision:** A list anchor is just an anchor. Location is convention:
- Personal: `alice.eth/fav_friends`
- Global shared predicate: `/lists/fav_friends`
- Ad-hoc nested: `alice.eth/projects/2026-reading-list`

The kernel only consumes `definition: bytes32` (the list anchor's UID). Path-tree topology is layered on top.

**Why:** decouples the mechanism design from the registry/discovery design. TAG semantics and discovery conventions can ship and iterate independently.

### D5 — Sort overlay is NOT extended for TAG sources in v1

**Decision:** For ranked sets, clients sort `TagEntry[]` arrays in JS after a single bulk SLOAD via `getActiveTagEntries`. No SORT_INFO required for P1. The existing `EFSSortOverlay` is **not** extended to support TAG-bucket sources.

**Why:**
- The existing overlay's `_lastProcessedIndex` invariant assumes append-only kernel arrays. TAG buckets use swap-and-pop on revoke (ADR-0007), which would break the invariant.
- Bulk SLOAD + client-side sort is sufficient for the realistic list-size range (≤1000). Even on-chain consumers can sort in calldata cheaply.
- Pagination concerns surface only at 10K+ entries — a future concern handled by off-chain indexers.
- Avoids an Etched commitment to a TAG-source storage shape that would be hard to revisit.

**Future:** TAG-source extension can land later if a concrete contract-consumer use case demands lazy paginated sorted access over very long ranked sets.

### D6 — Schema constraints via `allowedTargetSchemas` PROPERTY

**Decision:** The list anchor optionally carries `allowedTargetSchemas`, expressing the **logical item types** the curator intends:
- One schema UID → single-typed list (canonical on-chain readable case)
- Multiple schema UIDs → allowlist (small N, on-chain readable with N bucket queries)
- Absent or `"any"` → generic; **requires off-chain indexer** support for enumeration

Address-target TAGs (recipient-typed, no target attestation) are represented by the **`ADDRESS_TARGET` sentinel = `bytes32(0)`** (32 zero bytes). An allowlist that permits both DATA targets and address targets would have `allowedTargetSchemas = "<DATA_SCHEMA_UID>,0x0000000000000000000000000000000000000000000000000000000000000000"`.

Enforcement is **client-advisory**, not contractual.

**P1 vs P1.5 — what `allowedTargetSchemas` actually selects:**

`allowedTargetSchemas` describes the **logical item type**, but the **TAG bucket** clients query in `EFSListView` is different across patterns:

- **P1 (TAGs target items directly):** Each value in `allowedTargetSchemas` is the `targetSchema` passed to `getRankedSetEntriesPage`. To enumerate a P1 list with two allowed schemas, the client makes one helper call per schema and merges (then sorts, then truncates — see Read primitive section).
- **P1.5 (TAGs target entry anchors):** The TAG bucket is **always** `ANCHOR_SCHEMA_UID` because the TAG's target is the entry anchor, not the underlying item. `allowedTargetSchemas` describes the **inner** target schemas — the schemas of the targets each entry anchor's PIN binds to. Clients query `targetSchema = ANCHOR_SCHEMA_UID` once to enumerate entries, then resolve each entry's inner target using the entry's declared schema (see P1.5 entry anchor `schemaUID` convention below).

So `allowedTargetSchemas` is the user-meaningful constraint ("this list holds books"); the actual TAG bucket lookup is pattern-specific. Clients reading lists MUST consult `listKind` first (D2) to decide which pattern's read recipe to use.

**Why:**
- TAG buckets are keyed by `(def, attester, targetSchema)`. To enumerate a mixed list, the reader must know which target schemas to query. `allowedTargetSchemas` answers that.
- Federated systems can't enforce write-time type constraints meaningfully — anyone can attest anything; readers always do the real filtering.
- Single-typed is the consumer sweet spot; allowlist degrades gracefully; generic is the explicit "off-chain indexer required" tier.

This nudges users toward typed lists by making them genuinely cheaper to read on-chain, which aligns with the consumer pattern findings.

### D7 — Stateless `EFSListView` is the read primitive

**Decision:** Add a stateless `EFSListView` contract (analogous to `EFSFileView`) with a paginated, **single-attester, single-schema** signature: `getRankedSetEntriesPage(listAnchor, attester, targetSchema, start, length) → (RankedEntry[], nextStart)`. Returns `(targetID, tagUID, weight, attester)` tuples by internally batching `eas.getAttestation(tagUID)` reads. Multi-attester merge semantics, allowlist composition, generic-schema enumeration, and **sorted-rank views** are explicit client concerns layered on top.

`length` SHOULD be capped at `MAX_PAGE_LENGTH = 100` per call to bound `eth_call` time (matching `EFSSortOverlay.MAX_PAGE_SIZE`).

**Critical caveat — pages are NOT sorted by rank.** The helper returns entries in **active TAG bucket order** (insertion order with swap-and-pop on revoke), not in weight order. `length=10` does **not** mean "top 10." Clients implementing `displayLimit` MUST fetch all relevant entries, sort client-side by weight + tie-break, then truncate. This is a deliberate v1 boundary: lazy sorted pagination over TAG buckets requires extending `EFSSortOverlay` (D5 deferred), so v1 supports list sizes where "fetch-all + sort + truncate" remains cheap (≤ ~1000 entries comfortably). Sorted pagination over very long lists belongs to off-chain indexers or a future overlay extension.

**Why:**
- ADR-0041's `TagEntry` is `(tagUID, weight)` — does not include `targetID`. Resolving target identity is N+1 EAS reads if done naively.
- A view contract solves this without storage changes or kernel commitments.
- Storage widening (`TagEntry → {tagUID, targetID, weight}`) is a Tier-1 supersession of ADR-0041 §7 and not justified by current demand.
- **Single-attester paginated** (not multi-attester opaque-cursor) keeps merge semantics out of the helper. Multi-attester pagination would force per-attester offsets in the cursor, and an opaque cursor risks accidentally baking in a merge default before Q1 is resolved. Active TAG buckets are compact arrays — numeric `(start, length)` is the natural shape; multi-attester views are composed by clients.
- The name `…EntriesPage` (not `…RankedSetPage`) avoids implying that pages are sorted by rank — a real foot-gun if the helper is mis-used.

### D8 — Top-N is presentation metadata, not data-model

**Decision:** A `displayLimit` PROPERTY on the list anchor signals "render top 8" or "render top 10". The data model holds an unbounded weighted set; the renderer truncates.

**Why:** matches universal convention from MySpace top-8 through Spotify/X pinned items — fixed-N is a UI/signaling device, never load-bearing in storage. Caps in storage would force migrations when use cases shift.

---

## Structural alphabet — concrete patterns

### P1 — Ranked Set

**When:** items have own identity, no duplicates, no per-entry metadata beyond rank.

**Attestation graph for "Alice's top 3 memes":**
```
ANCHOR(name="top-memes", refUID=alice_home)                          → listUID
TAG(definition=listUID, refUID=catDataUID,     weight=100, alice)
TAG(definition=listUID, refUID=hamsterDataUID, weight=90,  alice)
TAG(definition=listUID, refUID=dogDataUID,     weight=80,  alice)
```

**Read shape:** `EFSListView.getRankedSetEntriesPage(listUID, alice, DATA_SCHEMA_UID, start, length)` returns `RankedEntry[]` in active TAG bucket order (NOT sorted). Client paginates until exhausted, then sorts by weight + tie-break per the list's `weightDirection` / `tieBreak` conventions, then truncates to `displayLimit`. For multi-attester views, call per attester and compose per Q1's chosen merge mode.

**Reorder cost:** one re-attestation at same `edgeHash` (alice, target, listUID). Updates weight in place per ADR-0041 §4.

**Multi-attester:** Bob writes his own TAGs against the same `listUID`. Editions priority chain (ADR-0039) selects whose view to render.

**Cost:** ~1 anchor + N TAGs.

**Limitations:**
- No duplicates of same target by same attester (edgeHash collision).
- No per-entry metadata that survives reorders (TAG UID changes on rerank, orphaning attached PROPERTYs).
- Generic mixed-schema lists need off-chain indexer for enumeration.

### P1.5 — Entry-Anchor Set

**When:** items are unique (no duplicates) but each entry needs metadata that survives reorders ("here's why I love this", display order, accession date).

**Attestation graph for "Alice's annotated top 3 books":**
```
ANCHOR(name="favorite-books", refUID=alice_home)                              → listUID

# Per entry: entry anchor (declares inner schema) + target binding + weighted membership + metadata
ANCHOR(name="<bookA-target-hex>", refUID=listUID, schemaUID=DATA_SCHEMA_UID)  → entryA
PIN(definition=entryA, refUID=bookA_DATA, attester=alice)
TAG(definition=listUID, refUID=entryA, weight=100, attester=alice)
PROPERTY(value="Changed how I think about systems")                           → noteA_prop
Anchor<PROPERTY>(name="note", refUID=entryA)                                  → noteA_key
PIN(definition=noteA_key, refUID=noteA_prop, attester=alice)
... (entryB, entryC similarly)
```

P1.5 is structurally **"P1 over entry anchors"**: the TAG against `listUID` provides membership and weight (same machinery as P1, with the outer `targetSchema = ANCHOR_SCHEMA_UID`); the entry anchor wraps the actual target with stable identity for metadata; the entry anchor's `schemaUID` field declares the inner target schema (see "Entry anchor `schemaUID` convention" below).

**Read shape:** call `EFSListView.getRankedSetEntriesPage(listUID, alice, ANCHOR_SCHEMA_UID, start, length)` to enumerate entry anchor UIDs in active TAG bucket order. Paginate until exhausted, sort by weight + tie-break, truncate. For each entry anchor, read its `schemaUID` field to learn the inner target schema, then resolve the actual target via `EdgeResolver.getActivePinTarget(entry, alice, entry.schemaUID)`; read note / display-metadata PROPERTYs from the entry anchor as needed. Validate that the entry anchor's name matches the resolved target per the schema-aware rule (see Pitfalls — entry-name spoofing).

**Entry anchor `schemaUID` convention:** entry anchors SHOULD set `schemaUID` equal to the inner target schema (e.g., `DATA_SCHEMA_UID` for a books-of-DATA list). For address-target entries, `schemaUID = ADDRESS_TARGET = bytes32(0)`. This mirrors how naming anchors set `schemaUID = SORT_INFO_SCHEMA_UID` for sort discovery (specs/07) and how schema-alias anchors are declared (ADR-0033). Clients use this to know what to pass to `getActivePinTarget` without trying every schema in `allowedTargetSchemas`.

**Reorder cost:** re-attest the TAG at the same `edgeHash` with new weight — O(1) supersede per ADR-0041 §4. Same mechanism as P1.

**Multi-attester:** entry anchor is a shared schelling point; per-attester PINs handle multiple attesters' target bindings; per-attester TAGs (via the standard editions filter) handle multiple attesters' rankings of the same entry without disturbing each other.

**Cost:** ~1 list anchor + per entry: 1 entry anchor + 1 target PIN + 1 weight TAG + (1 PROPERTY + 1 key anchor + 1 PIN) per metadata field. ~4 attestations per entry without notes; ~7 with one note field.

**Naming convention:** entry anchor name SHOULD be the **canonical lowercase hex rendering of the underlying target**, schema-aware:
- **UID targets** (DATA, ANCHOR, attestation, etc.): name = `0x` + 64 lowercase hex chars (66 chars total).
- **Address targets** (`schemaUID = ADDRESS_TARGET`): name = `0x` + 40 lowercase hex chars (42 chars total — the canonical Ethereum address form, derived from the low 160 bits of `targetID`).

Both attesters writing to the "same entry" land on the same anchor. This mirrors ADR-0033's schema-alias-anchor convention. **Address `targetID` is `bytes32(uint160(addr))` (zero-padded to 32 bytes); rendering it as a 66-char hex would NOT match the canonical address form** — clients computing the expected name MUST drop the leading 24 zero bytes for address targets.

**Limitations:** higher attestation count than P1; no duplicates of the same target.

### P2 — Occurrence Sequence

**When:** sequences with duplicates of the same target — playlists where the same track plays twice, syllabi with repeated prerequisites, ranked ballots, exhibits with re-shown items, step-by-step guides.

**Structurally:** P2 is the same machinery as P1.5 (entry anchor + PIN to target + TAG-weight ordering + PROPERTYs for metadata). The only difference is **entry anchor naming**: P1.5 names by target hash (target-keyed; uniqueness enforced because two attestations naming the same anchor land at the same UID); P2 names per-occurrence (occurrence-keyed; the same target can appear at multiple distinct entry anchors).

**Naming convention (entry anchor):**

```
entry name = lowercase 0x + 64 hex of:
  keccak256("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce)
```

`clientNonce` is a client-generated value the curator picks (counter, random bytes, etc.). The hash is purely a uniqueness device; it does NOT include `targetID` so that an entry's identity survives a target re-PIN (curator can change which DATA the entry binds to without losing entry identity or its accumulated metadata).

Free-form names are allowed as an advanced escape hatch but not the canonical convention; the standard hash form is what clients compute by default.

**Attestation graph for "Alice's playlist with 'Bohemian Rhapsody' played twice":**
```
ANCHOR(name="alices-playlist", refUID=alice_home)                                  → listUID

# First occurrence — slot ordered weight=100
ANCHOR(name="<keccak(...nonce=0)-hex>", refUID=listUID, schemaUID=DATA_SCHEMA_UID) → entry1
PIN(definition=entry1, refUID=bohemianRhapsody_DATA, attester=alice)
TAG(definition=listUID, refUID=entry1, weight=100, attester=alice)

# Second occurrence — slot ordered weight=90
ANCHOR(name="<keccak(...nonce=1)-hex>", refUID=listUID, schemaUID=DATA_SCHEMA_UID) → entry2
PIN(definition=entry2, refUID=bohemianRhapsody_DATA, attester=alice)
TAG(definition=listUID, refUID=entry2, weight=90, attester=alice)
```

Two entry anchors with different names PIN to the same DATA. No edgeHash collision; both TAGs are active independently.

**Read shape:** identical to P1.5 — call `EFSListView.getRankedSetEntriesPage(listUID, alice, ANCHOR_SCHEMA_UID, start, length)` to enumerate entries; for each, read `schemaUID` and resolve target via `EdgeResolver.getActivePinTarget(entry, alice, entry.schemaUID)`. The display "position number" (track 3, lecture 5) is computed at render time from the sorted weight order.

**Reorder cost:** O(1) — re-attest the TAG at the same edgeHash with new weight (ADR-0041 §4). Sparse weight spacing (e.g., increments of 2^32) supports many insertions before requiring a rebalance pass.

**Multi-attester:** entry anchors are NOT shared schelling points across attesters in P2 — each curator's `clientNonce` is independent, so Bob's "second occurrence" anchor differs from Alice's. This is the right semantic for sequences (Bob's playlist isn't the same as Alice's playlist; they're independent curations).

**Cost:** identical structure to P1.5 (~4 attestations per entry without notes; ~7 with one note field).

**Why FractionalSort is unnecessary:** the original specs/06 + specs/08 sketch used positional anchor names (`a0`, `a1`, `a2`) and proposed FractionalSort `ISortFunc` for O(1) reorder. With per-occurrence entry anchor names + sparse `int256` TAG weights, ordinary TAG-weight machinery handles insertion and reorder in O(1) without a custom sort func. FractionalSort is deprecated as a v1 list requirement and parked as a possible future read/index optimization for very long ordered lists if lazy sorted pagination demands it.

**Stable per-occurrence permalinks:** `alice.eth/playlist/<entry-keccak-hex>` is a stable URL pointing at a specific occurrence (survives reorder; the entry anchor's UID doesn't change with weight). "Track 3" / "the third item" is presentation syntax (`?n=3`) and is inherently unstable across reorder; that's fine — Spotify and similar use track-keyed URLs, not slot-keyed.

**Limitations:** higher attestation count than P1; per-curator naming (no cross-attester schelling point). Both are intentional given the use case.

### P3 — Sorted Folder

Just an existing directory with a `SORT_INFO`-declared sort. Already supported by the kernel; no new design. Distinguished from list patterns because there is no curatorial intent — it's a folder that happens to be rendered ordered (by date, by name).

Clients SHOULD NOT label P3 folders as "lists" in UI — confusing the curatorial frame matters.

---

## List metadata convention

PROPERTYs on the list anchor (per ADR-0034 reserved-key idiom; bound via PIN per ADR-0041 §4):

| Key | Values | Required? | Purpose |
|---|---|---|---|
| `listKind` | `"rankedSet"` (P1) \| `"entryAnchorSet"` (P1.5) \| `"occurrenceSequence"` (P2) \| `"collection"` (P3 — folder) | **Yes** for curated lists | Selects renderer; signals "this is a list, not a folder" |
| `allowedTargetSchemas` | CSV of schema UIDs (or `bytes32(0)` for address targets), or `"any"` | Recommended | Enables on-chain enumeration; absent/`"any"` = off-chain indexer required. Address-target sentinel: `0x0000…0000` (32 zero bytes). |
| `weightMeaning` | `"score"` (default) \| `"rank"` \| `"rating"` \| `"priority"` \| `"orderKey"` | No | Client UX hint for rendering ("4.5★" vs "#1") |
| `weightDirection` | `"desc"` (default) \| `"asc"` | No | Sort direction |
| `tieBreak` | `"targetID"` (default) \| `"tagUID"` \| `"attestationTime"` | No | Stable sort tie-break |
| `defaultSort` | Naming anchor UID | No | Points at a `/sorts/` naming anchor; for P1 typically absent (sort by weight is implicit) |
| `displayLimit` | Integer (e.g., `"8"`, `"10"`) | No | Render-N cap; client may truncate |
| `title`, `description`, `icon`, `cover` | String / DATA UID | No | Display metadata |
| `visibilityWarning` | `"social"` \| `"address-list"` \| `"none"` (default) | No | Advisory metadata; clients MAY surface a confirmation if they have a concrete safety reason. Following / listing other users is normal social behavior; v1 spec mandates no specific warning text. |

**Encoding choice:** individual PROPERTYs (per ADR-0034 idiom), not a JSON manifest DATA. Independently rebindable; clients read targeted; one PROPERTY rebind is O(1).

**Required behavior:** clients MUST read `listKind` before rendering. Other PROPERTYs are advisory.

---

## Discovery

**A user's lists.** Clients enumerate Alice's named anchors via `getAnchorsBySchema(home, ANCHOR_SCHEMA)`, then filter by presence of `listKind` PROPERTY. One extra read per candidate; cheap for typical user namespaces.

**Shared predicate anchors.** Anchors under `/lists/` (e.g., `/lists/fav_friends`, `/lists/bookmarks`) act as shared predicates: anyone can attest TAGs against them; editions filter at read time.

**Authority for `/lists/` is layered:**

- **Protocol identity** (deployer / `efs.eth`) creates the `/lists/` root namespace itself at deploy. The protocol does **not** seed predicates — predicate selection is a curatorial act, not a protocol fact. Protocol identity is reserved for system facts: schemas, deployment metadata, and similar.
- **EFS Team** (a separate, identified account distinct from `efs.eth` / deployer) may curate recommended ecosystem predicates. Anchors created under the EFS Team identity carry weight as "recommended convention" but are not protocol requirements. Clients can recognize EFS Team-curated predicates via a known-address registry.
- **Community curation** is unrestricted: any community can create competing predicate anchors under any path. Clients pick which curator to trust through editions priority and explicit address selection. The protocol does not adjudicate curatorial competition.

**v1 deploy seed:** protocol creates `/lists/` empty. Compare with `/sorts/`, which the protocol seeds because sort funcs require contract code — predicates have no such requirement, and predicate selection is curatorial. Demo predicates may appear in the demo seed (`08_seed_demo_tree.ts`) flagged demo-only, but that lives in the demo tree, not under the protocol identity.

---

## Read primitive — `EFSListView`

Stateless helper contract. No state, no kernel changes. Deployed once, callable by any client or contract.

The v1 helper is **single-attester, single-schema, paginated** by numeric `(start, length)`. Multi-attester merge, allowlist composition, generic-schema enumeration, and **sorted-rank views** are explicit client concerns — `EFSListView` does not bake those decisions in.

```solidity
struct RankedEntry {
    bytes32 targetID;
    bytes32 tagUID;
    int256  weight;
    address attester;
}

function getRankedSetEntriesPage(
    bytes32 listAnchor,
    address attester,
    bytes32 targetSchema,
    uint256 start,
    uint256 length
) external view returns (
    RankedEntry[] memory entries,
    uint256 nextStart
);
```

**Pages are in active TAG bucket order, NOT sorted by weight.** The helper paginates over `_activeByAAS[listAnchor][attester][targetSchema]` (per ADR-0041 §7), which is insertion-ordered with swap-and-pop on revoke. `length=10` does NOT mean "top 10." Clients producing a sorted top-N view MUST fetch all relevant entries, sort by weight + tie-break locally, and only then truncate to `displayLimit`. v1 sizes (≤ ~1000 entries) make fetch-all-then-sort cheap; lazy sorted pagination over very long lists requires either an off-chain indexer or a future `EFSSortOverlay` extension (deferred per D5).

**Composition patterns — P1 (TAGs target items directly):**
- **Sorted top-N (single attester, single schema):** call until `nextStart == 0` or you have all entries; sort by weight per `weightDirection` + `tieBreak`; truncate to `displayLimit`.
- **Allowlist (multi-schema):** call once per `targetSchema` in `allowedTargetSchemas`, **merge ALL schema buckets BEFORE sorting** — global top-N is not the union of per-schema top-Ns. (See Pitfalls.) Address-target entries (recipient-typed TAGs) are queried with `targetSchema = bytes32(0)` (the `ADDRESS_TARGET` sentinel; see D6).
- **Multi-attester views:** call once per attester, then apply the recommended URL convention for merge (see [Recommended URL conventions for clients](#recommended-url-conventions-for-clients) below). Same "merge before truncate" rule applies if combining attesters into one ranking.
- **Generic schema lists** (`allowedTargetSchemas` absent or `"any"`): off-chain indexer enumerates target schemas; client then calls per-schema.

**Composition patterns — P1.5 and P2 (TAGs target entry anchors):**
- **Single-attester read:** call `getRankedSetEntriesPage(listAnchor, attester, ANCHOR_SCHEMA_UID, start, length)` once to enumerate entries (the outer `targetSchema` is always `ANCHOR_SCHEMA_UID` — the TAG targets are entry anchors, NOT the underlying items). Sort, truncate.
- **Resolving inner targets:** for each returned entry anchor, read its `schemaUID` field to learn the inner target schema, then call `EdgeResolver.getActivePinTarget(entry, attester, entry.schemaUID)` to get the actual underlying target.
- **`allowedTargetSchemas` semantics in P1.5/P2:** describes the inner target schemas (what entry anchors are allowed to PIN to). The outer TAG bucket is always `ANCHOR_SCHEMA_UID` regardless. Validate at read time that each entry's `schemaUID` is in the list's `allowedTargetSchemas` (or that the list is generic).
- **P1.5 vs P2 distinction is the entry anchor name only.** P1.5 entry names are target-keyed (canonical hex of target); P2 entry names are occurrence-keyed (`keccak256("efs:list-occurrence:v1", listUID, creator, nonce)`). Read shape is identical; the curator's intent is signaled via `listKind` PROPERTY.

**Pagination cap:** `length` SHOULD be capped at `MAX_PAGE_LENGTH = 100` per call (matching `EFSSortOverlay.MAX_PAGE_SIZE`) to bound `eth_call` time — the helper performs N internal `eas.getAttestation` reads per page. A 1000-entry list takes ~10 calls. Larger caps risk RPC timeouts; smaller caps are fine.

**Snapshot consistency caveat:** active TAG buckets are NOT snapshot-stable across multiple RPC calls. If Alice revokes a TAG mid-pagination, swap-and-pop on revoke shifts later array positions (per ADR-0007); a client paginating may double-count an entry or miss one. Clients needing strong consistency SHOULD pin all pagination calls to the same block tag (`block.number` or block hash) when their RPC supports it, or tolerate-and-refetch when bucket counts change between pages.

**Why single-attester, paginated, simple:**
- Active TAG buckets are compact arrays, not linked lists. Numeric `(start, length)` is the natural pagination shape.
- Multi-attester pagination requires per-attester offsets; an opaque cursor would either re-fragment per attester or bake merge semantics. Better to expose the per-attester primitive and let clients compose.
- Keeps Q1 (multi-edition merge) **out of the low-level helper** — prevents the helper from accidentally locking in merge defaults before the policy decision lands.
- The `…EntriesPage` name (rather than `…RankedSetPage`) deliberately avoids implying that pages are sorted by rank.

**Dependency check:** `EdgeResolver.getActiveTagEntries(definition, attester, schema, start, length)` already exists per ADR-0041 §8 reader API and supports `(start, length)` pagination — `EFSListView` calls it directly. Confirmed; no kernel-side reader addition needed.

**Why stateless view, not kernel widening:** ADR-0041 §7 was load-bearing about `_activeByAAS` being `TagEntry[] {tagUID, weight}` for sort feasibility. Widening to `{tagUID, targetID, weight}` is a Tier-1 supersession; the view contract gives the same client API without that commitment.

---

## Recommended URL conventions for clients

Multi-attester merge mode is **a client rendering choice, not a data-layer commitment**. The contracts/kernel don't know about merge modes; `EFSListView` is single-attester. Different EFS clients can implement different merge logic. The recommendations below standardize the URL surface so clients agree on what URLs mean — clients are free to ignore them, but doing so creates fragmentation.

### Default: priority-union, rightmost wins

When `?merge=` is absent, clients SHOULD render with **priority-union, rightmost wins**:

- **Priority-union**: items pooled across all attesters in the editions list (every item any of them TAG'd is included).
- **Rightmost wins**: for items multiple attesters disagree on (different weights), the rightmost attester in the editions list determines the rendered weight.

Example: `alice.eth/fav_friends?editions=alice,bob` shows items pooled from Alice and Bob. Where they disagree on weight, **Bob wins** (he's rightmost). Reads naturally as "Alice's list, Bob's modifications layered on top."

This convention matches URL/path specificity (most-specific-rightmost), CSS cascade (later rules override earlier), and config-file inheritance (most-specific config wins).

**Note on ADR-0039 alignment:** ADR-0039's default editions chain is currently documented with leftmost-priority semantics. Adopting rightmost-wins for lists implies the chain order should flip to be consistent (so caller — currently leftmost — moves to rightmost). Treat this as a follow-up alignment ADR; not blocking on this design.

### Opt-in: `?merge=parallel` for side-by-side

Renders attesters' rankings as separate columns rather than collapsing into one ranking. Useful for comparing or diffing curators ("what does Alice rank vs what does Bob rank?"). Clients SHOULD cap the rendered columns at a small number (suggested: 5) and indicate overflow if the editions list is longer.

### Not v1-recommended (clients may implement at their own discretion)

- **Math aggregate** (sum / mean / median weights): Sybil-vulnerable for non-curated views, incompatible with default-chain fallback (system-tier attesters pollute the math), weight-scale normalization unsolved, and incoherent for P1.5/P2 (whose target binding wins?). Defer to a future proposal with explicit Sybil-resistance scope.
- **Explicit last-write-wins** (separate from priority-union with reversed list): redundant — priority-union with reversed editions list achieves the same outcome more safely.
- **Intersection-only**: incompatible with EFS's default chain (system-tier attesters typically have zero TAGs → empty intersection for fresh users).

### Tie-break order for merged views

When merge produces equal effective weights, clients SHOULD apply secondary tie-break in this order:

1. Weight (per `weightDirection`)
2. Editions-list position (rightmost wins — the merge primary)
3. Configured `tieBreak` PROPERTY (`targetID` / `tagUID` / `attestationTime`)

For single-attester views, position 2 is irrelevant; only weight + configured tieBreak apply.

### Edge case: first attester in editions has zero items

Clients SHOULD render the merged view silently — no UI note, no warning. The merged result is what the user wanted. A debug or "list provenance" view can be exposed via explicit user action (a button) for the curious.

### Same default applies to all list types

P1, P1.5, and P2 use the same merge default (priority-union, rightmost wins). Different defaults across list types would be confusing and serve no purpose — the underlying machinery is the same.

---

## Use cases mapped

| Use case | Pattern | Notes |
|---|---|---|
| MySpace top 8 friends | P1 | addresses via `recipient` |
| Top 10 memes | P1 | DATA targets |
| Favorite books with my notes on each | P1.5 | entry-anchor preserves notes across reorder |
| Blocklist / allowlist | P1 | weight optional; could just use unrevoked-as-membership |
| Ratings (5★ scale) | P1 | `weightMeaning="rating"`, `weightDirection="desc"` |
| Reading list (to-do flavored) | P1 | `weightMeaning="orderKey"`, `weightDirection="asc"` |
| Annotated curated guide ("awesome-EFS") | P1.5 | per-entry rationale |
| Plugin/schema/resolver registry | P1 | TAGs against `/registries/<topic>` |
| DAO delegate slate | P1 | addresses, ranked |
| Playlist with repeated tracks | P2 | occurrence-keyed entries, same target can appear twice |
| Syllabus / step-by-step guide | P2 | each step is its own occurrence even if it references shared material |
| Ranked ballot / voting podium | P2 | "1st place" position is its own occurrence |
| Photo folder sorted by date | P3 | not a curated list |
| Archive / manifest with accession metadata | P1.5 | each entry has metadata, no duplicates |

---

## Pitfalls and safety

### Lists of people are public, durable, and irreversible

Publishing a top-friends list, blocklist, ranked talent board, or similar puts addresses on-chain attached to your address. Clients SHOULD:

- Label issuer attribution in render: "Alice's blocklist", not "blocked". This is the load-bearing safety primitive — viewers must always know whose claim they're seeing.
- Treat these lists as durable; revocation removes the active claim but not the historical attestation.

Clients MAY (not MUST) surface a confirmation modal on first publish for lists where `visibilityWarning` is set; this is at client discretion. Following and listing other users is normal social behavior, and gating it with friction by default mismatches user mental models from existing platforms. The attribution-labeling requirement is doing the actual safety work.

### "Lists containing X" surface defaults — anti-feature

Anyone can put anyone on any list. Profile pages MUST NOT default-render reverse lookups ("lists this address appears on"). This anti-feature:
- Lets griefers pin "scammer of the week" lists onto someone's profile.
- Conflates attester-claims with subject-attributes.
- Creates negative social dynamics by default.

Reverse lookups MAY be exposed only to the viewing user themselves ("lists I'm on"), opt-in only.

### Sybil / aggregation concerns

v1 does NOT ship cross-attester aggregation primitives ("global top-N across all attesters"). Aggregate views are off-chain indexer territory and require explicit Sybil-resistance scope per use case. Pushing aggregation into the kernel without Sybil scoping creates an attractive nuisance.

### Generic list rot

Generic (no `allowedTargetSchemas`) lists rot at trust boundaries — readers can't enumerate without an off-chain indexer, and consumers defensively narrow per-item. Documentation should steer users toward single-typed or small allowlist lists; generic should be the explicit advanced opt-in.

### Entry-anchor squatting and name-target mismatch (P1.5 vs P2)

Entry anchor names follow different rules in P1.5 vs P2, and clients must validate accordingly. Both patterns leave the door open to spoofing if validation is skipped.

**P1.5 (target-keyed names) — name MUST match resolved target:**

The protocol does NOT enforce that an entry anchor's name actually matches the target its PIN binds to — the kernel only sees `(name, refUID=parent, schemaUID)` for the anchor and `(definition=anchor, target)` for the PIN. A malicious or buggy attester can create an entry anchor named `0xBob…` but PIN it to a totally different target, or set `schemaUID = DATA_SCHEMA_UID` but PIN to an address.

Clients MUST validate name ↔ target consistency at read time, schema-aware:
1. Read the entry anchor's `schemaUID` field.
2. Resolve the actual target via `getActivePinTarget(entry, attester, entry.schemaUID)`.
3. Compute the expected anchor name from `targetID` per the schema:
   - If `schemaUID == ADDRESS_TARGET` (`bytes32(0)`): expected name = `0x` + lowercase hex of the **low 160 bits** of `targetID` (42 chars total, canonical Ethereum address form).
   - Else: expected name = `0x` + lowercase hex of the full `targetID` (66 chars total).
4. If the entry anchor's actual name doesn't match the expected name, render a warning state OR suppress the entry from the canonical view.
5. Additionally, if `entry.schemaUID` is not in the list's `allowedTargetSchemas` (and the list is not generic), surface as a constraint violation.

**Naive rule "lowercase 0x-hex of `targetID`" is wrong for address targets** — address `targetID` is `bytes32(uint160(addr))` (zero-padded), and rendering it as a 66-char hex would not match the canonical 42-char address form. The schema-aware rule above is correct.

**P2 (occurrence-keyed names) — name SHOULD match the keccak formula but is not strictly target-bound:**

P2 entry names follow `keccak256("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce)` rendered as 66-char `0x` + 64 hex. Two divergences from P1.5:

- The name does NOT encode the target, so target-binding mismatches are NOT a spoofing vector — re-PINning the entry to a different target is the *intended* affordance (curator changing what an occurrence points at without disturbing entry identity).
- Clients SHOULD verify the entry name is a valid 66-char hex string but cannot recompute the canonical name (the `clientNonce` is unrecoverable). Free-form P2 entry names are allowed as an advanced escape hatch.
- The `entry.schemaUID` ∈ `allowedTargetSchemas` check (step 5 above) still applies in P2.

Anchor names in both patterns MUST satisfy ADR-0025 validation (character set, length). 66-char and 42-char lowercase hex strings are ASCII-printable and within limits — no conflict expected, but worth verifying when implementing.

### `listKind` is renderer intent, not proof

A list anchor's `listKind` PROPERTY signals what shape the curator INTENDS the list to be. The kernel does NOT enforce that storage matches that signal — anyone can declare `listKind="rankedSet"` and write zero TAGs, or declare `listKind="entryAnchorSet"` and write only TAGs at the list anchor with no entry anchors.

**Clients MUST treat `listKind` as advisory and degrade gracefully on mismatch:**
- Declared `rankedSet` (P1) but the active TAG bucket is empty → render an empty state. Do NOT silently fall back to enumerating children as if it were a folder.
- Declared `entryAnchorSet` (P1.5) or `occurrenceSequence` (P2) but no entry anchors exist (or no TAGs against the list with `targetSchema = ANCHOR_SCHEMA_UID`) → same empty/degraded treatment.
- Declared kind and active storage shapes both present (legacy migration in progress, accidental, or adversarial mixing) → render a warning state and prefer the declared kind; do not interleave shapes silently.

The client never silently reinterprets storage; mismatches surface to the user.

### Multi-schema lists: sort across all schemas BEFORE truncating

For lists with `allowedTargetSchemas` containing multiple schemas (or address-target sentinel + schemas), naive client logic that fetches "top N from each schema bucket" produces wrong results — the global top-N is not the union of per-schema top-Ns.

**Clients MUST:**
1. Fetch all entries from all relevant schema buckets (subject to off-chain-indexer assistance for very large lists).
2. Merge into a single sorted view by weight + tie-break.
3. **Then** truncate to `displayLimit`.

The same rule applies to multi-attester views: if combining multiple attesters into one ranking (Q1 option B/C), merge ALL attesters AND ALL schemas before truncating. `EFSListView.getRankedSetEntriesPage` returns insertion-ordered pages; client-side sort-merge-truncate is mandatory for correctness.

---

## Open questions

### Q1 — Multi-edition merge semantics — RESOLVED (client convention)

**Resolution:** merge mode is a client rendering convention, not a data-layer commitment. v1 client recommendation: priority-union with rightmost-wins as default; `?merge=parallel` as the opt-in for side-by-side rendering; aggregate/intersection/explicit-last-write deferred. See [Recommended URL conventions for clients](#recommended-url-conventions-for-clients).

The pre-existing tier-2 question in [docs/QUESTIONS.md](../docs/QUESTIONS.md) ("Multi-edition merge semantics") is for *single-DATA path resolution* in the router and remains separately scoped — the lists convention adopts the same precedent (rightmost-wins) for cross-system consistency, which implies a follow-up alignment ADR for ADR-0039 to flip its chain ordering.

### Q2 — UX warning language for social lists — RESOLVED (advisory only)

**Resolution:** no spec-mandated warning text. Following / listing other users is normal social behavior; consumer products don't gate it with friction. The `visibilityWarning` PROPERTY remains as advisory metadata clients MAY use if they have a concrete safety-tier reason, but no MUST language is attached. Clients shipping a confirmation modal at their discretion is fine; clients omitting it entirely is also fine.

### Q3 — Who curates `/lists/`, and what ships at deploy?

The protocol creates `/lists/` as a root namespace but does **not** seed predicates — predicate selection is a curatorial act, and the protocol identity (`efs.eth` / deployer) is reserved for system facts only.

Curatorial authority is layered:
- Protocol: namespace only.
- EFS Team account (if it exists at launch): may seed recommended predicates as reputational, not authoritative, conventions.
- Communities: may seed competing predicates under any path; trust via editions priority.

**Proposal for v1:** protocol ships `/lists/` empty. Whether EFS Team seeds any predicates is a separate non-protocol decision. Demo seed (`08_seed_demo_tree.ts`) MAY include one demo predicate inside the demo tree, flagged demo-only.

Open sub-questions:
- Does an EFS Team account exist at v1 launch?
- If yes, which predicates does it seed (`fav_friends`, `bookmarks`, `blocklist`, etc.)?
- How does a client recognize "official EFS Team curation" vs random community predicates? (Likely via known-address registry, similar to how trusted-attester sets work elsewhere.)

### Q4 — `EFSListView` deployment and addressing

`EFSListView` is stateless and redeployable. Does its address need to live in `deployedContracts.ts` like `EFSFileView`? Probably yes for client convenience; redeployment is harmless since no state is held.

---

## Out of scope for v1 / future work

- **Cross-attester aggregation primitives** (Sybil-resistant top-N globally; math aggregate / intersection merge modes). Requires governance scope and Sybil-resistance design.
- **Computed lists** — predicate-and-rules generated membership (iTunes Smart Playlist analog).
- **Reputation-weighted ranks** — depends on identity / trust graph features.
- **TAG-source extension to `EFSSortOverlay`** — unlock when concrete contract-consumer demand surfaces; requires solving the swap-and-pop vs append-only invariant clash. Would enable lazy paginated sorted access for very long ordered lists (>>1000 entries).
- **`TagEntry` storage widening to include `targetID`** — Tier-1 supersession of ADR-0041 §7; not justified by current demand.
- **Reverse-lookup APIs** ("lists containing X") — anti-feature in default UX; may be added behind explicit opt-in flags.
- **Multi-attester `EFSListMergeView` helper** — defer until profiling shows per-attester round-trip overhead matters.
- **ADR-0039 alignment ADR** — flip default chain ordering convention from leftmost-priority to rightmost-priority for consistency with the lists URL convention. Follow-up after this design lands.
- **`specs/06` rewrite** — describe P1 / P1.5 / P2 / P3 explicitly; mark `specs/08` as superseded design notes. Deferred until this design lands so prose reflects final decisions.
- **FractionalSort** — kept parked as a possible future read/index optimization for huge ordered lists; not part of the v1 list model. Deprecated as a list-design requirement.

---

## Appendix — Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Positional anchors as the MySpace top-N primitive | Per-position metadata is the only feature P1 can't match, and MySpace top-N doesn't need it. P1 is ~3× cheaper. Positional anchors stay reserved for genuine sequences (P2). |
| New `LIST_ITEM` schema | Tier-1 commitment for marginal benefit. Existing primitives + advisory metadata cover the design space. |
| JSON manifest as list metadata | One DATA per list; bulk-readable but not independently rebindable. ADR-0034 individual-PROPERTY idiom is cheaper to update and matches existing convention. |
| Contractual schema enforcement (custom resolver rejecting non-allowed targets) | Federated systems can't enforce write-time type constraints meaningfully. Advisory + reader-side filtering is the durable primitive. |
| Extending `EFSSortOverlay` with TAG `sourceType` in v1 | Swap-and-pop on revoke breaks `_lastProcessedIndex` invariant; would force a sneaky Etched storage decision. Bulk-SLOAD + client sort is sufficient. |
| Widening `TagEntry` to include `targetID` | Tier-1 supersession of ADR-0041 §7. `EFSListView` provides the same client API without the commitment. |

---

## Implementation sketch (informative)

For an eventual implementation plan; not prescriptive here.

**Likely shipping units:**
1. `EFSListView` contract (stateless read helper) — new file in `packages/hardhat/contracts/`.
2. List-metadata constants and reserved key anchor names — added to deploy script alongside ADR-0034 reserved keys.
3. Frontend list-renderer in `packages/nextjs/` debug UI — minimum demonstration of P1 and P1.5 against a seeded demo list.
4. Spec additions: rewrite `specs/06-Lists-and-Collections.md` to describe P1 / P1.5 / P2 / P3 explicitly, replacing the current text that leans on positional anchors as the canonical curated-list shape.
5. Deploy-time seed: optionally one demo `/lists/<predicate>` anchor for the demo tree, flagged demo-only.

**Two ADRs likely emerge:**
- ADR-A: Custom Lists — Ranked Set patterns (P1, P1.5) and the structural alphabet.
- ADR-B: Multi-edition merge semantics for ranked sets (resolves Q1; may also resolve the open QUESTIONS.md tier-2 question by precedent).

---

## Provenance

This design was produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, using parallel research subagents and a multi-round dialogue mediated by the human (James Carnley). The structural alphabet (P1/P1.5/P2/P3), the cardinality picker rule, and the `allowedTargetSchemas` framing emerged from the dialogue rather than any single agent's contribution. Source materials: existing EFS specs (01–08), ADRs 0030–0042, and external surveys of consumer list products and typed-data systems.
