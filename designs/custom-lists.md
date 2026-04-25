# EFS Custom Lists — Design

**Status:** Draft
**Date:** 2026-04-24
**Permanence-tier:** Durable (sets stable conventions over Etched primitives; introduces no new schemas)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming)
**Related:** ADR-0030, ADR-0031, ADR-0034, ADR-0038, ADR-0039, ADR-0041, ADR-0042; specs/02, specs/06, specs/07, specs/08

---

## TL;DR

EFS lists are **not a new primitive**. They are documented patterns over existing primitives (PIN, TAG, ANCHOR, PROPERTY, SORT_INFO).

Three list-shaped patterns plus folders:

| Pattern | One-liner | Best for |
|---|---|---|
| **P1 — Ranked Set** | Weighted TAGs against a definition anchor | Top-N, favorites, allowlists, ratings |
| **P1.5 — Entry-Anchor Set** | Per-entry anchors with PINs and PROPERTYs | Annotated favorites; sets needing per-entry notes |
| **P2 — Slot Sequence** | Positional anchors + PIN + ordering | Playlists with duplicates; per-slot identity |
| **P3 — Sorted Folder** | Existing folder + optional SORT_INFO | File libraries; not a curated list |

**v1 ships P1, P1.5, P3** plus a metadata convention and a stateless `EFSListView` read helper. **P2 deferred** to a follow-on proposal when concrete sequence demand (playlists, syllabi) surfaces.

The MySpace top-8 / top-10 use case lands cleanly on P1.

---

## Decisions awaiting human sign-off

If you're the project owner reviewing this doc — this section is your shortlist. Each item is plain-language, with a recommendation and a link to the detailed reasoning. Items 1–4 are real decisions; items 5–6 are confirmations / timing.

### 1. How should multi-edition list views merge? **(BLOCKS the ADR)**

When you visit `alice.eth/fav_friends?editions=alice,bob`, what should the page show?

- **A. Just Alice's view.** Bob's claims are hidden. Default-safe; matches existing router behavior.
- **B. Side-by-side.** Show items both have ranked, with each attester's weight displayed separately. Opt-in via `?merge=union`.
- **C. One merged ranking.** Math combines weights into a single list. Powerful, but Sybil-attackable.

**Recommendation:** ship A as default and B as an opt-in URL flag; defer C to its own future proposal with explicit Sybil-resistance scope.

This interacts with the open question already in [docs/QUESTIONS.md](../docs/QUESTIONS.md) — resolving it here would also unblock that one.

📎 [Full detail: Q1 — Multi-edition merge semantics](#q1--multi-edition-merge-semantics-for-ranked-sets-blocking)

### 2. What ships in `/lists/` at deploy?

`/lists/` is the global registry of well-known shared predicates (e.g., `/lists/fav_friends`). Right now the design proposes it ships **empty**.

- **Empty.** Users invent predicates; community-canonical ones get lifted later without contract change.
- **One demo seed.** Add `/lists/fav_friends` only, marked "demo, not canonical."
- **Several seeds.** Pre-populate `fav_friends`, `bookmarks`, `blocklist`, etc. Risk: locking in opinions about what matters.

**Recommendation:** Empty `/lists/`. Seed one demo predicate inside the demo tree (`08_seed_demo_tree.ts`) for illustration without making it canonical.

📎 [Full detail: Q3 — Seeded predicates](#q3--should-lists-ship-with-any-seeded-predicates)

### 3. Confirm: P2 (playlists with duplicates) is deferred from v1?

P2 covers genuine sequences — playlists with repeated tracks, syllabi, exhibits with per-slot prose. It depends on FractionalSort, which isn't built. The design currently puts it out of scope.

- **Defer.** Ship MySpace-style top-N now (P1, P1.5); add P2 when a concrete sequence use case surfaces.
- **Include in v1.** Delays launch by however long FractionalSort design + implementation takes.

**Recommendation:** Defer. None of the originally-described MySpace use cases (top friends, top memes, favorite books) need P2.

📎 [Full detail: P2 — Slot Sequence](#p2--slot-sequence-deferred-to-future-proposal)

### 4. UX warning text for publishing a list of people

When a user first publishes a list of addresses (top friends, blocklist, etc.), the UI should warn them. Proposed floor wording:

> "You are about to publish a permanent on-chain list containing addresses of other people. Your name will be associated with this list forever via attestation history. Recipients may surface this association on their own profiles. This action cannot be undone, only revoked (which leaves the historical attestation in place). Are you sure?"

**Recommendation:** Accept this as the spec-floor; refine wording when the production UI implements it.

📎 [Full detail: Q2 — UX warning language](#q2--ux-warning-language-for-social-lists-spec-deliverable)

### 5. Confirm: `EFSListView` is a stateless redeployable view contract?

The doc proposes adding `EFSListView` (analogous to `EFSFileView`) as the v1 read primitive — solves the N+1 problem of resolving target identities from TAG UIDs.

- Stateless: no storage, no kernel changes, redeployable. Not Etched.
- Returns `(targetID, tagUID, weight, attester)[]` in one external call.

**Recommendation:** Yes, ship it. No tradeoff against alternatives that I can see.

📎 [Full detail: Read primitive — EFSListView](#read-primitive--efslistview)

### 6. Should the [specs/06](../specs/06-Lists-and-Collections.md) cleanup ship as a parallel side-PR?

`specs/06` describes `SORT_INFO` with the wrong field count (drift from `specs/02` and `specs/07`). One-line fix; independent of this design but tangentially related.

- **Spawn now, parallel branch.** Keeps the lists ADR clean. Won't touch this design.
- **Roll into the lists implementation PR.** More commits in one PR.

**Recommendation:** Parallel side-task. I can dispatch on a separate branch on request.

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
Need duplicates of the same target?      → P2 (Slot Sequence)
Need stable per-entry metadata?          → P1.5 (Entry-Anchor Set)
Else                                     → P1 (Ranked Set)
```

P3 (Sorted Folder) is not a curated list; it's an ordinary folder with a render order applied. Mentioned for completeness; nothing new needed.

**Why:** these are not points on a spectrum — they have structurally different attestation graphs. No config option converts one into another. Documenting them as distinct, with a clear picker rule, is honest about the design space and prevents future agents from forcing one pattern to stretch to cover all.

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

**Decision:** The list anchor optionally carries `allowedTargetSchemas`:
- One schema UID → single-typed list (canonical on-chain readable case)
- Multiple schema UIDs → allowlist (small N, on-chain readable with N bucket queries)
- Absent or `"any"` → generic; **requires off-chain indexer** support for enumeration

Enforcement is **client-advisory**, not contractual.

**Why:**
- TAG buckets are keyed by `(def, attester, targetSchema)`. To enumerate a mixed list, the reader must know which target schemas to query. `allowedTargetSchemas` answers that.
- Federated systems can't enforce write-time type constraints meaningfully — anyone can attest anything; readers always do the real filtering.
- Single-typed is the consumer sweet spot; allowlist degrades gracefully; generic is the explicit "off-chain indexer required" tier.

This nudges users toward typed lists by making them genuinely cheaper to read on-chain, which aligns with the consumer pattern findings.

### D7 — Stateless `EFSListView` is the read primitive

**Decision:** Add a stateless `EFSListView` contract (analogous to `EFSFileView`) returning `(targetID, tagUID, weight)[]` in one call by internally batching `eas.getAttestation(tagUID)` reads.

**Why:**
- ADR-0041's `TagEntry` is `(tagUID, weight)` — does not include `targetID`. Resolving target identity is N+1 EAS reads if done naively.
- A view contract solves this without storage changes or kernel commitments.
- Storage widening (`TagEntry → {tagUID, targetID, weight}`) is a Tier-1 supersession of ADR-0041 §7 and not justified by current demand.

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

**Read shape:** `EFSListView.getRankedSet(listUID, [alice], DATA_SCHEMA, limit, cursor)` returns `(targetID, tagUID, weight)[]`. Client sorts by weight per `weightDirection` convention.

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
ANCHOR(name="favorite-books", refUID=alice_home)                     → listUID

ANCHOR(name="<bookA-uid-hex>", refUID=listUID)                       → entryA
PIN(definition=entryA, refUID=bookA_DATA, attester=alice)
PROPERTY(value="Changed how I think about systems") → noteA_prop
Anchor<PROPERTY>(name="note", refUID=entryA)        → noteA_key
PIN(definition=noteA_key, refUID=noteA_prop, attester=alice)
PROPERTY(value="100") → weightA_prop
Anchor<PROPERTY>(name="weight", refUID=entryA)      → weightA_key
PIN(definition=weightA_key, refUID=weightA_prop, attester=alice)
... (entryB, entryC similarly)
```

**Read shape:** enumerate `getChildren(listUID)` to find entry anchors; for each, resolve target via `getActivePin(entry, attester, ...)` and read PROPERTYs for metadata.

**Reorder cost:** re-PIN the weight PROPERTY at the same `(attester, weightKey, PROPERTY_SCHEMA)` slot. O(1) supersede per ADR-0041 §4.

**Multi-attester:** entry anchor is a shared schelling point; per-attester PINs handle multiple attesters' views naturally. Bob attests his own PIN on `entryA` to record his target-binding without disturbing Alice's.

**Cost:** ~1 list anchor + per entry: 1 entry anchor + 1 target PIN + (1 PROPERTY + 1 key anchor + 1 PIN) per metadata field. ~5–8 attestations per entry depending on how many fields.

**Naming convention:** entry anchor name SHOULD be the lowercase 0x-hex of the target UID (or address), so two attesters writing to the "same entry" land on the same anchor. This mirrors ADR-0033's schema-alias-anchor convention.

**Limitations:** higher attestation count than P1; no duplicates.

### P2 — Slot Sequence (deferred to future proposal)

**When:** sequence has duplicates, slot identity matters (`alice/playlist/a3` is a permalink), or per-slot annotation must survive position changes.

Existing sketch in [specs/06](../specs/06-Lists-and-Collections.md) and [specs/08](../specs/08-Custom-Lists-Design-Notes.md): positional anchors `a0/a1/a2`, FractionalSort `ISortFunc` for manual ordering. **FractionalSort is not yet implemented.** This pattern is documented but not shipped in v1.

**Out-of-scope concerns to address when P2 lands:**
- "One item per slot" enforcement (PIN cardinality is per-target-schema; a slot could hold one DATA pin and one address pin simultaneously without contractual conflict).
- FractionalSort design (ordering keys, reorder semantics, per-attester vs shared sort overlay).

### P3 — Sorted Folder

Just an existing directory with a `SORT_INFO`-declared sort. Already supported by the kernel; no new design. Distinguished from list patterns because there is no curatorial intent — it's a folder that happens to be rendered ordered (by date, by name).

Clients SHOULD NOT label P3 folders as "lists" in UI — confusing the curatorial frame matters.

---

## List metadata convention

PROPERTYs on the list anchor (per ADR-0034 reserved-key idiom; bound via PIN per ADR-0041 §4):

| Key | Values | Required? | Purpose |
|---|---|---|---|
| `listKind` | `"rankedSet"` \| `"entryAnchorSet"` \| `"slotSequence"` \| `"collection"` | **Yes** for curated lists | Selects renderer; signals "this is a list, not a folder" |
| `allowedTargetSchemas` | CSV of schema UIDs, or `"any"` | Recommended | Enables on-chain enumeration; absent/`"any"` = off-chain indexer required |
| `weightMeaning` | `"score"` (default) \| `"rank"` \| `"rating"` \| `"priority"` \| `"orderKey"` | No | Client UX hint for rendering ("4.5★" vs "#1") |
| `weightDirection` | `"desc"` (default) \| `"asc"` | No | Sort direction |
| `tieBreak` | `"targetID"` (default) \| `"tagUID"` \| `"attestationTime"` | No | Stable sort tie-break |
| `defaultSort` | Naming anchor UID | No | Points at a `/sorts/` naming anchor; for P1 typically absent (sort by weight is implicit) |
| `displayLimit` | Integer (e.g., `"8"`, `"10"`) | No | Render-N cap; client may truncate |
| `title`, `description`, `icon`, `cover` | String / DATA UID | No | Display metadata |
| `visibilityWarning` | `"social"` \| `"address-list"` \| `"none"` (default) | No | Triggers UX warning on durable publish |

**Encoding choice:** individual PROPERTYs (per ADR-0034 idiom), not a JSON manifest DATA. Independently rebindable; clients read targeted; one PROPERTY rebind is O(1).

**Required behavior:** clients MUST read `listKind` before rendering. Other PROPERTYs are advisory.

---

## Discovery

**A user's lists.** Clients enumerate Alice's named anchors via `getAnchorsBySchema(home, ANCHOR_SCHEMA)`, then filter by presence of `listKind` PROPERTY. One extra read per candidate; cheap for typical user namespaces.

**Shared predicate lists.** Well-known anchors under `/lists/` (e.g., `/lists/fav_friends`, `/lists/bookmarks`). Anyone can attest TAGs against them; editions filter at read time.

**v1 deploy seed:** **`/lists/` ships empty.** Predicates emerge organically from user practice; community-canonical predicates can be lifted to "well-known" status without contract change. Compare with `/sorts/`, which ships populated because the sort funcs themselves require contract code — predicates have no such requirement.

---

## Read primitive — `EFSListView`

Stateless helper contract. No state, no kernel changes. Deployed once, callable by any client or contract.

```solidity
// Returns (targetID, tagUID, weight) tuples for a P1 ranked set,
// merging the inputs from all listed attesters in one pass.
function getRankedSet(
    bytes32 listAnchor,
    address[] calldata attesters,        // editions list
    bytes32 targetSchema,                // single-schema or one entry of an allowlist
    uint256 limit,
    bytes32 cursor                        // opaque pagination token
) external view returns (
    Entry[] memory entries,              // {targetID, tagUID, weight, attester}
    bytes32 nextCursor
);
```

For allowlists (multi-schema), the client calls once per schema and merges. For generic lists, off-chain indexer is required.

**Why stateless view, not kernel widening:** ADR-0041 §7 was load-bearing about `_activeByAAS` being `TagEntry[] {tagUID, weight}` for sort feasibility. Widening to `{tagUID, targetID, weight}` is a Tier-1 supersession; the view contract gives the same client API without that commitment.

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
| Playlist with repeated tracks | **P2 (deferred)** | duplicates are real |
| Syllabus / step-by-step guide | **P2 (deferred)** | per-step prose, slot identity |
| Photo folder sorted by date | P3 | not a curated list |
| Archive / manifest with accession metadata | P1.5 | each entry has metadata |

---

## Pitfalls and safety

### Lists of people are public, durable, and irreversible

Publishing a top-friends list, blocklist, ranked talent board, or similar puts addresses on-chain attached to your address. UX MUST:

- Surface a clear **first-publish confirmation** for any list with `visibilityWarning = "social"` or `"address-list"`.
- Label issuer attribution in render: "Alice's blocklist", not "blocked".
- Treat these lists as durable; revocation removes the active claim but not the historical attestation.

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

### Anchor name validation for P1.5

Entry anchors named by target UID hex (e.g., `0xabc...123`) MUST satisfy the existing anchor-name validation (ADR-0025). Standard 0x-hex is ASCII-printable and within length limits — no conflict expected, but worth verifying when implementing.

---

## Open questions

### Q1 — Multi-edition merge semantics for ranked sets [BLOCKING]

When viewing `/alice.eth/fav_friends` with `?editions=alice,bob`, how are Alice's and Bob's claims combined?

**Options:**
- **A. Priority chain (default per ADR-0039):** Alice's view wins; Bob's claims ignored. Boring but consistent with router semantics elsewhere.
- **B. Union with parallel weights:** show items from both attesters, displaying each attester's weight side-by-side ("Alice ranks Bob #1, Carol ranks Bob #3").
- **C. Aggregate (sum/mean/median):** one merged ranking. Strongest Sybil concerns.

**Proposal:** v1 ships A as default; B as opt-in via `?merge=union`; C deferred to its own proposal with Sybil-resistance scope.

This question interacts with the pre-existing tier-2 question in [docs/QUESTIONS.md](../docs/QUESTIONS.md) ("Multi-edition merge semantics") — resolution should be coordinated. **Needs human decision before this design lands as ADR.**

### Q2 — UX warning language for social lists [SPEC DELIVERABLE]

Spec needs concrete language for `visibilityWarning = "social"` UX. Suggested floor:

> "You are about to publish a permanent on-chain list containing addresses of other people. Your name will be associated with this list forever via attestation history. Recipients may surface this association on their own profiles. This action cannot be undone, only revoked (which leaves the historical attestation in place). Are you sure?"

Refinement deferred until a UI surface implements it.

### Q3 — Should `/lists/` ship with any seeded predicates?

**Proposal:** No. Empty `/lists/` registry at v1 deploy. Predicates emerge from user practice. Demo seed (`08_seed_demo_tree.ts`) MAY add one demonstrative `/lists/fav_friends` predicate flagged as "demo, not canonical."

### Q4 — `EFSListView` deployment and addressing

`EFSListView` is stateless and redeployable. Does its address need to live in `deployedContracts.ts` like `EFSFileView`? Probably yes for client convenience; redeployment is harmless since no state is held.

---

## Out of scope for v1 / future work

- **P2 — Slot Sequence + FractionalSort.** Separate proposal. Triggers: concrete demand for playlists/syllabi/sequences with duplicates.
- **Cross-attester aggregation primitives** (Sybil-resistant top-N globally). Requires governance scope.
- **Computed lists** — predicate-and-rules generated membership (iTunes Smart Playlist analog).
- **Reputation-weighted ranks** — depends on identity / trust graph features.
- **TAG-source extension to `EFSSortOverlay`** — unlock when concrete contract-consumer demand surfaces; requires solving the swap-and-pop vs append-only invariant clash.
- **`TagEntry` storage widening to include `targetID`** — Tier-1 supersession of ADR-0041 §7; not justified by current demand.
- **Reverse-lookup APIs** ("lists containing X") — anti-feature in default UX; may be added behind explicit opt-in flags.

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
