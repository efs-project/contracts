# EFS Lists — Design

**Status:** Draft (round 12 — structural correction)
**Date:** 2026-04-27
**Permanence-tier:** Etched-adjacent (introduces one new EAS schema; the data model is permanent post-1.0)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming) + James Carnley (architectural direction)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history, parked ideas, twelve rounds of refinement

---

## TL;DR

**A list is a typed anchor with weighted entries inside it.** Lists, folders, and tags are three separate things that can live inside an anchor; they are NOT unifications of each other.

```
/alice.eth/memes/                            (generic anchor — a folder)
   │
   └── /alice.eth/memes/mylist/              (Anchor<LIST_SCHEMA> — a list anchor)
         │
         ├── LIST attestation                (refUID = mylist; declares list properties)
         │
         ├── entry "<entry-name>"            (Anchor — child of mylist)
         │   ├── PIN(definition=entry, target)
         │   └── weight TAG(definition=mylist, refUID=entry, weight=N)
         │
         └── ...more entries
```

**A list is for ordered, ranked, or per-entry-metadata-bearing collections.** Top-N favorites, annotated catalogs, playlists with duplicates, shopping lists with status, ranked ballots — these are lists.

**For pure membership claims (allowlists, blocklists, follow graphs, "X is in Y"), use TAGs directly — not lists.** A TAG attestation against an anchor with `recipient = address` (or `refUID = item`) is the membership claim. `isActiveEdge(...)` already provides O(1) membership checks. These are tagging patterns, not list patterns; they don't need the LIST primitive.

**The picker question is now one decision:** *Do you need ordering or per-entry metadata?* Yes → use a list. No → use TAGs.

This round (12) reverses round-11's "lists are folders" unification. They're not. Lists, folders, files, and tags are all separate things that can live inside anchors. Anchors remain pure containers.

---

## What changed in round 12

This round corrects two architectural mistakes from round-11:

1. **Lists are NOT folders.** Round-11 said "promote a folder to a list by adding LIST_DECLARATION." This was a category error. An anchor doesn't BECOME a list; an anchor CONTAINS a list (or a folder structure, or files, or tags — different things). The unified-primitive framing was wrong.

2. **"Direct mode" was always tagging, not a list pattern.** Round-5 introduced direct vs wrapped modes; round-11 collapsed to always-wrapped. Both rounds were trying to make lists DO membership-tagging. James caught the category error: membership claims are tagging patterns (TAG attestations against an anchor), not list patterns. The "direct mode" use cases (allowlists, blocklists, follow graphs) belong with tags, not lists. Lists are exclusively for ranked/curated/metadata-bearing collections.

The structural model:

| Thing inside an anchor | What it is | Schema markers |
|---|---|---|
| **Files** | Anchor with PIN to DATA | child Anchor + PIN |
| **Sub-folders** | Generic child Anchors | child `Anchor<generic>` |
| **Lists** | Typed anchor + LIST attestation + entry anchors | `Anchor<LIST_SCHEMA>` + LIST attestation |
| **Tags** | TAG attestations against the anchor | TAG (no list framing needed) |

These are independent. An anchor at `/alice.eth/memes/` could contain all of them simultaneously — files, sub-folders, lists, and tags — without conflict.

---

## Why this matters

EFS is a graph-database substrate. The graph kernel (Anchors, PINs, TAGs) supports many overlay patterns. Trying to unify those patterns into one super-primitive (round-11's "lists are folders with weights") obscures what each pattern is actually for and creates classification debt downstream. The clearer model: each overlay pattern (folders, lists, tags, files) does one thing well; they coexist in the graph.

Smart contracts read these data structures directly. The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK enforcement of invariants because contract consumers don't run the SDK.

---

## The list primitive

A list is built from three layers:

1. **A typed list anchor** — an Anchor attestation with `name = ...`, `refUID = parent`, `schemaUID = LIST_SCHEMA_UID`. Names the list at a path. Immutable per ADR-0033 schema-alias-anchor convention. Path-routable (via `web3://`).

2. **A LIST attestation** — provides list configuration (entry naming convention, target type constraints). Hangs off the list anchor via `refUID = list anchor`. Revocable (allows correction of misconfigured lists).

3. **Entry anchors** — children of the list anchor (`refUID = list anchor`). Each entry PINs to its target item; weight TAGs against the list anchor provide ordering. Optional PROPERTYs on the entry carry per-entry metadata.

### Concrete example

```
/alice.eth/                                          (Alice's identity anchor)
  └── memes/                                         (Anchor<generic>; just a folder)
        └── mylist/                                  (Anchor<LIST_SCHEMA>; a list anchor)
              │
              ├── LIST attestation                   (refUID=mylist_anchor)
              │     entryIdentity = 0  (target-derived)
              │     targetKind    = 1  (schema UID)
              │     targetSchema  = DATA_SCHEMA_UID
              │
              ├── entry "0xMemeAHash..."             (Anchor; refUID=mylist_anchor)
              │     ├── PIN(definition=entry, refUID=memeA_DATA, attester=alice)
              │     └── TAG(definition=mylist_anchor, refUID=entry, weight=100, attester=alice)
              │
              ├── entry "0xMemeBHash..."             (similar)
              │
              └── entry "0xMemeCHash..."
```

Path resolution: `web3://...alice.eth/memes/mylist/` resolves through the chain of anchors. Apps render the final anchor as a list (because its `schemaUID = LIST_SCHEMA`) by reading the LIST attestation and enumerating children + weight TAGs.

### LIST schema (NEW — Etched commitment)

```solidity
LIST schema:
  uint8   entryIdentity   // 0 = target-derived, 1 = occurrence-derived, 2 = freeform
  uint8   targetKind      // 0 = any, 1 = schema-UID typed, 2 = address
  bytes32 targetSchema    // meaningful when targetKind == 1
revocable: true
resolver:  ListResolver   // enforces singleton-per-(attester, refUID)
```

Field semantics:

- **`entryIdentity`** declares the entry-naming convention:
  - `0` (target-derived): entry name = canonical lowercase hex of `targetID`. UID targets render as 66-char `0x` + 64 hex; address targets render as 42-char `0x` + 40 hex (canonical Ethereum address form). Set semantics — same target lands at the same anchor across attesters. Multi-attester edition convergence at shared schelling-point entries.
  - `1` (occurrence-derived): entry name = `lowercase 0x + 64 hex of keccak256(abi.encode("efs:list-occurrence:v1", listAnchor, creatorAddress, clientNonce))`. Each occurrence is independent — same target can appear at multiple distinct entries. Use for playlists with duplicates, ranked ballots, syllabi.
  - `2` (freeform): entry name = curator's choice (subject to ADR-0025 anchor name validation). No deterministic structure. Use when entries have human-meaningful names (shopping lists with "milk", "eggs"; todos with "send email"; folders being re-purposed as lists). Multi-attester convergence is opportunistic — different curators may pick different names for the same conceptual entry.

- **`targetKind`** declares what kind of inner target each entry's PIN binds to. `0` = any (the entry's own `schemaUID` field declares per-entry); `1` = a specific EAS schema UID (provided in `targetSchema`); `2` = an Ethereum address (recipient-typed PIN, `targetSchema` ignored).

- **`targetSchema`** is the schema UID when `targetKind == 1`. Otherwise `bytes32(0)` (unused).

`clientNonce` (used for `entryIdentity == 1`) MUST be ≥128 bits CSPRNG entropy. Sequential or monotonic nonces are forbidden — they enable squatting attacks. (See Pitfalls — convention is unenforceable at the kernel.)

**`revocable: true`**: a curator can revoke the LIST attestation (returning the anchor to "typed but unconfigured" state — apps render as warning/empty). Re-attesting after revoke is a clean lifecycle event indexers can track. This is the right default per Gemini's UX argument: irrevocable type markers on long-standing namespace anchors create permanent self-griefing risk.

**`resolver: ListResolver`** enforces singleton: exactly one active LIST attestation per `(attester, refUID = listAnchor)`. Rejects any second attestation; if a curator wants to change config, they revoke and re-attest. This eliminates the "duelling LIST attestations" ambiguity that would otherwise plague indexers and contract consumers.

### Entry anchors

Entries are children of the list anchor (`refUID = list_anchor`). Each entry is itself a regular Anchor attestation. The entry's `schemaUID` field declares the inner target's schema (so readers can resolve the PIN target without trying every possible schema):

- `targetKind == 1`: entry's `schemaUID == targetSchema` (e.g., `DATA_SCHEMA_UID` for a books list).
- `targetKind == 2`: entry's `schemaUID == bytes32(0)` (`ADDRESS_TARGET` sentinel).
- `targetKind == 0`: entry's `schemaUID` declares per-entry; entries can be heterogeneous within one list.

The entry's name follows the convention declared by `entryIdentity` (target-derived hex / occurrence-derived hash / freeform curator choice).

### PIN: binding the entry to its target

Each entry has exactly one active PIN per attester per target schema, binding the entry to its actual content:

- For UID targets: `PIN(definition=entry, refUID=targetUID, attester=curator)`
- For address targets: `PIN(definition=entry, recipient=address, attester=curator)`

Re-PINning supersedes O(1) (per ADR-0041 §4 PIN slot semantics). For occurrence-derived and freeform entries, re-PINning to a different target is the *intended* affordance — the entry's identity is its name, not its current target binding.

For target-derived entries, re-PINning to a target whose hash differs from the entry name violates the canonical name → target invariant. Clients MUST validate (see Pitfalls — entry-anchor squatting).

### Weight TAG: ordering

Each entry has at most one active weight TAG per attester:

```
TAG(definition=list_anchor, refUID=entry, weight=N, attester=curator)
```

The TAG's definition is the **list anchor**, not the LIST attestation. This means `_activeByAAS[list_anchor][curator][ANCHOR_SCHEMA]` enumerates the list's active entries with weights — the same storage shape EFS uses for any TAG-against-anchor pattern.

Re-attesting at the same edgeHash supersedes weight in O(1) (ADR-0041 §4). Default ordering is `weight desc`, with deterministic tie-break by entry-anchor UID asc, then `tagUID` asc.

For lists where the curator manually orders entries, SDKs SHOULD use sparse `int256` weights (e.g., 2^32 spacing) with periodic rebalance. This is the standard CRDT-style approach (Logoot et al.). Sparse weights are NOT a universal MUST — ratings, votes, and scores use weights with intrinsic meaning.

### Per-entry metadata

PROPERTYs on the entry anchor carry per-entry state. Pattern (per ADR-0034):

- A reserved key anchor under the entry (e.g., `note`, `status`, `caption`)
- A free PROPERTY attestation with the value
- A PIN binding the value at the key anchor (cardinality-1 per attester)

Updating a metadata value re-binds the PIN at the same slot — O(1) supersede. The entry anchor itself never changes, so metadata survives reorders, target rebinds (for occurrence/freeform identities), and any other mutation.

**Reserved generic PROPERTY keys**: `note`, `title`, `description`, `icon`, `cover`, `status`, `quantity`, `completedAt`. Apps SHOULD NOT shadow these with conflicting semantics. Other PROPERTY keys are app-defined.

---

## Lists vs Tags vs Folders: when to use which

| Need | Pattern |
|---|---|
| Membership claim ("X is in Alice's allowlist") | **TAG** — `TAG(definition=anchor, recipient=X)`. Use `isActiveEdge(...)` for O(1) check. No list needed. |
| Follow / friend graph | **TAG** — `TAG(definition=alice_follows, recipient=Y)`. Pattern per ADR-0038. |
| Ranked or ordered collection | **List** — typed list anchor + LIST attestation + weighted entries. |
| Per-entry metadata (notes, status, captions) | **List** — entries are anchors, can carry PROPERTYs. |
| Sequence with duplicates (playlists, ballots) | **List** with `entryIdentity = 1` (occurrence-derived). |
| Folder of files | **Anchor + child anchors with PINs to DATA** (existing EFS folder pattern). No list. |
| Categorization (`#nsfw`, `#favorites`) | **TAG** — at a tag anchor like `/tags/nsfw`. ADR-0038. |
| Permissions / roles / DAO membership | **TAG** — membership claim. |

The picker question simplifies to: *Need ordering or per-entry state?* Yes → list. No → tag.

This distinction is important: lists are heavy (LIST schema + per-entry attestations) and exist to serve the use cases tags can't (ranking, per-entry mutable state). Don't make lists do tag work.

---

## Reader API (v1)

Smart contracts and clients read lists via existing `EdgeResolver` view methods plus three v1 extensions (the same set committed in round-7/8, all generic graph-composition names — no list-overlay vocabulary in the kernel ABI).

**Existing readers used by lists** (per ADR-0041 §8):
- `getActiveTagEntries(definition, attester, targetSchema, start, length) → (tagUID, weight)[]`
- `getActivePinTarget(definition, attester, targetSchema) → targetID` (returns `bytes32(0)` on missing)
- `isActiveEdge(attester, targetID, definition, schema) → bool` — **for tag-based membership patterns**

**v1 extensions on `EdgeResolver`** (immutable post-1.0):
- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — generic TAG bucket reader with target extraction.
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends previous: for TAGs targeting anchors, additionally resolves the anchor's PIN target. **THE canonical list reader** when called with `tagTargetSchema = ANCHOR_SCHEMA_UID`.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic self-naming-anchor consistency check. Schema-aware. Used for target-derived list entries.

**Pagination cap (enforced):** `length` MUST be ≤ `MAX_LIST_PAGE_SIZE = 100`. Readers MUST revert with `PageSizeTooLarge()`.

**Membership checks for tag patterns use `isActiveEdge` directly** — no list-specific helper needed. This was the round-12 architectural correction: the use cases that demanded a cheap on-chain membership check (allowlists, blocklists, registries, follow graphs) are tag patterns, not list patterns. `isActiveEdge` already serves them.

### Canonical read recipe (single-curator scope, default)

For a list at anchor `listAnchor`, curator `alice`:

```
1. Verify anchor type:
   - Read listAnchor's Anchor attestation; check schemaUID == LIST_SCHEMA_UID.
   - If not, this is not a list; render as folder/file/etc.

2. Resolve LIST attestation:
   - Find the LIST attestation with refUID == listAnchor, attester == alice.
   - Singleton-enforced by ListResolver, so at most one active LIST per (alice, listAnchor).
   - If none: render warning ("typed list anchor but no configuration").
   - Read entryIdentity, targetKind, targetSchema.

3. Enumerate entries with weights:
   - Call EdgeResolver.getActiveTagPinTargetsWithWeights(
       listAnchor,
       alice,
       ANCHOR_SCHEMA_UID,    // entries are anchors
       start,
       length
     ).
   - Returns (entryUID, tagUID, innerTargetID, innerTargetSchema, weight, attester)[].

4. For each entry:
   - If innerTargetID == bytes32(0), render warning state (missing inner PIN).
   - If targetKind != 0, validate innerTargetSchema matches targetSchema (or innerTargetSchema == bytes32(0) when targetKind == 2 for address).

5. If entryIdentity == 0 (target-derived), validate name consistency:
   - For each entry: call validateAnchorNameMatchesPinTarget(entryUID, alice).
   - On false: render warning OR suppress.

6. For metadata PROPERTYs (note, status, etc.):
   - Resolve the named key anchor under the entry; read PROPERTY value via getActivePinTarget.

7. Apply default total order:
   - Sort by weight desc, tie-break by entryUID asc, then tagUID asc.

8. Truncate to client-chosen displayLimit.
```

### Snapshot consistency

Smart contracts calling the v1 readers in a single transaction get atomic snapshot consistency for free — EVM atomicity per call. The bundled readers complete all reads within one external view call.

Off-chain clients paginating across multiple RPC calls MUST pin all reads to the same `blockTag`. Default `wagmi`/`viem` setups don't pin automatically; SDK helpers MUST handle this internally. Governance / on-chain consumers SHOULD read from finalized blocks.

---

## Editions and multi-attester reads

Default reads are **single-curator-scoped**. The curator's LIST attestation, weight TAGs, entry PINs, and entry metadata all come from one attester.

Multi-attester views (compare/merge UI) are explicit opt-in. Per-attester storage in `_activeByAAS` is independent.

**For `entryIdentity = 0` (target-derived):** entry anchors are SHARED schelling points. Alice and Bob's "entry for book X" land at the same anchor (deterministic name from target hash). Each writes their own PIN, weight TAG, and metadata. Readers filter at the PIN/TAG layer; the entry anchor is shared infrastructure.

**For `entryIdentity = 1` (occurrence-derived):** entry anchors are per-curator (each `clientNonce` differs). Independent entry-anchor sets per attester.

**For `entryIdentity = 2` (freeform):** entry naming is curator's choice. Multi-attester convergence is opportunistic — Alice's `"milk"` and Bob's `"milk"` would land at the same anchor if they happen to use the same name; otherwise distinct.

**Multi-attester LIST attestations**: each curator has their own LIST attestation (singleton enforced per attester), which means different curators could declare different `entryIdentity` or `targetKind` for the same list anchor. Apps reading multi-attester MUST use the curator's LIST attestation when reading that curator's entries; cross-curator merge requires reconciling potentially-different list configurations.

**Merge semantics** are not part of this design. Clients pick how to render multi-attester data per use case. Default is single-curator-scoped; multi-attester is advisory and clients MUST preserve attribution.

---

## Use cases (split between LIST and TAG patterns)

### LIST patterns (use the list primitive)

| # | Use case | entryIdentity | Notes |
|---|---|---|---|
| 1 | Top-N favorites (memes, books, etc.) | target | Weight = ranking |
| 2 | Annotated favorites with notes per entry | target | `note` PROPERTY on entry |
| 3 | Ratings (1–5★ per item) | target | Weight = rating value |
| 4 | Reading list (priority order) | target | Weight = read order |
| 5 | Wishlist (priority order, with details) | target | Weight = priority; `note` PROPERTY |
| 6 | Tier list (S-tier/A-tier with sub-rank) | target | Weight encodes tier+rank, or `tier` PROPERTY |
| 7 | Curated awesome-EFS guide | target | Per-entry rationale |
| 8 | DAO delegate slate (ranked candidates) | target | Weight = preference |
| 9 | "People I trust for X topic" | target | Per-list context note |
| 10 | Cross-list reuse (same target, multiple lists) | target | Independent list anchors |
| 11 | Annotated bookmarks | target | URL via DATA wrapper; `note` PROPERTY |
| 12 | Inventory / stock list | target | `stock`, `price` PROPERTYs |
| 13 | Achievements with date earned | target | `earnedAt` PROPERTY |
| 14 | Playlist with duplicates | occurrence | Same DATA at multiple entries |
| 15 | Syllabus / step-by-step guide | occurrence | Per-step prose |
| 16 | Ranked ballot | occurrence | Position is meaningful |
| 17 | **Shopping list (items with status)** | freeform | Names like "milk", "eggs"; `status` PROPERTY |
| 18 | **Todo list (status per task)** | freeform | Names are task descriptions; `status` PROPERTY |
| 19 | Custom-named curated catalogue | freeform | Curator chooses entry names |
| 20 | Course curriculum (lessons with status) | occurrence | `status` per lesson |

### TAG patterns (use TAGs directly — NOT lists)

| # | Use case | Pattern | Membership check |
|---|---|---|---|
| A | Allowlists | `TAG(definition=allowlist_anchor, recipient=X)` | `isActiveEdge(...)` |
| B | Blocklists / mutelists | `TAG(definition=blocklist_anchor, recipient=X)` | `isActiveEdge(...)` |
| C | Follow / friend graph | `TAG(definition=alice_follows, recipient=Y)` | `isActiveEdge(...)` |
| D | DAO membership (boolean) | `TAG(definition=dao_members, recipient=member)` | `isActiveEdge(...)` |
| E | Verified addresses | `TAG(definition=verified_anchor, recipient=X)` | `isActiveEdge(...)` |
| F | Categorization tags (#nsfw, #favorites) | `TAG(definition=tag_anchor, refUID=item)` | Per ADR-0038 |
| G | Permissions / roles | `TAG(definition=role_anchor, recipient=member)` | `isActiveEdge(...)` |
| H | Folder visibility | `TAG(definition=schemaUID, refUID=folder)` | Per ADR-0038 |

**For TAG patterns**, no list infrastructure is needed. The anchor is just a regular anchor; TAGs directly target items. Cheap O(1) writes and reads.

This split was the round-12 correction. Earlier rounds tried to make the list primitive serve both ranked-collection and membership use cases; the separation is cleaner.

---

## Pitfalls and safety

### Entry-anchor squatting (`entryIdentity = 0` only)

For target-derived entries, the entry name encodes the target. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target.

Clients MUST validate via `EdgeResolver.validateAnchorNameMatchesPinTarget(entryAnchor, attester)`. Mismatch → render warning OR suppress; never silently treat as valid.

For `entryIdentity = 1` (occurrence-derived) and `entryIdentity = 2` (freeform), name validation does NOT apply — names don't encode the target.

### `clientNonce` convention is unenforceable at the kernel

Sequential nonces and CSPRNG output produce identical-looking `keccak256` hashes. The kernel cannot distinguish.

Smart contracts consuming `entryIdentity = 1` lists SHOULD treat the entry's UID and the curator's TAG attestation as the trust unit — NOT the entry name pattern. The TAG is the membership claim; the name is a label.

### Lists of people are public, durable, attribution-labeled

Publishing a list of addresses puts them on-chain durably. Clients SHOULD:
- **Label issuer attribution clearly**: "Alice's blocklist", not "blocked".
- Treat lists as durable; revocation removes the active claim but not historical attestation.

Note that for blocklist-style use cases, the right primitive is TAGs (see section above), not lists. But annotated lists of people (e.g., "speakers I want to invite") are valid list use cases.

### "Lists containing X" is an anti-feature in default UX

Anyone can put anyone on any list. Profile pages MUST NOT default-render reverse lookups. Reverse lookups MAY be exposed only to the viewing user themselves ("lists I'm on"), opt-in only.

### Target universe — not everything is a PIN target

PIN's `refUID` must point at an existing EAS attestation. **Raw schema UIDs are NOT valid PIN targets** — schemas exist as registry entries, not attestations. Schema registries MUST target schema-alias anchors per ADR-0033.

URLs and other off-chain identifiers similarly need a wrapper (DATA attestation with the URL as content) to be PIN'd.

### LIST_SCHEMA mismatch with attestation

A curator could attest a LIST attestation (refUID = some anchor) on an anchor whose `schemaUID` is NOT `LIST_SCHEMA_UID`. The kernel doesn't enforce consistency between the anchor type marker and the LIST attestation's existence.

Clients SHOULD validate: if a LIST attestation is found, the anchor's `schemaUID` SHOULD equal `LIST_SCHEMA_UID`. Mismatch indicates curator confusion — render warning. The `ListResolver` MAY validate this at attestation time as a soft check; recommended.

### `entryIdentity` mismatch with entry naming

The `entryIdentity` declared in the LIST attestation governs how entries are named, but the kernel doesn't enforce that all entries actually follow that convention. A curator could declare `entryIdentity = 0` (target-derived) but create freeform-named entries.

Clients applying name validation SHOULD treat such entries as invalid (warning or suppression). Most apps will trust their own SDK helpers to enforce naming at write time.

### ADR-0042 effective-TAG filter does NOT apply to lists

ADR-0042 establishes "effective TAG = active TAG with `weight ≥ 0`" for the explorer's descriptive-label filter. **This convention does NOT apply to custom lists.** A rating with `weight = -3` is meaningful low-score data; it should be visible. Apps MAY apply a `weight ≥ 0` filter for UX reasons; the canonical default for list rendering is "active = unrevoked," with weight used for ordering.

---

## Indexer notes (for subgraph implementers)

**Event ordering between LIST attestation and entries.** The LIST attestation, weight TAGs, and entry anchor creations arrive as separate EAS events. Indexers SHOULD:
- Track entries keyed by `(listAnchor, attester)`; resolve to fully-formed list state when LIST attestation appears.
- Render lists without LIST attestation as "typed list anchor, unconfigured" warning.

**Active state vs historical state.** `_activeByAAS` reflects current active TAGs (post-revocation). Track revocation events and apply swap-and-pop semantics (per ADR-0007).

**TAG supersession via re-attest at same edgeHash** (per ADR-0041 §4). Re-attesting a TAG updates the active entry's UID and weight in place, **without emitting a `Revoked` event for the prior TAG**. Indexers MUST detect this:
- Compute `edgeHash = (attester, targetID, definition, schema)`.
- If a prior TAG with same `edgeHash` exists in active set, treat as superseded — replace, don't double-count.

**PIN supersession is slot-based, not edgeHash-based.** Metadata bindings (note, status, etc.) are PINs at slot `(definition, attester, targetSchema)`. Re-attesting a PIN at the same slot supersedes the prior — **even when the target changes** (target is part of edgeHash but NOT part of the slot). Indexers reconstructing active PIN state MUST key singleton slots by `(definition, attester, targetSchema)` and replace `(pinUID, targetID)` for that slot.

**LIST attestation revocation lifecycle.** LIST is `revocable: true`. A revoked LIST attestation means the list is no longer active; entries persist but no rendering should occur. Re-attesting (after revoke) is a clean lifecycle event.

**LIST attestation singleton.** ListResolver enforces exactly one active LIST per `(attester, listAnchor)`. Indexers can rely on this — there is never ambiguity about which LIST attestation governs.

**Discovery indexes vs active state.** `_targetsByDef`, `_edgeDefinitions`, etc. are append-only discovery indexes including historical entries; NOT ground truth for current active state. Cross-reference active-set storage.

---

## Conventions vs enforcement — long-tail risk

This design relies on convention enforcement for invariants the kernel cannot validate: `clientNonce` CSPRNG entropy, target-derived entry name consistency, anchor schemaUID matching the LIST attestation's intent.

These triggers fire if convention compliance drops below tolerance post-launch:

- **Target-derived entry name mismatches exceed measurable share** → ship enforcement via custom resolver on entry anchors.
- **Squatting-pattern signals appear post-launch** → ship kernel-side nonce-entropy or rate-limit resolver. Sequential nonces aren't observable from hashes; signals are downstream effects (write-aborts on anchor name pre-existence, successful squatting reports).
- **`Anchor<LIST_SCHEMA>` without LIST attestations becomes a footgun** at scale → ListResolver could enforce "LIST_SCHEMA-typed anchors must have a LIST attestation within N blocks of creation" or similar; not in v1.
- **Cross-client divergence on read recipes** → ship a canonical reference SDK as the de facto interpreter.

These triggers are operational concerns; they represent conditions under which "convention only" becomes load-bearing tech debt.

---

## Decisions resolved (round-12 updated)

1. **Lists are NOT folders.** Anchors are containers; lists, folders, files, and tags are separate things that can live inside anchors. Round-11's "lists are folders" unification was a category error; round-12 reverses it.
2. **Lists are typed anchors + LIST attestation + entry anchors.** Three layers; consistent with EFS's existing schema-alias-anchor and sort-naming-anchor conventions (specs/07, ADR-0033).
3. **Membership patterns use TAGs, not lists.** Allowlists, blocklists, follow graphs, DAO membership, categorization — all are tagging patterns. The list primitive is exclusively for ranked/curated/metadata-bearing collections.
4. **`isActiveEdge` is the membership primitive** — already exists in `EdgeResolver`. Round-12 dropped the proposed `isActiveListMembership` because it's not a list concern.
5. **Always-wrapped lists.** Within the list primitive, there's only one mode: entries are anchors with PINs. Round-5's two-mode design is gone; the membership use cases that demanded "direct mode" are now correctly identified as TAG patterns.
6. **LIST schema (NEW EAS schema, revocable, resolver-enforced singleton).** Field set: `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)`. `entryIdentity` has three values: target-derived, occurrence-derived, freeform. `revocable: true` to allow correction of misconfigured lists. Custom resolver enforces singleton per (attester, refUID).
7. **`entryIdentity = 2` (freeform)** supports human-meaningful entry names (shopping lists, todos, custom-named catalogues).
8. **Smart contracts read directly via three new `EdgeResolver` view methods.** Generic graph-composition names; no list-overlay vocabulary in kernel ABI. Same as rounds 7/8.
9. **Single-curator-scoped reads as default.** Multi-attester is opt-in for compare/merge UI.
10. **Default ordering: `weight desc`, tie-break by entry-UID asc, then `tagUID` asc.**
11. **Sparse `int256` weights are an SDK SHOULD for manual ordering**, NOT a universal MUST. Ratings, votes, scores use meaningful weights.
12. **Page cap MUST = 100**, enforced via `PageSizeTooLarge()` revert.
13. **`clientNonce` ≥128 bits CSPRNG** — convention only; kernel cannot enforce.
14. **Snapshot consistency MUST**: smart contracts get atomicity; off-chain clients pin `blockTag`; governance reads finalized.
15. **Convention-violating lists are accepted v1 risk** with named revisit triggers.
16. **Shopping lists, todos, stateful per-entry items are core supported use cases** via `entryIdentity = 2` + per-entry PROPERTYs.
17. **`specs/06` rewrite required before dev** writes list data. Will describe lists per round-12 model and reframe membership use cases as TAG patterns. `specs/08` superseded.
18. **`specs/03` (onchain indexing) and ADRs SHOULD note the lists-vs-tags distinction** — this is a recurring confusion that needs to be settled in the canonical EFS docs.

---

## Out of scope for v1 / future work

- **Stand-alone `EFSListView` contract** — the v1 `EdgeResolver` extensions cover canonical paths; a separate view contract may emerge later if specialized list helpers become desirable.
- **`displayLimit`, `weightMeaning`, `weightDirection`, `tieBreak` PROPERTYs** — apps use generic PROPERTYs; spec stays minimal.
- **Multi-attester merge conventions** — needs its own ADR.
- **Sort overlay extension for TAG sources** — `EFSSortOverlay` doesn't currently support TAG buckets; defer.
- **Cross-attester aggregation primitives** — Sybil-resistance scoping required.
- **Computed lists** — predicate-derived membership.
- **Reverse-lookup APIs as default UX** — anti-feature.
- **`specs/06` rewrite** — required before dev writes list data; will describe round-12 model.
- **`specs/08` supersession** — historical positional-anchor + FractionalSort design is no longer current.
- **FractionalSort** — parked as possible future read/index optimization.
- **`web3://<list-anchor>` ERC-5219 read shape** — router-layer concern; separate.
- **Extension to the `entryIdentity` enum beyond 3 values** — open registry; new values can be added forward-compatibly (clients reject unknown values per advisory rule).
- **Kernel-side nonce-entropy resolver** — long-tail-risk-trigger response.
- **Anchor schemaUID consistency enforcement at ListResolver** — possible v1 soft check; otherwise long-tail.

---

## Non-goals

- **Real-time collaborative single-list editing** — CRDT territory; lists are per-attester claims that compose at read time.
- **Computed lists from arbitrary queries** — dynamic membership needs a different primitive.
- **Time-windowed temporal queries** — indexer concern.
- **Cross-attester aggregation primitives at the kernel layer** — governance scope.
- **Reverse-lookup APIs as default UX surface** — anti-feature in default UX.
- **Complex per-item state machines with transitions and validations** — simple status PROPERTYs are supported; multi-step workflows are app-layer.

Lists are: **weighted membership claims by one attester at one anchor, ordered by `int256` weight, with optional per-entry metadata.** Membership-only use cases are TAG patterns, not list patterns.

---

## Implementation sketch (informative)

**v1 shipping units (committed pre-launch):**

1. **New EAS schema: `LIST`**
   - `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)`
   - `revocable: true`
   - `resolver: ListResolver` (enforces singleton-per-(attester, refUID))
   - Registered in deploy script.

2. **`ListResolver` contract** — small custom resolver enforcing:
   - Exactly one active LIST attestation per `(attester, refUID = listAnchor)`.
   - Optional soft check: `refUID` anchor's `schemaUID == LIST_SCHEMA_UID` (warn or reject).
   - Reject if `entryIdentity > 2` or `targetKind > 2` (closed enum at v1).

3. **`EdgeResolver` extensions** — three view methods (carried from rounds 7/8):
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool`
   All revert with `PageSizeTooLarge()` on `length > MAX_LIST_PAGE_SIZE = 100`.

4. **Reserved-key anchor names** — `note`, `title`, `description`, `icon`, `cover`, `status`, `quantity`, `completedAt` — added to deploy script.

5. **SDK helpers:**
   - `efs.lists.create(parentAnchor, name, opts)` — creates `Anchor<LIST_SCHEMA>` + LIST attestation
   - `efs.lists.addEntry(listAnchor, target, opts)` — creates entry anchor + PIN + weight TAG
   - `efs.lists.setMetadata(entryAnchor, key, value)` — PROPERTY-via-PIN binding
   - `efs.lists.read(listAnchor, attester, opts)` — reader with snapshot pinning
   - `canonicalEntryAnchorName(targetID, schemaUID, identityKind) → string`
   - `cryptoRandomNonce() → bytes32`

6. **Frontend list-renderer** in `packages/nextjs/` debug UI — minimal demonstration.

7. **Spec rewrite:** `specs/06-Lists-and-Collections.md` describes round-12 model; `specs/08` marked as superseded.

8. **Doc note in `specs/02` and `specs/03`** clarifying the lists-vs-tags distinction.

9. **Optional demo seed:** one list under the demo tree (`08_seed_demo_tree.ts`).

**NatSpec requirements for the three new view methods:**

- `getActiveTagTargetsWithWeights` — document address-target encoding (`bytes32(uint160(recipient))`).
- `getActiveTagPinTargetsWithWeights` — document `pinTargetID = bytes32(0)` semantics + occurrence-derived trust model warning.
- `validateAnchorNameMatchesPinTarget` — document validation scope (name-to-PIN consistency, NOT membership).

**Required pre-launch tests (conformance matrix):**

| # | Category | Test |
|---|---|---|
| 1 | List creation | Create `Anchor<LIST_SCHEMA>` + LIST attestation + 5 entries + read |
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
| 12 | List | Freeform-named entries (e.g., "milk" in shopping list) |
| 13 | List | Missing PIN on entry; reader returns `pinTargetID = bytes32(0)` |
| 14 | Reader | Page-size cap revert at length=101 |
| 15 | LIST schema | Singleton enforcement: second attestation rejected by ListResolver |
| 16 | LIST schema | Revocable: revoke succeeds; re-attest after revoke succeeds |
| 17 | Snapshot | Read at finalized block tag matches active state |
| 18 | Anchor names | Validator passes on 42-char address hex + 66-char UID hex |
| 19 | Adversarial | Squatter mismatch detected by validator |
| 20 | Indexer | TAG re-attest detected as supersession via edgeHash |
| 21 | Indexer | PIN re-attest at same slot detected as supersession (target may change) |
| 22 | Tag patterns | Allowlist / blocklist via TAG + isActiveEdge works (no list infrastructure) |

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, plus independent validation passes from Gemini and a fresh Claude instance, mediated by James Carnley. Twelve rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md). Round 12 was a structural correction reversing round-11's "lists are folders" unification — lists, folders, tags, and files are separate things that coexist inside anchors. Membership use cases (allowlists, blocklists, follow graphs) moved out of the list primitive into TAG patterns where they correctly belong.
