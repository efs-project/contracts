# EFS Lists — Design

**Status:** Draft (round 13 — free-floating LIST model)
**Date:** 2026-04-27
**Permanence-tier:** Etched-adjacent (introduces one new EAS schema; the data model is permanent post-1.0)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming) + James Carnley (architectural direction)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history, parked ideas, thirteen rounds of refinement

---

## TL;DR

**Lists are free-floating attestations. Anchors place them at paths via PIN — exactly like files.**

```
Files:  DATA (content, free-floating)        + Anchor (path) + PIN(anchor → DATA)
Lists:  LIST (config + entries, free-floating) + Anchor (path) + PIN(anchor → LIST)
```

The structural model:

```
LIST attestation L1                              (free-floating; has its own UID)
  ├── entryIdentity = 0/1/2
  ├── targetKind    = 0/1/2
  └── targetSchema  = bytes32

  Entry anchors are children of L1:
    Anchor "<entry-name>"  (refUID = L1)
      ├── PIN(definition=entry, target)
      └── weight TAG(definition=L1, refUID=entry, weight=N)

Anchor "mylist" at /alice.eth/memes/mylist/      (generic anchor, just a name)
  └── PIN(definition=anchor, refUID=L1, targetSchema=LIST_SCHEMA_UID)

Anchor "favs" at /alice.eth/categorized/favs/    (the SAME list, second placement)
  └── PIN(definition=anchor, refUID=L1, targetSchema=LIST_SCHEMA_UID)
```

The same LIST can be placed at multiple anchor paths. Editing the LIST (its entries, weights, metadata) updates the view at every path it's placed at. Bob can place Alice's LIST in his namespace — Alice still owns the list (entries are her attestations); Bob just exposes it via his path.

**Lists, folders, files, and tags are independent things that can live inside any anchor.** They're not unifications of each other.

**For pure membership claims (allowlists, blocklists, follow graphs) use TAGs directly, not lists.** Lists are exclusively for ranked/curated/metadata-bearing collections.

The picker decision:

> *Need ordering or per-entry metadata?*
>   Yes → use a list  
>   No  → use TAGs

---

## What changed in round 13

This round adopts a **free-floating LIST** model, parallel to how files work in EFS. Round-12 had the LIST attestation refer to a typed anchor (`refUID = list anchor`); round-13 frees it from any anchor binding. The anchor → LIST connection is now via PIN, like file placement.

The change brings four wins:

1. **Same list at multiple paths.** A user can place their list at `/alice/memes/mylist/` AND `/alice/categorized/favs/` — same LIST UID, two PINs from two anchors. Editing the list updates both views. Like having the same DATA at two file paths.

2. **List sharing across attesters works mechanically.** Bob can PIN Alice's LIST at Bob's anchor. Bob's namespace exposes Alice's list; Alice still owns the entries. Like Bob placing Alice's DATA at Bob's path.

3. **Singleton concern resolves itself via PIN cardinality.** Round-12 needed a custom resolver to enforce "one LIST attestation per (attester, anchor)." With free-floating LISTs, multiple LIST attestations are just multiple distinct lists; the (attester, anchor) singleton is enforced by PIN's existing cardinality-1 rule. No custom resolver needed for this.

4. **Anchor doesn't need a typed `schemaUID`.** Round-12 required `Anchor<LIST_SCHEMA>` typing on the path anchor. Round-13 uses generic anchors with PINs — apps detect "this anchor has a list" by reading its PIN, the same way they detect files. Eliminates round-12's "anchor schemaUID mismatch" pitfall.

The trade-off: one extra read step in path resolution (anchor → PIN-resolve to LIST UID → read LIST attestation → read entries). Cheap on-chain (single transaction, atomic). Mild RPC overhead off-chain.

This is the third frame-level architectural reframe across three rounds (round-11 lists-are-folders → round-12 lists-are-not-folders + membership-is-tags → round-13 lists-are-free-floating-like-files). The pattern: agents converge inside a frame; humans question the frame. Each reframe has been a real improvement, not preference shuffling.

---

## Why this matters

EFS is a graph-database substrate. The graph kernel (Anchors, PINs, TAGs) supports many overlay patterns. Each pattern should do one thing well; they coexist in the graph.

EFS's existing design separates content from placement: DATA (free-floating content) + Anchor (path) + PIN (placement). This is what makes content portable — you can place the same DATA at multiple paths, share it via cross-attester PINs, and edit content without changing path identity. Lists adopt the same pattern in round-13.

Smart contracts read these structures directly. The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK enforcement of invariants.

---

## The list primitive

A list has three layers, mirroring the file model:

1. **A LIST attestation** (free-floating; no `refUID` required) — the canonical list. Carries the configuration: how entries are named, what types of items they target. Has its own UID.

2. **Entry anchors and their content** — children of the LIST UID (`refUID = LIST UID`). Each entry PINs to its target item; weight TAGs against the LIST UID provide ordering. PROPERTYs on the entry carry per-entry metadata.

3. **One or more anchor placements** — generic anchors at paths, each with a PIN to the LIST UID. The anchor names the list at a path; the PIN binds the anchor to the list. The same LIST can have multiple placements (anchor PINs).

### Concrete example

```
/alice.eth/                                          (Alice's identity anchor)
  └── memes/                                         (generic Anchor — a folder)
        └── mylist/                                  (generic Anchor — name for the list)
              └── PIN(definition=mylist_anchor,
                      refUID=L1,
                      targetSchema=LIST_SCHEMA_UID,
                      attester=alice)                ← places list L1 at this path

LIST attestation L1                                  (free-floating; UID=L1)
  entryIdentity = 0  (target-derived)
  targetKind    = 1  (schema UID)
  targetSchema  = DATA_SCHEMA_UID

  Entry anchor "0xMemeAHash..."  (refUID=L1)
    ├── PIN(definition=entry, refUID=memeA_DATA, attester=alice)
    └── TAG(definition=L1, refUID=entry, weight=100, attester=alice)

  Entry anchor "0xMemeBHash..."  (refUID=L1)
    ├── PIN(definition=entry, refUID=memeB_DATA, attester=alice)
    └── TAG(definition=L1, refUID=entry, weight=90, attester=alice)
```

Path resolution: `web3://...alice.eth/memes/mylist/` walks anchors to `mylist`. Apps detect "this anchor has a list" by reading its PIN with `targetSchema = LIST_SCHEMA_UID`. The PIN target is the LIST UID; reading the LIST attestation gives the configuration; enumerating entries via `getActiveTagPinTargetsWithWeights(LIST_UID, alice, ANCHOR_SCHEMA_UID, ...)` returns weighted entries.

### LIST schema (NEW — Etched commitment)

```solidity
LIST schema:
  uint8   entryIdentity   // 0 = target-derived, 1 = occurrence-derived, 2 = freeform
  uint8   targetKind      // 0 = any, 1 = schema-UID typed, 2 = address
  bytes32 targetSchema    // meaningful when targetKind == 1
revocable: true
// No resolver needed: free-floating LIST has no singleton concern.
// PIN cardinality-1 handles per-(attester, anchor) uniqueness.
// Optional ListSchemaResolver may validate enum ranges as soft checks.
```

Field semantics:

- **`entryIdentity`** declares the entry-naming convention:
  - `0` (target-derived): entry name = canonical lowercase hex of `targetID`. UID targets render as 66-char `0x` + 64 hex; address targets render as 42-char `0x` + 40 hex (canonical Ethereum address form). Set semantics — same target lands at the same anchor across attesters writing to the same LIST.
  - `1` (occurrence-derived): entry name = `lowercase 0x + 64 hex of keccak256(abi.encode("efs:list-occurrence:v1", listUID, creatorAddress, clientNonce))`. Each occurrence is independent — same target can appear at multiple distinct entries. Use for playlists with duplicates, ranked ballots, syllabi.
  - `2` (freeform): entry name = curator's choice (subject to ADR-0025 anchor name validation). No deterministic structure. Use when entries have human-meaningful names (shopping list with "milk", "eggs"; todos with "send email"). Multi-attester convergence is opportunistic.

- **`targetKind`** declares what kind of inner target each entry's PIN binds to. `0` = any (entry's own `schemaUID` field declares per-entry); `1` = a specific EAS schema UID (provided in `targetSchema`); `2` = an Ethereum address (recipient-typed PIN, `targetSchema` ignored).

- **`targetSchema`** is the schema UID when `targetKind == 1`. Otherwise `bytes32(0)` (unused).

`clientNonce` (used for `entryIdentity == 1`) MUST be ≥128 bits CSPRNG entropy. Sequential or monotonic nonces are forbidden — they enable squatting attacks. (See Pitfalls — convention is unenforceable at the kernel.)

**`revocable: true`**: a curator can revoke the LIST attestation (returning all anchor placements to "pointing at a revoked list" warning state). Re-attesting after revoke is a clean lifecycle event; indexers should treat the new LIST as a distinct list (different UID).

**No mandatory custom resolver.** Round-12's ListResolver enforced singleton-per-(attester, anchor); that's no longer needed because the LIST is free-floating and PIN cardinality already enforces single-list-per-anchor at the placement layer. An optional `ListSchemaResolver` MAY validate enum ranges (`entryIdentity ≤ 2`, `targetKind ≤ 2`) as a soft check — rejects malformed declarations at write time. Not strictly required for v1 since clients reject unknown enum values per advisory rule.

### Entry anchors

Entries are children of the LIST UID (`refUID = LIST UID`). Each entry is a regular Anchor attestation. The entry's `schemaUID` field declares the inner target's schema:

- `targetKind == 1`: entry's `schemaUID == targetSchema` (e.g., `DATA_SCHEMA_UID` for a books list).
- `targetKind == 2`: entry's `schemaUID == bytes32(0)` (`ADDRESS_TARGET` sentinel).
- `targetKind == 0`: entry's `schemaUID` declares per-entry; entries can be heterogeneous within one list.

The entry's name follows the `entryIdentity` convention.

### PIN: binding the entry to its target

Each entry has at most one active PIN per attester per target schema:

- For UID targets: `PIN(definition=entry, refUID=targetUID, attester=curator)`
- For address targets: `PIN(definition=entry, recipient=address, attester=curator)`

Re-PINning supersedes O(1). For occurrence-derived and freeform entries, re-PINning to a different target is the *intended* affordance — the entry's identity is its name, not its current target binding. For target-derived entries, the canonical name → target invariant must hold (clients validate).

### Weight TAG: ordering

Each entry has at most one active weight TAG per attester:

```
TAG(definition=LIST_UID, refUID=entry, weight=N, attester=curator)
```

The TAG's definition is the **LIST UID**, not any anchor. This means `_activeByAAS[LIST_UID][curator][ANCHOR_SCHEMA_UID]` enumerates the list's active entries with weights — entries follow the LIST regardless of which anchors place it.

Re-attesting at the same edgeHash supersedes weight in O(1). Default ordering is `weight desc`, with deterministic tie-break by entry-anchor UID asc, then `tagUID` asc.

For lists where the curator manually orders entries, SDKs SHOULD use sparse `int256` weights (e.g., 2^32 spacing) with periodic rebalance. Sparse weights are NOT a universal MUST — ratings, votes, and scores use weights with intrinsic meaning.

### Per-entry metadata

PROPERTYs on the entry anchor carry per-entry state (per ADR-0034):

- A reserved key anchor under the entry (e.g., `note`, `status`)
- A free PROPERTY attestation with the value
- A PIN binding the value at the key anchor (cardinality-1 per attester)

Updating a metadata value re-binds the PIN at the same slot — O(1) supersede.

**Reserved generic PROPERTY keys**: `note`, `title`, `description`, `icon`, `cover`, `status`, `quantity`, `completedAt`. Apps SHOULD NOT shadow these with conflicting semantics. Other PROPERTY keys are app-defined.

### Anchor placements (PIN from anchor to LIST)

Connecting a path to a LIST is a single PIN attestation:

```
PIN(definition=anchor, refUID=LIST_UID, targetSchema=LIST_SCHEMA_UID, attester=curator)
```

This is a regular PIN — the same primitive that places files at paths (with `targetSchema = DATA_SCHEMA_UID`). For lists, `targetSchema = LIST_SCHEMA_UID`.

PIN cardinality-1 per `(attester, definition, targetSchema)` means each curator can place exactly one LIST at a given anchor. Re-PINning supersedes (the anchor now points at a different LIST). Revoking removes the placement (the anchor no longer has a list).

**The same LIST can be placed at multiple anchors** by having multiple PINs from different anchors all referencing the same LIST UID. **Multi-attester sharing**: Bob can PIN Alice's LIST UID at Bob's anchor; the LIST is still Alice's (entries are her attestations), but Bob's path renders it.

---

## Lists vs Tags vs Folders: when to use which

| Need | Pattern |
|---|---|
| Membership claim ("X is in Alice's allowlist") | **TAG** — `TAG(definition=anchor, recipient=X)`. Use `isActiveEdge(...)` for O(1) check. No list needed. |
| Follow / friend graph | **TAG** — `TAG(definition=alice_follows, recipient=Y)`. Per ADR-0038. |
| Ranked or ordered collection | **List** — free-floating LIST + entries + anchor placement. |
| Per-entry metadata (notes, status, captions) | **List** — entries are anchors, can carry PROPERTYs. |
| Sequence with duplicates (playlists, ballots) | **List** with `entryIdentity = 1` (occurrence-derived). |
| Folder of files | **Anchor + child anchors with PINs to DATA** (existing EFS folder pattern). No list. |
| Categorization (`#nsfw`, `#favorites`) | **TAG** — at a tag anchor. ADR-0038. |
| Permissions / roles / DAO membership | **TAG** — membership claim. |

Lists are heavy (LIST + entries + anchor PIN); they exist to serve use cases tags can't (ranking, per-entry mutable state). Don't make lists do tag work.

---

## Reader API (v1)

Smart contracts and clients read lists via existing `EdgeResolver` view methods plus three v1 extensions (the same set committed in earlier rounds, all generic graph-composition names — no list-overlay vocabulary in the kernel ABI).

**Existing readers used by lists** (per ADR-0041 §8):
- `getActiveTagEntries(definition, attester, targetSchema, start, length) → (tagUID, weight)[]`
- `getActivePinTarget(definition, attester, targetSchema) → targetID` (returns `bytes32(0)` on missing)
- `isActiveEdge(attester, targetID, definition, schema) → bool` — for tag-based membership patterns

**v1 extensions on `EdgeResolver`** (immutable post-1.0):
- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — generic TAG bucket reader with target extraction.
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends previous: for TAGs targeting anchors, additionally resolves the anchor's PIN target. **THE canonical list reader** when called with `tagTargetSchema = ANCHOR_SCHEMA_UID`.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic self-naming-anchor consistency check.

**Pagination cap (enforced):** `length` MUST be ≤ `MAX_LIST_PAGE_SIZE = 100`. Readers MUST revert with `PageSizeTooLarge()`.

### Canonical read recipe (single-curator scope, default)

For an anchor at a path, curator `alice`:

```
1. Path-walk to the anchor (mylist_anchor).

2. Resolve the LIST UID via PIN:
   listUID = EdgeResolver.getActivePinTarget(
     mylist_anchor,
     alice,
     LIST_SCHEMA_UID
   )
   - If bytes32(0): no list at this path; render folder/empty/etc.

3. Read the LIST configuration:
   listAttestation = eas.getAttestation(listUID)
   - Decode (entryIdentity, targetKind, targetSchema) from listAttestation.data.
   - If revoked: render warning ("list at this path has been revoked").

4. Enumerate entries with weights:
   entries = EdgeResolver.getActiveTagPinTargetsWithWeights(
     listUID,
     alice,             // attester (curator)
     ANCHOR_SCHEMA_UID, // entries are anchors
     start,
     length
   )
   - Returns (entryUID, tagUID, innerTargetID, innerTargetSchema, weight, attester)[]

5. For each entry:
   - If innerTargetID == bytes32(0), render warning state (missing inner PIN).
   - If targetKind != 0, validate innerTargetSchema matches targetSchema.

6. If entryIdentity == 0 (target-derived), validate name consistency:
   - For each entry: validateAnchorNameMatchesPinTarget(entryUID, alice).
   - On false: render warning OR suppress.

7. For metadata PROPERTYs (note, status, etc.):
   - Resolve named key anchor under entry; read PROPERTY value.

8. Apply default total order:
   - Sort by weight desc, tie-break by entryUID asc, then tagUID asc.

9. Truncate to client-chosen displayLimit.
```

The recipe has one extra step compared to round-12 (PIN resolution to LIST UID), but enables the multi-anchor and shared-list use cases.

### Snapshot consistency

Smart contracts calling the v1 readers in a single transaction get atomic snapshot consistency for free — EVM atomicity per call. Off-chain clients paginating across multiple RPC calls MUST pin all reads to the same `blockTag`. Governance / on-chain consumers SHOULD read from finalized blocks.

---

## Editions and multi-attester reads

Default reads are **single-curator-scoped**. The curator's LIST attestation, weight TAGs, entry PINs, and entry metadata all come from one attester.

### Per-attester ownership

The LIST attestation has an attester (the curator who created it). Entries (`refUID = LIST UID`) are also typically authored by the curator. Weight TAGs against the LIST UID and entry PINs are per-attester.

If Bob places Alice's LIST UID at Bob's anchor, Bob is just exposing Alice's list at Bob's namespace — Alice is still the curator (her LIST attestation, her entries, her weights). Bob's PIN is a "shortcut" or "bookmark."

### Cross-attester contributions to the same LIST

Bob can write his own weight TAGs and entry anchors against Alice's LIST UID (`refUID = Alice's LIST UID`). This makes Bob a co-contributor to the list's per-attester storage:

- `_activeByAAS[LIST_UID][alice][ANCHOR_SCHEMA_UID]` → Alice's entries and weights
- `_activeByAAS[LIST_UID][bob][ANCHOR_SCHEMA_UID]` → Bob's entries and weights

Single-curator reads still scope to one attester. Multi-attester views (compare/merge UI) read both buckets. Edition independence is preserved: each curator's contributions are stored independently.

### Identity convergence

**For `entryIdentity = 0` (target-derived):** entry anchors are SHARED schelling points. Alice and Bob's "entry for book X" land at the same anchor (deterministic name from target hash). Each writes their own PIN, weight TAG, and metadata. Readers filter at the PIN/TAG layer; the entry anchor is shared infrastructure.

**For `entryIdentity = 1` (occurrence-derived):** entry anchors are per-curator (each `clientNonce` differs). Independent entry-anchor sets per attester.

**For `entryIdentity = 2` (freeform):** entry naming is curator's choice. Multi-attester convergence is opportunistic.

### List sharing patterns enabled by free-floating LISTs

- **Same list at multiple paths (single curator):** Alice creates LIST `L1`, then PINs it at `/alice/memes/mylist/` AND `/alice/categorized/favs/`. Two paths, one list. Edits propagate.
- **Bob bookmarks Alice's list:** Bob PINs Alice's `L1` at `/bob/i-like/alices-list/`. Bob's namespace exposes Alice's list. Alice's edits show up in Bob's view; Bob can't edit Alice's list (he's not the curator), but can add his own entries (becomes co-contributor) or just leave it as a read-only reference.
- **DAO-curated lists:** A Safe (smart account) is the LIST attester. Members propose entry adds via Safe transactions. Other addresses bookmark the Safe-curated LIST in their own folders.

**Merge semantics** are not part of this design. Clients pick how to render multi-attester per use case. Default is single-curator-scoped; multi-attester is advisory and clients MUST preserve attribution.

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
| 6 | Tier list (S/A/B with sub-rank) | target | Weight encodes tier+rank, or `tier` PROPERTY |
| 7 | Curated awesome-EFS guide | target | Per-entry rationale |
| 8 | DAO delegate slate (ranked candidates) | target | Weight = preference |
| 9 | "People I trust for X topic" | target | Per-list context note |
| 10 | Cross-list reuse (same target in multiple lists) | target | Independent LIST UIDs |
| 11 | Annotated bookmarks | target | URL via DATA wrapper; `note` PROPERTY |
| 12 | Inventory / stock list | target | `stock`, `price` PROPERTYs |
| 13 | Achievements with date earned | target | `earnedAt` PROPERTY |
| 14 | **Same list at multiple paths** (NEW in round-13) | any | Multiple anchor PINs to same LIST UID |
| 15 | **Bob bookmarks Alice's list** (NEW in round-13) | any | Bob PINs Alice's LIST UID at Bob's anchor |
| 16 | **Moving a list between folders** (NEW in round-13) | any | Revoke old anchor PIN; create new at different anchor |
| 17 | Playlist with duplicates | occurrence | Same DATA at multiple entries |
| 18 | Syllabus / step-by-step guide | occurrence | Per-step prose |
| 19 | Ranked ballot | occurrence | Position is meaningful |
| 20 | Shopping list (items with status) | freeform | Names like "milk", "eggs"; `status` PROPERTY |
| 21 | Todo list (status per task) | freeform | Names are task descriptions; `status` PROPERTY |
| 22 | Custom-named curated catalogue | freeform | Curator chooses entry names |
| 23 | Course curriculum (lessons with status) | occurrence | `status` per lesson |

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

For TAG patterns, no list infrastructure is needed. The anchor is just a regular anchor; TAGs directly target items. Cheap O(1) writes and reads.

---

## Pitfalls and safety

### Stale anchor PINs to revoked LISTs (NEW in round-13)

Because anchors PIN to free-floating LIST UIDs, a curator could:
- Place LIST `L1` at anchor `/alice/memes/mylist/` (PIN exists)
- Revoke `L1` later

The anchor PIN still references `L1`, but `L1` is revoked. Apps reading the path get a stale pointer. Clients MUST detect this:

1. Read `getActivePinTarget(anchor, attester, LIST_SCHEMA_UID)` → returns `L1`
2. Check `eas.getAttestation(L1).revoked` (or equivalent) — if true, render warning "list at this path has been revoked"
3. Don't try to enumerate entries; surface the revocation visibly

Curators wanting clean removal SHOULD revoke the anchor PIN BEFORE revoking the LIST attestation. SDK helpers SHOULD do this in the right order automatically.

### Entry-anchor squatting (`entryIdentity = 0` only)

For target-derived entries, the entry name encodes the target. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target.

Clients MUST validate via `EdgeResolver.validateAnchorNameMatchesPinTarget(entryAnchor, attester)`. Mismatch → render warning OR suppress; never silently treat as valid.

For `entryIdentity = 1` and `entryIdentity = 2`, name validation does NOT apply.

### `clientNonce` convention is unenforceable at the kernel

Sequential nonces and CSPRNG output produce identical-looking `keccak256` hashes. The kernel cannot distinguish.

Smart contracts consuming `entryIdentity = 1` lists SHOULD treat the entry's UID and the curator's TAG attestation as the trust unit — NOT the entry name pattern.

### Attribution confusion in shared / multi-anchor lists

When Bob bookmarks Alice's LIST in his namespace, viewers walking Bob's path see Alice's list. Apps MUST clearly label the curator (Alice), not the placer (Bob). If Bob is also a co-contributor (writing his own TAGs/PINs against Alice's LIST UID), the multi-attester rendering MUST distinguish "Alice's entry weighted N" from "Bob's entry weighted M."

This is the round-13-specific UX risk. Single-curator scope simplifies it (default rendering shows only one curator's contributions), but apps offering compare/merge UI must be careful.

### Lists of people are public, durable, attribution-labeled

Publishing a list of addresses puts them on-chain durably. Clients SHOULD label issuer attribution clearly; treat lists as durable; remember revocation removes active claim but not historical attestation.

For blocklist-style use cases, the right primitive is TAGs (see Lists vs Tags section), not lists.

### "Lists containing X" is an anti-feature in default UX

Anyone can put anyone on any list. Profile pages MUST NOT default-render reverse lookups. Reverse lookups MAY be exposed only to the viewing user themselves, opt-in only.

### Reverse lookups: which anchors place this LIST?

For "show all paths where Alice's list X appears," use `getEdgeDefinitions(LIST_UID)` per ADR-0041 §8. Returns all definitions (anchors) that have this LIST UID as a PIN target. Useful but not a default-render.

### Target universe — not everything is a PIN target

PIN's `refUID` must point at an existing EAS attestation. Raw schema UIDs are NOT valid PIN targets. Schema registries MUST target schema-alias anchors per ADR-0033.

URLs and other off-chain identifiers similarly need a wrapper (DATA attestation with the URL as content) to be PIN'd.

### ADR-0042 effective-TAG filter does NOT apply to lists

ADR-0042's "effective TAG = active TAG with `weight ≥ 0`" convention does NOT apply to custom lists. Negative weights are valid and meaningful. Apps MAY apply a `weight ≥ 0` filter for UX reasons; the canonical default is "active = unrevoked."

---

## Indexer notes (for subgraph implementers)

**Free-floating LIST events.** A LIST attestation arrives as an EAS event without anchor context (no `refUID`). Indexers track LISTs by UID. Path discovery requires correlating LIST UIDs with anchor PINs that target them.

**Anchor-to-LIST PIN events.** Indexers detect "list placed at this anchor" via PIN events with `targetSchema = LIST_SCHEMA_UID`. Track these to maintain anchor-to-LIST associations.

**Active state vs historical state.** `_activeByAAS` reflects current active TAGs (post-revocation). Track revocation events and apply swap-and-pop semantics (per ADR-0007).

**TAG supersession via re-attest at same edgeHash** (per ADR-0041 §4). Re-attesting a TAG updates the active entry's UID and weight in place, **without emitting a `Revoked` event for the prior TAG**. Indexers MUST detect this:
- Compute `edgeHash = (attester, targetID, definition, schema)`.
- If a prior TAG with same `edgeHash` exists in active set, treat as superseded — replace, don't double-count.

**PIN supersession is slot-based, not edgeHash-based.** Re-attesting a PIN at slot `(definition, attester, targetSchema)` supersedes the prior — **even when the target changes**. Anchor-to-LIST PINs follow this rule: if a curator changes which LIST is placed at an anchor, the slot supersedes (no `Revoked` event for the old PIN).

**LIST revocation lifecycle.** LIST is `revocable: true`. When revoked, all anchor PINs targeting it become "stale" (referencing a revoked attestation). Indexers SHOULD propagate revocation state to all paths placing the LIST.

**Discovery indexes vs active state.** `_targetsByDef`, `_edgeDefinitions`, etc. are append-only discovery indexes including historical entries; NOT ground truth for current active state. Cross-reference active-set storage.

**Reverse-lookup support.** `getEdgeDefinitions(LIST_UID)` returns all definitions (anchors) that PIN to this LIST. Useful for "show all paths where this list appears" UX queries.

---

## Conventions vs enforcement — long-tail risk

This design relies on convention enforcement for invariants the kernel cannot validate: `clientNonce` CSPRNG entropy, target-derived entry name consistency, anchor PIN order on LIST revocation.

Revisit triggers fire if convention compliance drops below tolerance post-launch:

- **Target-derived entry name mismatches exceed measurable share** → ship enforcement via custom resolver on entry anchors.
- **Squatting-pattern signals appear post-launch** → ship kernel-side nonce-entropy or rate-limit resolver.
- **Stale anchor PINs to revoked LISTs become a UX problem** → ship resolver-level revocation propagation (auto-revoke anchor PINs when LIST is revoked).
- **Cross-client divergence on read recipes** → ship a canonical reference SDK as the de facto interpreter.

These are operational triggers; they represent conditions under which "convention only" becomes load-bearing tech debt.

---

## Decisions resolved (round-13 updated)

1. **LIST attestations are free-floating.** Like DATA. They have their own UID and exist independently of any anchor. Round-12 had LIST attached to a typed anchor via `refUID`; round-13 frees the LIST.
2. **Anchor → LIST connection is a PIN.** Same primitive that places files at paths. Cardinality-1 per (attester, anchor, targetSchema=LIST_SCHEMA_UID).
3. **Same LIST can be placed at multiple anchors.** Multiple PINs from different anchors all reference the same LIST UID. Editing the LIST updates all views.
4. **Cross-attester sharing and contribution work natively.** Bob can PIN Alice's LIST at Bob's anchor (read-only "bookmark"); Bob can also write entries/weights against Alice's LIST UID (becomes co-contributor).
5. **Path anchor is generic** — no `Anchor<LIST_SCHEMA>` typing required. Apps detect lists by reading the anchor's PIN, same way they detect files.
6. **Singleton-per-anchor is enforced by PIN cardinality**, not a custom resolver. Round-12's ListResolver singleton enforcement is no longer needed at this layer.
7. **Lists are NOT folders.** Anchors are containers; lists, folders, files, and tags are separate things that can coexist inside anchors.
8. **Membership patterns use TAGs**, not lists. Allowlists, blocklists, follow graphs, DAO membership, categorization, permissions — all are tagging patterns.
9. **`isActiveEdge` is the membership primitive** for tag patterns.
10. **Always-wrapped within the list primitive.** Entries are anchors with PINs; one mode.
11. **LIST schema (NEW EAS schema, revocable, no required resolver).** Field set: `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)`. Three values for `entryIdentity` (target/occurrence/freeform). Optional `ListSchemaResolver` may validate enum ranges.
12. **Smart contracts read directly via three new `EdgeResolver` view methods** (carried from rounds 7/8). Generic graph-composition names.
13. **Single-curator-scoped reads as default.** Multi-attester is opt-in.
14. **Default ordering: `weight desc`, tie-break by entry-UID asc, then `tagUID` asc.**
15. **Sparse `int256` weights are an SDK SHOULD for manual ordering**, NOT a universal MUST.
16. **Page cap MUST = 100**, enforced via `PageSizeTooLarge()` revert.
17. **`clientNonce` ≥128 bits CSPRNG** — convention only; kernel cannot enforce.
18. **Snapshot consistency MUST**: smart contracts get atomicity; off-chain pin `blockTag`; governance reads finalized.
19. **Convention-violating lists are accepted v1 risk** with named revisit triggers.
20. **Shopping lists, todos, stateful per-entry items are core supported use cases** via `entryIdentity = 2` + per-entry PROPERTYs.
21. **`specs/06` rewrite required before dev** writes list data. `specs/08` superseded.
22. **`specs/02` and `specs/03` SHOULD note the lists-vs-tags distinction** explicitly.
23. **NEW round-13 use cases**: same-list-multiple-paths, list-bookmarking-across-attesters, moving-a-list-between-folders. All naturally enabled by free-floating model.

---

## Out of scope for v1 / future work

- **Stand-alone `EFSListView` contract** — the v1 `EdgeResolver` extensions cover canonical paths.
- **Multi-attester merge conventions** — needs its own ADR.
- **Sort overlay extension for TAG sources** — defer.
- **Cross-attester aggregation primitives** — Sybil-resistance scoping required.
- **Computed lists** — predicate-derived membership.
- **Reverse-lookup APIs as default UX** — anti-feature; opt-in only.
- **`specs/06` rewrite** — required before dev writes list data.
- **`specs/08` supersession** — historical.
- **FractionalSort** — parked.
- **`web3://<list-anchor>` ERC-5219 read shape** — router-layer concern.
- **Auto-revocation propagation** (revoke anchor PINs when LIST is revoked) — long-tail-risk-trigger response.
- **`ListSchemaResolver` enum-range validation** — optional v1 soft check; not strictly required since clients reject unknown values per advisory rule.
- **Kernel-side nonce-entropy resolver** — long-tail-risk-trigger response.

---

## Non-goals

- **Real-time collaborative single-list editing** — CRDT territory.
- **Computed lists from arbitrary queries** — needs a different primitive.
- **Time-windowed temporal queries** — indexer concern.
- **Cross-attester aggregation primitives at the kernel layer** — governance scope.
- **Reverse-lookup APIs as default UX surface** — anti-feature.
- **Complex per-item state machines with transitions and validations** — simple status PROPERTYs supported; multi-step workflows are app-layer.

Lists are: **weighted membership claims by one (or more) attester(s) at a free-floating LIST UID, ordered by `int256` weight, with optional per-entry metadata, placed at one or more anchor paths via PIN.** Membership-only use cases are TAG patterns, not list patterns.

---

## Implementation sketch (informative)

**v1 shipping units (committed pre-launch):**

1. **New EAS schema: `LIST`**
   - `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)`
   - `revocable: true`
   - `resolver: 0x0` (no required resolver) OR optional `ListSchemaResolver` for enum-range validation
   - Registered in deploy script.

2. **`EdgeResolver` extensions** — three view methods (carried from rounds 7/8):
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool`
   All revert with `PageSizeTooLarge()` on `length > 100`.

3. **Reserved-key anchor names** — `note`, `title`, `description`, `icon`, `cover`, `status`, `quantity`, `completedAt`.

4. **SDK helpers:**
   - `efs.lists.create(opts) → listUID` — creates free-floating LIST attestation
   - `efs.lists.placeAt(listUID, anchor) → pinUID` — creates anchor PIN to LIST
   - `efs.lists.unplaceFrom(listUID, anchor)` — revokes anchor PIN
   - `efs.lists.bookmarkAtMyPath(listUID, anchor)` — Bob places Alice's LIST at Bob's anchor
   - `efs.lists.addEntry(listUID, target, opts)` — creates entry anchor + PIN + weight TAG
   - `efs.lists.setMetadata(entryAnchor, key, value)`
   - `efs.lists.read(anchor, attester, opts)` — reader: PIN-resolves to LIST UID, then enumerates entries
   - `efs.lists.readByUID(listUID, attester, opts)` — direct read by LIST UID
   - `canonicalEntryAnchorName(targetID, schemaUID, identityKind) → string`
   - `cryptoRandomNonce() → bytes32`
   - Mode-flip guard: refuses to revoke LIST without first revoking placement PINs

5. **Frontend list-renderer** in `packages/nextjs/` debug UI.

6. **Spec rewrite:** `specs/06` describes round-13 free-floating model; `specs/08` marked superseded.

7. **Doc note in `specs/02` and `specs/03`** clarifying lists-vs-tags distinction.

8. **Optional demo seed:** one LIST + one anchor placement.

**Required pre-launch tests (conformance matrix):**

| # | Category | Test |
|---|---|---|
| 1 | LIST creation | Create free-floating LIST attestation; UID exists; not anchored |
| 2 | LIST placement | PIN LIST at anchor; reader resolves anchor → LIST UID via `getActivePinTarget` |
| 3 | LIST | Add 5 entries (`refUID = LIST UID`); read via `getActiveTagPinTargetsWithWeights(LIST_UID, ...)` |
| 4 | LIST | Reorder via re-attest weight TAG at same edgeHash |
| 5 | LIST | Revoke entry TAG; swap-and-pop semantics |
| 6 | LIST | Address-target entries via PIN `recipient` |
| 7 | LIST | Negative weight stays active (ADR-0042 doesn't apply) |
| 8 | LIST | Add `note` PROPERTY to entry; update via PIN re-attest |
| 9 | LIST | `validateAnchorNameMatchesPinTarget` passes/fails correctly |
| 10 | LIST | Multi-attester at shared entry anchor (target-derived) |
| 11 | LIST | Two distinct entries, same target (occurrence-derived) |
| 12 | LIST | Re-PIN occurrence-derived entry to different target |
| 13 | LIST | Freeform-named entries (e.g., "milk") |
| 14 | LIST | Missing PIN on entry; reader returns `pinTargetID = bytes32(0)` |
| 15 | **Same LIST, two anchors** | Place LIST at A1; place same LIST at A2; both paths resolve to same LIST UID |
| 16 | **Bob bookmarks Alice's LIST** | Bob PINs Alice's LIST UID at Bob's anchor; reader resolves correctly |
| 17 | **Move LIST between anchors** | Revoke PIN at A1; create PIN at A2; LIST follows |
| 18 | **LIST revocation propagates** | Revoke LIST; anchor PIN to it returns "stale" warning |
| 19 | Reader | Page-size cap revert at length=101 |
| 20 | LIST schema | Revocable: revoke succeeds; re-attest creates new UID (different list) |
| 21 | Snapshot | Read at finalized block tag matches active state |
| 22 | Anchor names | Validator passes on 42-char address hex + 66-char UID hex |
| 23 | Adversarial | Squatter mismatch detected by validator |
| 24 | Indexer | TAG re-attest detected as supersession via edgeHash |
| 25 | Indexer | PIN re-attest at same slot detected as supersession (target may change) |
| 26 | Indexer | Reverse lookup `getEdgeDefinitions(LIST_UID)` returns all anchor placements |
| 27 | Tag patterns | Allowlist via TAG + isActiveEdge works (no list infrastructure) |

**NatSpec requirements** (carried from earlier rounds): document address-target encoding, `pinTargetID = bytes32(0)` semantics, occurrence-derived trust model, validation scope.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, plus independent validation passes from Gemini and a fresh Claude instance, mediated by James Carnley. Thirteen rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md). Round 13 adopted the free-floating LIST model (parallel to how files work in EFS), enabling same-list-at-multiple-paths and cross-attester sharing as natural use cases.
