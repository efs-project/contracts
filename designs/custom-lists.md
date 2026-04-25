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
- **B. Side-by-side.** Show items both have ranked, with each attester's weight displayed separately. Opt-in via a list-view mode flag.
- **C. One merged ranking.** Math combines weights into a single list. Powerful, but Sybil-attackable.

**Recommendation:** ship A as default and B as an opt-in flag; defer C to its own future proposal with explicit Sybil-resistance scope. Final URL/parameter syntax is deferred until ADR-0031's broader merge resolution lands.

This interacts with the open question already in [docs/QUESTIONS.md](../docs/QUESTIONS.md) — resolving it here would also unblock that one.

📎 [Full detail: Q1 — Multi-edition merge semantics](#q1--multi-edition-merge-semantics-for-ranked-sets-blocking)

### 2. Who curates `/lists/`, and what ships at deploy?

`/lists/` is the namespace for shared predicate anchors. Authority is layered:

- **Protocol identity** (`efs.eth` / deployer): creates `/lists/` as a root namespace. **No predicates** seeded — protocol identity is reserved for system facts (schemas, deployment metadata), not curatorial recommendations.
- **EFS Team** (a separate, identified account): may curate recommended ecosystem predicates (`fav_friends`, `bookmarks`, etc.). Authority is reputational, not protocol.
- **Community**: any community can create competing predicate anchors anywhere; clients pick which curator to trust via editions priority and explicit address selection.

**Decisions needed:**
- **A.** Confirm protocol ships `/lists/` empty at deploy.
- **B.** Does an EFS Team account exist at v1 launch, and if so, which predicates does it seed (separate from the protocol)?

**Recommendation:** Protocol ships `/lists/` empty. Whether/which EFS Team predicate seeding happens is a separate non-protocol decision. Demo seed (`08_seed_demo_tree.ts`) may include one demo predicate inside the demo tree, flagged demo-only.

📎 [Full detail: Discovery](#discovery) and [Q3 — Seeded predicates](#q3--who-curates-lists-and-what-ships-at-deploy)

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
Need duplicate occurrences or stable slot identity? → P2 (Slot Sequence)
Need per-entry metadata on unique targets?          → P1.5 (Entry-Anchor Set)
Else                                                → P1 (Ranked Set)
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

Address-target TAGs (recipient-typed, no target attestation) are represented by the **`ADDRESS_TARGET` sentinel = `bytes32(0)`** (32 zero bytes). An allowlist that permits both DATA targets and address targets would have `allowedTargetSchemas = "<DATA_SCHEMA_UID>,0x0000000000000000000000000000000000000000000000000000000000000000"`. Clients querying the address-target bucket pass `targetSchema = bytes32(0)` to `EFSListView.getRankedSetEntriesPage`.

Enforcement is **client-advisory**, not contractual.

**Why:**
- TAG buckets are keyed by `(def, attester, targetSchema)`. To enumerate a mixed list, the reader must know which target schemas to query. `allowedTargetSchemas` answers that.
- Federated systems can't enforce write-time type constraints meaningfully — anyone can attest anything; readers always do the real filtering.
- Single-typed is the consumer sweet spot; allowlist degrades gracefully; generic is the explicit "off-chain indexer required" tier.

This nudges users toward typed lists by making them genuinely cheaper to read on-chain, which aligns with the consumer pattern findings.

### D7 — Stateless `EFSListView` is the read primitive

**Decision:** Add a stateless `EFSListView` contract (analogous to `EFSFileView`) with a paginated, **single-attester, single-schema** signature: `getRankedSetEntriesPage(listAnchor, attester, targetSchema, start, length) → (RankedEntry[], nextStart)`. Returns `(targetID, tagUID, weight, attester)` tuples by internally batching `eas.getAttestation(tagUID)` reads. Multi-attester merge semantics, allowlist composition, generic-schema enumeration, and **sorted-rank views** are explicit client concerns layered on top.

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
ANCHOR(name="favorite-books", refUID=alice_home)                  → listUID

# Per entry: entry anchor + target binding + weighted membership + metadata
ANCHOR(name="<bookA-uid-hex>", refUID=listUID)                    → entryA
PIN(definition=entryA, refUID=bookA_DATA, attester=alice)
TAG(definition=listUID, refUID=entryA, weight=100, attester=alice)
PROPERTY(value="Changed how I think about systems")               → noteA_prop
Anchor<PROPERTY>(name="note", refUID=entryA)                      → noteA_key
PIN(definition=noteA_key, refUID=noteA_prop, attester=alice)
... (entryB, entryC similarly)
```

P1.5 is structurally **"P1 over entry anchors"**: the TAG against `listUID` provides membership and weight (same machinery as P1, with `targetSchema = ANCHOR_SCHEMA_UID`); the entry anchor wraps the actual target with stable identity for metadata.

**Read shape:** call `EFSListView.getRankedSetEntriesPage(listUID, alice, ANCHOR_SCHEMA_UID, start, length)` to enumerate entry anchor UIDs in active TAG bucket order. Paginate until exhausted, sort by weight + tie-break, truncate. For each entry anchor, resolve the actual target via `EdgeResolver.getActivePinTarget(entry, alice, <innerTargetSchema>)`; read note / display-metadata PROPERTYs from the entry anchor as needed. Validate that the entry anchor's name matches the resolved target (see Pitfalls — entry-name spoofing).

**Reorder cost:** re-attest the TAG at the same `edgeHash` with new weight — O(1) supersede per ADR-0041 §4. Same mechanism as P1.

**Multi-attester:** entry anchor is a shared schelling point; per-attester PINs handle multiple attesters' target bindings; per-attester TAGs (via the standard editions filter) handle multiple attesters' rankings of the same entry without disturbing each other.

**Cost:** ~1 list anchor + per entry: 1 entry anchor + 1 target PIN + 1 weight TAG + (1 PROPERTY + 1 key anchor + 1 PIN) per metadata field. ~4 attestations per entry without notes; ~7 with one note field.

**Naming convention:** entry anchor name SHOULD be the lowercase 0x-hex of the target UID (or address), so two attesters writing to the "same entry" land on the same anchor. This mirrors ADR-0033's schema-alias-anchor convention.

**Limitations:** higher attestation count than P1; no duplicates of the same target.

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
| `allowedTargetSchemas` | CSV of schema UIDs (or `bytes32(0)` for address targets), or `"any"` | Recommended | Enables on-chain enumeration; absent/`"any"` = off-chain indexer required. Address-target sentinel: `0x0000…0000` (32 zero bytes). |
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

**Composition patterns clients build on top:**
- **Sorted top-N (single attester, single schema):** call until `nextStart == 0` or you have all entries; sort by weight per `weightDirection` + `tieBreak`; truncate to `displayLimit`.
- **Allowlist (multi-schema):** call once per `targetSchema` in `allowedTargetSchemas`, **merge ALL schema buckets BEFORE sorting** — global top-N is not the union of per-schema top-Ns. (See Pitfalls.) Address-target entries (recipient-typed TAGs) are queried with `targetSchema = bytes32(0)` (the `ADDRESS_TARGET` sentinel; see D6).
- **Multi-attester views:** call once per attester, merge per the chosen merge semantic (priority chain, side-by-side, etc. — see Q1). Same "merge before truncate" rule applies if combining multiple attesters into one ranking.
- **Generic schema lists** (`allowedTargetSchemas` absent or `"any"`): off-chain indexer enumerates target schemas; client then calls per-schema.

**Reading P1.5 with the same helper:** P1.5 entries are TAGs whose `targetSchema = ANCHOR_SCHEMA_UID` (the entry anchors). The helper returns the entry anchor UIDs as `targetID`; the client then calls `EdgeResolver.getActivePinTarget(entry, attester, <targetSchema>)` per entry to resolve the actual underlying target, and reads PROPERTYs for metadata. Sort-before-truncate rule still applies.

**Why single-attester, paginated, simple:**
- Active TAG buckets are compact arrays, not linked lists. Numeric `(start, length)` is the natural pagination shape.
- Multi-attester pagination requires per-attester offsets; an opaque cursor would either re-fragment per attester or bake merge semantics. Better to expose the per-attester primitive and let clients compose.
- Keeps Q1 (multi-edition merge) **out of the low-level helper** — prevents the helper from accidentally locking in merge defaults before the policy decision lands.
- The `…EntriesPage` name (rather than `…RankedSetPage`) deliberately avoids implying that pages are sorted by rank.

**Dependency check:** `EdgeResolver.getActiveTagEntries(definition, attester, schema, start, length)` already exists per ADR-0041 §8 reader API and supports `(start, length)` pagination — `EFSListView` calls it directly. Confirmed; no kernel-side reader addition needed.

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

### Entry-anchor squatting and name-target mismatch (P1.5)

Entry anchors are conventionally named by lowercase 0x-hex of the target UID (or address). The protocol does NOT enforce that the anchor's name actually matches the target its PIN binds to — the kernel only sees `(name, refUID=parent)` for the anchor and `(definition=anchor, target)` for the PIN. A malicious or buggy attester can create an entry anchor named `0xBob…` but PIN it to a totally different target, or vice versa.

**Clients MUST validate name ↔ target consistency at read time:**
- Compute expected name from the resolved PIN target (lowercase 0x-hex of `targetID`).
- If it doesn't match the entry anchor's actual name, render a warning state OR suppress the entry from the canonical view.
- Mismatches MUST NOT be silently treated as valid.

Anchor names also MUST satisfy ADR-0025 validation (character set, length). Standard 0x-hex (66 chars for UIDs, 42 for addresses) is ASCII-printable and within limits — no conflict expected, but worth verifying when implementing.

### `listKind` is renderer intent, not proof

A list anchor's `listKind` PROPERTY signals what shape the curator INTENDS the list to be. The kernel does NOT enforce that storage matches that signal — anyone can declare `listKind="rankedSet"` and write zero TAGs, or declare `listKind="entryAnchorSet"` and write only TAGs at the list anchor with no entry anchors.

**Clients MUST treat `listKind` as advisory and degrade gracefully on mismatch:**
- Declared `rankedSet` but the active TAG bucket is empty → render an empty state. Do NOT silently fall back to enumerating children as if it were a folder.
- Declared `entryAnchorSet` but no entry anchors exist (or no TAGs against the list with `targetSchema = ANCHOR_SCHEMA_UID`) → same empty/degraded treatment.
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

### Q1 — Multi-edition merge semantics for ranked sets [BLOCKING]

When viewing `/alice.eth/fav_friends` with `?editions=alice,bob`, how are Alice's and Bob's claims combined?

**Options:**
- **A. Priority chain (default per ADR-0039):** Alice's view wins; Bob's claims ignored. Default-safe; consistent with router semantics elsewhere.
- **B. Union with parallel weights:** show items from both attesters, displaying each attester's weight side-by-side ("Alice ranks Bob #1, Carol ranks Bob #3").
- **C. Aggregate (sum/mean/median):** one merged ranking. Strongest Sybil concerns.

**Proposal:** v1 ships A as default; B as opt-in via a list-view mode flag (concrete URL/parameter syntax — `listMerge=union`, `?merge=union`, or similar — deferred until ADR-0031's broader merge question lands so the syntax is decided once); C deferred to its own proposal with Sybil-resistance scope.

This question interacts with the pre-existing tier-2 question in [docs/QUESTIONS.md](../docs/QUESTIONS.md) ("Multi-edition merge semantics") — resolution should be coordinated. **Needs human decision before this design lands as ADR.**

### Q2 — UX warning language for social lists [SPEC DELIVERABLE]

Spec needs concrete language for `visibilityWarning = "social"` UX. Suggested floor:

> "You are about to publish a permanent on-chain list containing addresses of other people. Your name will be associated with this list forever via attestation history. Recipients may surface this association on their own profiles. This action cannot be undone, only revoked (which leaves the historical attestation in place). Are you sure?"

Refinement deferred until a UI surface implements it.

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
