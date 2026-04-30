# EFS Lists — Design

**Status:** Draft (round 14 — typed list anchors + free-floating LIST attestations)
**Date:** 2026-04-30
**Permanence-tier:** Etched-adjacent (introduces one new EAS schema; the data model is permanent post-1.0)
**Authors:** Claude Sonnet 4.7 + Codex GPT-5 (cross-agent brainstorming) + James Carnley (architectural direction)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history, parked ideas, fourteen rounds of refinement

---

## TL;DR

**Lists are free-floating attestations attached at typed list anchors via PIN. The typed anchor declares "this slot is a list"; the LIST attestation carries the configuration and entries.**

```
Files:      DATA (free-floating) + Anchor<generic>      + PIN(anchor → DATA, targetSchema=DATA)
Lists:      LIST (free-floating) + Anchor<schemaUID=LIST> + PIN(anchor → LIST, targetSchema=LIST)
PROPERTYs:  PROPERTY (free-floating) + Anchor<schemaUID=PROPERTY> + PIN(anchor → PROPERTY)
```

Each kind of attached thing has its own anchor namespace: typed name anchors signal what kind of slot they are. Reading a typed anchor tells you its category before you fetch the attached attestation.

**The picker decision:**

> *Need ordering or per-entry metadata?*
>   Yes → use a list  
>   No  → use TAGs

Lists are exclusively for ranked/curated/metadata-bearing collections. Pure membership (allowlists, blocklists, follow graphs, DAO membership, categorization, permissions) uses TAGs directly. See [Lists vs Tags vs Folders](#lists-vs-tags-vs-folders-when-to-use-which) below.

The structural model:

```
LIST attestation L1                              (free-floating; has its own UID; revocable: false)
  ├── entryIdentity = 0/1/2
  ├── targetKind    = 0/1/2
  └── targetSchema  = bytes32

  List-level metadata (title, description, etc.) attaches to L1 via PROPERTY slots:
    Anchor<PROPERTY>(name="title", refUID=L1)
      └── PIN(refUID=titlePropertyUID)

  Entry anchors are children of L1:
    Anchor<generic>("<entry-name>", refUID=L1)
      ├── PIN(definition=entry, target)         ← target-bearing entries
      │                                            (omitted for freeform "entry IS the data")
      └── weight TAG(definition=L1, refUID=entry, weight=N)

Path placement (typed anchor → LIST attestation):
  Anchor<schemaUID=LIST_SCHEMA_UID>("mylist", refUID=parent_anchor)
    └── PIN(definition=mylist_anchor, refUID=L1, targetSchema=LIST_SCHEMA_UID)

The same LIST can be placed at multiple typed list anchors. Editing the LIST
(its entries, weights, metadata) updates the view at every path it's placed
at. Bob can place Alice's LIST in his namespace — Alice still owns the list
(entries are her attestations); Bob just exposes it via his path.
```

**Lists, folders, files, and tags are independent things that can live inside any anchor.** They're not unifications of each other.

---

## What changed in round 14

Round 14 unifies the round-12 typed-anchor insight with round-13's free-floating LIST attestation, and resolves several reviewer concerns in one move.

**Typed list anchors return.** The path anchor for a list is `Anchor<schemaUID=LIST_SCHEMA_UID>`, the same way property slots use `Anchor<schemaUID=PROPERTY_SCHEMA_UID>`. Reading the anchor tells you "this slot is for a list" before fetching anything else. Files use generic anchors today; lists and properties use typed anchors. Each kind of attached thing has its own namespace.

**LIST attestation stays free-floating** (round-13's correct insight). The LIST has its own UID; it's not bound to any anchor via `refUID`. The anchor → LIST connection is a PIN. This preserves all the round-13 wins: same list at multiple typed anchors, list sharing across attesters, list movement between folders.

**`revocable: false`** on the LIST schema. Like DATA. "Deleting" a list at a path = revoke the placement PIN; the LIST attestation itself stays at its UID forever. This removes the curator-key-compromise concern entirely (Alice can't kill bookmarkers' references) and matches the file-parallel cleanly. Bookmark PINs to a LIST UID never go stale.

**List-level metadata attaches to the LIST attestation**, not the path anchor. Title, description, cover, etc. live as PROPERTY slots under the LIST UID (`Anchor<PROPERTY>(name="title", refUID=L1) → PIN → property value`). Bob's bookmark of Alice's list inherits the title automatically.

**Freeform entries (`entryIdentity = 2`) are first-class rows.** A grocery list entry "milk" doesn't need an inner PIN — the entry anchor IS the entry. Status, quantity, etc. attach as PROPERTYs. Target-bearing entries (top-N memes) still PIN to targets; the inner PIN is now optional based on `entryIdentity`.

**Co-contribution stays.** Anyone can write entries against another curator's LIST UID; editions filter at read time (default reads scope to one curator). The "Bob co-contributes to Alice's list" affordance is real and useful; spam is handled by viewer choice, not by gating writes at the kernel.

The wins this round adds on top of round-13:

1. **Cross-`targetSchema` ambiguity is gone.** Typed list anchors can only hold lists. No precedence rule needed when the same path could hold a file vs a list — you get one or the other, not both.
2. **List-level metadata has a defined home** (Gemini's must-fix).
3. **Freeform lists don't carry dead-weight target PINs** (Codex's must-fix).
4. **Bookmark stability across curator key-compromise** (`revocable: false`).
5. **Reader API is split between placer and curator scope** (Codex's must-fix; see Reader API section).

This is the fourth frame-level refinement (round-11 lists-are-folders → round-12 lists-are-not-folders + membership-is-tags → round-13 free-floating LIST → round-14 typed-anchor + free-floating LIST). The pattern: agents converge inside a frame; humans question the frame.

---

## Why this matters

EFS is a graph-database substrate. The graph kernel (Anchors, PINs, TAGs) supports many overlay patterns. Each pattern should do one thing well; they coexist in the graph.

EFS's existing design separates content from placement: DATA (free-floating content) + Anchor (path) + PIN (placement). This is what makes content portable — you can place the same DATA at multiple paths, share it via cross-attester PINs, and edit content without changing path identity. Lists adopt the same pattern in round-13.

Smart contracts read these structures directly. The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK enforcement of invariants.

---

## The list primitive

A list has three layers, mirroring the file model:

1. **A LIST attestation** (free-floating; no `refUID` required) — the canonical list. Carries the configuration: how entries are named, what types of items they target. Has its own UID. List-level metadata (title, description, cover) attaches to the LIST attestation as PROPERTYs.

2. **Entry anchors and their content** — children of the LIST UID (`refUID = LIST UID`). Target-bearing entries PIN to their target item; freeform entries skip the inner PIN (the anchor IS the entry). Weight TAGs against the LIST UID provide ordering. PROPERTYs on the entry carry per-entry metadata.

3. **One or more typed list anchor placements** — `Anchor<schemaUID=LIST_SCHEMA_UID>` at paths, each with a PIN to the LIST UID. The typed anchor names the list at a path AND signals "this slot is a list"; the PIN binds the anchor to the list. The same LIST can have multiple placements.

### Concrete example

```
/alice.eth/                                          (Anchor<generic> — Alice's identity)
  └── memes/                                         (Anchor<generic> — a folder)
        └── mylist/                                  (Anchor<schemaUID=LIST_SCHEMA_UID>
                                                      — typed list slot, refUID=memes)
              └── PIN(definition=mylist_anchor,
                      refUID=L1,
                      targetSchema=LIST_SCHEMA_UID,
                      attester=alice)                ← places list L1 at this path

LIST attestation L1                                  (free-floating; UID=L1; revocable: false)
  entryIdentity = 0  (target-derived)
  targetKind    = 1  (schema UID)
  targetSchema  = DATA_SCHEMA_UID

  List-level metadata (travels with L1, not the path anchor):
    Anchor<PROPERTY>(name="title", refUID=L1)
      └── PIN(refUID=titleProp_attestation_uid)      ← title = "Alice's Top Memes"
    Anchor<PROPERTY>(name="description", refUID=L1)
      └── PIN(refUID=descProp_attestation_uid)

  Entry anchor "0xMemeAHash..."  (Anchor<generic>, refUID=L1)
    ├── PIN(definition=entry, refUID=memeA_DATA, attester=alice)  ← target-bearing entry
    └── TAG(definition=L1, refUID=entry, weight=100, attester=alice)

  Entry anchor "0xMemeBHash..."  (Anchor<generic>, refUID=L1)
    ├── PIN(definition=entry, refUID=memeB_DATA, attester=alice)
    └── TAG(definition=L1, refUID=entry, weight=90, attester=alice)
```

Path resolution: `web3://...alice.eth/memes/mylist/` walks anchors to `mylist`. The reader sees `mylist`'s schemaUID = `LIST_SCHEMA_UID` and knows this is a list slot. Reading its PIN with `targetSchema = LIST_SCHEMA_UID` returns the LIST UID. Reading the LIST attestation gives the configuration; enumerating entries via `getActiveTagPinTargetsWithWeights(LIST_UID, curator, ANCHOR_SCHEMA_UID, ...)` returns weighted entries.

### LIST schema (NEW — Etched commitment)

```solidity
LIST schema:
  uint8   entryIdentity   // 0 = target-derived, 1 = occurrence-derived, 2 = freeform
  uint8   targetKind      // 0 = any, 1 = schema-UID typed, 2 = address
  bytes32 targetSchema    // meaningful when targetKind == 1
revocable: false
// No resolver required.
// Singleton-per-anchor (one LIST per typed list anchor per attester) is enforced
// by PIN cardinality-1 at the placement layer.
// Optional ListSchemaResolver MAY validate enum ranges as a soft check at write
// time, but is not required for v1 since clients reject unknown enum values per
// advisory rule.
```

Field semantics:

- **`entryIdentity`** declares the entry-naming convention:
  - `0` (target-derived): entry name = canonical lowercase hex of `targetID`. UID targets render as 66-char `0x` + 64 hex; address targets render as 42-char `0x` + 40 hex (canonical Ethereum address form). Set semantics — same target lands at the same anchor across attesters writing to the same LIST. Inner PIN required.
  - `1` (occurrence-derived): entry name = `lowercase 0x + 64 hex of keccak256(abi.encode("efs:list-occurrence:v1", listUID, creatorAddress, clientNonce))`. Each occurrence is independent — same target can appear at multiple distinct entries. Use for playlists with duplicates, ranked ballots, syllabi. Inner PIN required.
  - `2` (freeform): entry name = curator's choice (subject to ADR-0025 anchor name validation). The entry anchor IS the entry — **inner PIN optional**, used only when the entry references an external item. Use when entries have human-meaningful names (shopping list with "milk", "eggs"; todos with "send email"). Multi-attester convergence is opportunistic.

- **`targetKind`** declares what kind of inner target each entry's PIN binds to (when present). `0` = any (entry's own `schemaUID` field declares per-entry); `1` = a specific EAS schema UID (provided in `targetSchema`); `2` = an Ethereum address (recipient-typed PIN, `targetSchema` ignored).

- **`targetSchema`** is the schema UID when `targetKind == 1`. Otherwise `bytes32(0)` (unused).

`clientNonce` (used for `entryIdentity == 1`) MUST be ≥128 bits CSPRNG entropy. Sequential or monotonic nonces are forbidden — they enable squatting attacks. (See Pitfalls — convention is unenforceable at the kernel.)

**`revocable: false`**: a LIST attestation is permanent at its UID, like DATA. There is no "revoke the LIST" operation. To remove a list from a path, revoke the typed list anchor's placement PIN — the LIST attestation stays at its UID (still readable; if it was placed at other anchors, it's still reachable there). To deprecate a list entirely, revoke all its placement PINs across all anchors. Bookmark PINs from other curators' anchors stay valid as long as the bookmarker doesn't revoke them.

**No mandatory custom resolver.** PIN cardinality-1 at the placement layer enforces "one LIST per `(attester, list_anchor, LIST_SCHEMA)` slot". The typed list anchor's own schemaUID prevents cross-`targetSchema` collisions (a list anchor can only hold a list). An optional `ListSchemaResolver` MAY validate enum ranges (`entryIdentity ≤ 2`, `targetKind ≤ 2`) as a soft check — rejects malformed declarations at write time. Not strictly required for v1 since clients reject unknown enum values per advisory rule.

### List-level metadata (NEW in round-14)

List-level metadata (title, description, cover image, etc.) attaches to the **LIST attestation**, not the path anchor. This means metadata travels with the LIST UID — when Bob bookmarks Alice's LIST at his path, Bob's view sees Alice's title automatically.

The pattern follows ADR-0034/ADR-0041 PROPERTY conventions:

```
LIST attestation L1
  └── Anchor<schemaUID=PROPERTY_SCHEMA_UID>(name="title", refUID=L1)
        └── PIN(definition=titleAnchor, refUID=titleValue_PROPERTY_UID, attester=alice)
```

**Reserved key anchor names for list-level metadata** (apps SHOULD NOT shadow):
- `title` — short display name
- `description` — longer description
- `cover` — DATA UID for cover image
- `icon` — DATA UID for small icon
- `category` — string category label

Updating metadata: re-PIN at the same `(curator, key_anchor, PROPERTY_SCHEMA)` slot — O(1) supersede. Per-curator: each curator's metadata PINs are independent. Default reads scope to the LIST's attester (the curator).

### Entry anchors

Entries are children of the LIST UID (`refUID = LIST UID`). Each entry is a regular `Anchor<generic>` attestation. The entry's `schemaUID` field declares the inner target's schema (when an inner PIN is present):

- `targetKind == 1`: entry's `schemaUID == targetSchema` (e.g., `DATA_SCHEMA_UID` for a books list).
- `targetKind == 2`: entry's `schemaUID == bytes32(0)` (`ADDRESS_TARGET` sentinel).
- `targetKind == 0`: entry's `schemaUID` declares per-entry; entries can be heterogeneous within one list.
- `entryIdentity == 2` (freeform) with no inner PIN: entry's `schemaUID == bytes32(0)`. The entry stands alone.

The entry's name follows the `entryIdentity` convention.

### PIN: binding the entry to its target (target-bearing entries only)

For target-bearing entries (always required for `entryIdentity ∈ {0, 1}`; optional for `entryIdentity = 2`), each entry has at most one active PIN per attester per target schema:

- For UID targets: `PIN(definition=entry, refUID=targetUID, attester=curator)`
- For address targets: `PIN(definition=entry, recipient=address, attester=curator)`

Re-PINning supersedes O(1). For occurrence-derived and freeform entries, re-PINning to a different target is the *intended* affordance — the entry's identity is its name, not its current target binding. For target-derived entries, the canonical name → target invariant must hold (clients validate).

**Freeform entries without inner PIN.** When `entryIdentity = 2` and the entry IS the data (e.g., a grocery list item "milk"), the inner PIN is omitted entirely. The entry anchor's name carries the meaning; per-entry PROPERTYs (status, quantity, completedAt) carry mutable state. The reader returns `pinTargetID = bytes32(0)` for such entries — clients render them as "intrinsic" entries (no link follow-through).

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

### Anchor placements (typed list anchor + PIN to LIST)

Connecting a path to a LIST is a typed list anchor plus a PIN:

```
Anchor<schemaUID=LIST_SCHEMA_UID>("mylist", refUID=parent_anchor, attester=curator)
  └── PIN(definition=mylist_anchor, refUID=LIST_UID, targetSchema=LIST_SCHEMA_UID, attester=curator)
```

The typed anchor's `schemaUID = LIST_SCHEMA_UID` signals "this slot is a list" — readers see the slot type without probing. The PIN attaches the specific LIST attestation. Same shape as `Anchor<PROPERTY>` slots that hold property values.

PIN cardinality-1 per `(attester, definition, targetSchema)` means each curator can place exactly one LIST at a given typed list anchor. Re-PINning supersedes (the anchor now points at a different LIST; the previous LIST attestation still exists at its UID but is no longer attached at this path). Revoking the placement PIN removes the placement (the anchor's list slot is empty).

**The same LIST can be placed at multiple typed list anchors** by having multiple PINs from different anchors all referencing the same LIST UID. **Multi-attester sharing**: Bob can create his own typed list anchor (`Anchor<LIST>("alices-favs", refUID=bob_path)`) and PIN it to Alice's LIST UID; the LIST is still Alice's (entries are her attestations), but Bob's path renders it.

**Why typed anchors here?** A typed list anchor cannot accidentally hold a file or other primitive — readers see `schemaUID = LIST_SCHEMA_UID` and know what to expect. This eliminates the cross-`targetSchema` ambiguity round-13 introduced (where a generic anchor could have both a DATA PIN and a LIST PIN from the same attester at the same path slot, causing client divergence).

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
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — extends previous: for TAGs targeting anchors, additionally resolves the anchor's PIN target. **THE canonical list-entry reader** when called with `tagTargetSchema = ANCHOR_SCHEMA_UID`. `pinTargetID = bytes32(0)` is a valid result for freeform entries without inner PIN.
- `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool` — generic self-naming-anchor consistency check.

**Pagination cap (enforced):** `length` MUST be ≤ `MAX_LIST_PAGE_SIZE = 100`. Readers MUST revert with `PageSizeTooLarge()`.

### Placer vs curator: two scopes for two questions

A list read involves two distinct attester scopes (NEW emphasis in round-14, addressing Codex's API concern):

- **Placer** — who attests "this LIST is at this path"? This is the attester of the **placement PIN** at the typed list anchor. When Bob bookmarks Alice's list, Bob is the placer.
- **Curator** — who attests "these entries belong to this LIST"? This is the attester of the LIST attestation, the entries (`refUID = LIST_UID`), the weight TAGs, and the metadata PROPERTYs. When Bob bookmarks Alice's list, Alice is still the curator.

**By default**: when the placer reads "their" path, the curator defaults to the LIST attestation's `attester` field — the originator. This means Bob's bookmark of Alice's list naturally reads Alice's contents.

**SDK shape** reflects the split:

```typescript
// Step 1: anchor → LIST UID (uses placer scope)
listUID = efs.lists.resolveListPlacement(
  anchor: AnchorUID,
  placer: Address    // who attested the placement PIN
) → ListUID | null

// Step 2: LIST UID → entries (uses curator scope)
entries = efs.lists.readListByUID(
  listUID: ListUID,
  curator?: Address  // defaults to LIST attestation's attester
) → ListView

// Convenience wrapper for the common case:
view = efs.lists.read(
  anchor: AnchorUID,
  placer: Address,
  curator?: Address  // optional override; defaults to LIST creator
) → ListView
```

Smart contracts MAY call the underlying `EdgeResolver` view methods directly with the appropriate attester arguments. The on-chain readers don't bake in placer/curator semantics — they take an `attester` argument and clients decide what it means at each step.

### Canonical read recipe (single-curator scope, default)

For a typed list anchor at a path, placer `bob`, curator `alice` (where `alice` may equal `bob` in single-attester case):

```
1. Path-walk to the typed list anchor (mylist_anchor).
   - Verify anchor.schemaUID == LIST_SCHEMA_UID (signals "list slot").
   - If not, this isn't a list slot; render appropriate other primitive.

2. Resolve the LIST UID via the placer's PIN:
   listUID = EdgeResolver.getActivePinTarget(
     mylist_anchor,
     bob,                 // placer (whose PIN are we honoring at this path?)
     LIST_SCHEMA_UID
   )
   - If bytes32(0): the placer has no list at this path; render empty.

3. Determine the curator (default = LIST's own attester):
   listAttestation = eas.getAttestation(listUID)
   curator = curator_override ?? listAttestation.attester
   - Decode (entryIdentity, targetKind, targetSchema) from listAttestation.data.
   - LIST is revocable: false; no need to check revoked status.

4. Read list-level metadata (curator-scoped):
   title       = readPropertyAt(listUID, "title", curator)
   description = readPropertyAt(listUID, "description", curator)
   ...

5. Enumerate entries with weights (curator-scoped):
   entries = EdgeResolver.getActiveTagPinTargetsWithWeights(
     listUID,
     curator,             // who curated the entries?
     ANCHOR_SCHEMA_UID,   // entries are anchors
     start,
     length
   )
   - Returns (entryUID, tagUID, innerTargetID, innerTargetSchema, weight, attester)[]

6. For each entry:
   - If targetKind != 0 AND innerTargetID != bytes32(0):
       validate innerTargetSchema matches targetSchema.
   - If entryIdentity ∈ {0, 1} AND innerTargetID == bytes32(0):
       render warning (entry expected an inner PIN; got none).
   - If entryIdentity == 2 AND innerTargetID == bytes32(0):
       render as intrinsic entry (the anchor name IS the entry).

7. If entryIdentity == 0 (target-derived), validate name consistency:
   - For each entry: validateAnchorNameMatchesPinTarget(entryUID, curator).
   - On false: render warning OR suppress.

8. For per-entry metadata PROPERTYs (note, status, quantity, etc.):
   - Resolve named key anchor under entry; read PROPERTY value (curator-scoped).

9. Apply default total order:
   - Sort by weight desc, tie-break by entryUID asc, then tagUID asc.

10. Truncate to client-chosen displayLimit.
```

The recipe makes the placer/curator split explicit. For single-attester reads (Alice reads Alice's list at Alice's path), `placer == curator == alice` — the split is invisible. For shared/bookmarked lists, the split prevents reading Bob's empty bucket when the actual contents are Alice's.

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

- **Same list at multiple paths (single curator):** Alice creates LIST `L1`, then places it at typed list anchors at `/alice/memes/mylist/` AND `/alice/categorized/favs/`. Two paths, one list. Edits propagate.
- **Bob bookmarks Alice's list:** Bob creates `Anchor<LIST>("alices-favs", refUID=bob_path)` at `/bob/i-like/alices-favs/` and PINs Alice's `L1`. Bob is the placer; Alice is the curator. Reader uses placer/curator split: `read(anchor=alices-favs, placer=bob, curator=alice)`. Alice's edits show up in Bob's view. Bob can leave it as a read-only reference, or write his own entries against `L1` (becomes co-contributor; see below).
- **DAO-curated lists:** A Safe (smart account) is the LIST attester (curator). Members propose entry adds via Safe transactions. Other addresses bookmark the Safe-curated LIST UID in their own typed list anchors.

**Merge semantics** are not part of this design. Clients pick how to render multi-attester per use case. Default is single-curator-scoped; multi-attester is advisory and clients MUST preserve attribution.

### Why co-contribution is safe (and why we keep it)

Anyone can write entries with `refUID = L1` from any address. The kernel doesn't gate this. Some of those writers are legitimate co-contributors (Bob adding his picks to a shared DAO list); some could be spammers (Mallory writing 1000 entries to grief Alice's list).

**Editions handle this at read time.** Every active-set storage slot is keyed by attester. Default reads scope to a single curator (the LIST's `attester` field by default), so:

- Reader of "Alice's L1" → curator=alice → sees Alice's 5 entries. Mallory invisible.
- Reader of "Bob's contributions to L1" → curator=bob → sees Bob's 3 entries.
- Multi-attester compare/merge UI → reads `[alice, bob, ...]` → labels each entry by attester. Mallory not in the explicit attester list → not surfaced.

Mallory's spam writes are visible only to clients that explicitly ask for "all attesters" — which is itself a deliberate UX choice, not a default. The kernel cannot prevent the writes, and shouldn't; that's edition sovereignty: viewers choose what they read.

**Secondary effects** (the concerns reviewers raised):
- A subgraph indexing "every attestation against L1" sees Mallory's spam permanently (append-only discovery indexes can't be cleaned). Mitigation: subgraph implementers MUST scope active-set queries to a curator, not aggregate across all attesters.
- A naive client that defaults to "show all" would surface spam. Mitigation: SDK defaults to single-curator scope; clients deviating from the default opt in deliberately.

These are client/indexer-layer responsibilities, not kernel concerns. Co-contribution is a real affordance for shared/DAO lists; the alternative (gate writes via resolver) would block the legitimate use case to defend against an attack the read layer already filters.

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
| 14 | **Same list at multiple paths** | any | Multiple typed list anchors PIN to same LIST UID |
| 15 | **Bob bookmarks Alice's list** | any | Bob's typed list anchor PINs Alice's LIST UID |
| 16 | **Moving a list between folders** | any | Revoke old placement PIN; create new typed list anchor at new path |
| 16a | **DAO co-contribution to shared list** | any | Multiple attesters write entries against same LIST UID; viewer chooses scope |
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

### Removing a list from a path (revocable: false interaction)

Because LIST is `revocable: false`, "deleting" a list at a path is done by **revoking the placement PIN**, not the LIST attestation:

1. To remove the list at one path: revoke the typed list anchor's placement PIN.
2. To remove the list everywhere the curator placed it: revoke each placement PIN one by one.
3. The LIST attestation itself stays at its UID forever. If Bob bookmarked it, Bob's bookmark PIN is still valid; Bob's view still renders Alice's list (the entries Alice authored stay valid until Alice individually revokes them).

If a curator wants the list to genuinely "disappear" from all viewers, they must:
- Revoke their own placement PINs at all anchors.
- Revoke the entry TAGs (so even direct LIST-UID readers see an empty bucket).
- Bookmarks from other attesters cannot be force-removed; the bookmarker controls their own anchor.

**The list cannot be "fully deleted."** This is intentional and matches DATA's permanence. Curators creating lists SHOULD treat them as durable — putting people on a list is a public, permanent claim modulo revocation of individual entry edges.

### Entry-anchor squatting (`entryIdentity = 0` only)

For target-derived entries, the entry name encodes the target. A buggy or malicious attester can create an entry anchor named `0xBob…` but PIN it to a totally different target.

Clients MUST validate via `EdgeResolver.validateAnchorNameMatchesPinTarget(entryAnchor, attester)`. Mismatch → render warning OR suppress; never silently treat as valid.

For `entryIdentity = 1` and `entryIdentity = 2`, name validation does NOT apply.

### `clientNonce` convention is unenforceable at the kernel

Sequential nonces and CSPRNG output produce identical-looking `keccak256` hashes. The kernel cannot distinguish.

Smart contracts consuming `entryIdentity = 1` lists SHOULD treat the entry's UID and the curator's TAG attestation as the trust unit — NOT the entry name pattern.

### Attribution confusion in shared / bookmarked lists

When Bob bookmarks Alice's LIST in his namespace, viewers walking Bob's path see Alice's list. Apps MUST clearly label the **curator** (Alice — whose contents are these?), not just the **placer** (Bob — whose path are we on?). The `read(anchor, placer, curator)` API makes this distinction explicit; UI MUST surface it.

If Bob is also a co-contributor (writing his own TAGs/PINs against Alice's LIST UID), the multi-attester rendering MUST distinguish "Alice's entry weighted N" from "Bob's entry weighted M." Default single-curator scope simplifies the common case (rendering shows only one curator's contributions); apps offering compare/merge UI must preserve attribution explicitly.

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

**Free-floating LIST events.** A LIST attestation arrives as an EAS event without anchor context (no `refUID`). Indexers track LISTs by UID. Path discovery requires correlating LIST UIDs with placement PINs that target them.

**Typed list anchor events.** A typed list anchor arrives as an Anchor attestation with `schemaUID = LIST_SCHEMA_UID`. Indexers detect "this anchor is a list slot" by matching the anchor's `schemaUID`. Path-walking code that knows about lists can short-circuit at the typed anchor and switch to list-resolution mode.

**Placement PIN events.** Indexers detect "list placed at this list slot" via PIN events with `targetSchema = LIST_SCHEMA_UID`. Track these to maintain placement → LIST UID associations. The placement PIN's attester is the **placer**; the LIST attestation's attester is the **curator**. They may differ (Bob bookmarks Alice's list).

**Active state vs historical state.** `_activeByAAS` reflects current active TAGs (post-revocation). Track revocation events and apply swap-and-pop semantics (per ADR-0007).

**TAG supersession via re-attest at same edgeHash** (per ADR-0041 §4). Re-attesting a TAG updates the active entry's UID and weight in place, **without emitting a `Revoked` event for the prior TAG**. Indexers MUST detect this:
- Compute `edgeHash = (attester, targetID, definition, schema)`.
- If a prior TAG with same `edgeHash` exists in active set, treat as superseded — replace, don't double-count.

**PIN supersession is slot-based, not edgeHash-based.** Re-attesting a PIN at slot `(definition, attester, targetSchema)` supersedes the prior — **even when the target changes**. Placement PINs follow this rule: if a curator changes which LIST is placed at a typed list anchor, the slot supersedes (no `Revoked` event for the old PIN). Note the cardinality is per-`targetSchema`, but typed list anchors only accept `LIST_SCHEMA_UID` PINs in practice (the anchor's schemaUID signals intent).

**LIST attestations are permanent.** `revocable: false`. Indexers do not need to track revocation events for LIST attestations themselves. Lifecycle changes happen at the placement-PIN layer (revoked) and entry/TAG layer (revoked or superseded).

**Discovery indexes vs active state.** `_targetsByDef`, `_edgeDefinitions`, etc. are append-only discovery indexes including historical entries; NOT ground truth for current active state. Cross-reference active-set storage. **Important for spam-resistance**: when querying "entries against LIST_UID," subgraphs MUST scope to a specific curator (`_activeByAAS[LIST_UID][curator]`), not aggregate across all attesters — else co-contribution surface area becomes spam exposure.

**Reverse-lookup support.** `getEdgeDefinitions(LIST_UID)` returns all definitions (anchors) that have this LIST UID as a PIN target — useful for "show all paths where this list appears" queries. Filter to typed list anchors (`anchor.schemaUID == LIST_SCHEMA_UID`) to get just placement anchors.

**Orphan LIST tracking.** A LIST attestation with no placement PINs is path-unreachable but exists in EAS forever. Indexers SHOULD index orphan LISTs separately (e.g., by creator) for "lists I created but haven't placed yet" UX. Absence of placement is NOT proof of deletion.

---

## Conventions vs enforcement — long-tail risk

This design relies on convention enforcement for invariants the kernel cannot validate: `clientNonce` CSPRNG entropy, target-derived entry name consistency, indexer scoping discipline.

Revisit triggers fire if convention compliance drops below tolerance post-launch:

- **Target-derived entry name mismatches exceed measurable share** → ship enforcement via custom resolver on entry anchors.
- **Squatting-pattern signals appear post-launch** → ship kernel-side nonce-entropy or rate-limit resolver.
- **Co-contribution spam surfaces in client UIs because subgraphs aggregate across attesters** → publish a reference subgraph schema enforcing curator-scoped active-set queries; consider kernel-side discovery-index pagination caps.
- **Cross-client divergence on read recipes** → ship a canonical reference SDK as the de facto interpreter.

These are operational triggers; they represent conditions under which "convention only" becomes load-bearing tech debt.

---

## Decisions resolved (round-14 updated)

1. **LIST attestations are free-floating.** Like DATA. They have their own UID and exist independently of any anchor. **`revocable: false`** — the LIST UID is permanent at its UID; deletion happens at the placement-PIN layer, not the LIST itself.
2. **Path placement is a typed list anchor + PIN.** `Anchor<schemaUID=LIST_SCHEMA_UID>` declares "this slot holds a list"; the PIN attaches the specific LIST UID. Same shape as `Anchor<PROPERTY>` slots that hold property values.
3. **Same LIST can be placed at multiple typed list anchors.** Multiple PINs from different list anchors all reference the same LIST UID. Editing the LIST updates all views.
4. **Cross-attester sharing and contribution work natively.** Bob can create his own typed list anchor and PIN to Alice's LIST UID (read-only "bookmark"); Bob can also write entries/weights against Alice's LIST UID (becomes co-contributor). **Editions handle spam-resistance at read time** — no kernel-side write gating needed.
5. **List-level metadata attaches to the LIST attestation**, not the path anchor. Title, description, cover, etc. live as PROPERTY slots under the LIST UID. Metadata travels with the LIST — bookmarkers see it automatically.
6. **Singleton-per-list-anchor is enforced by PIN cardinality** (`(attester, list_anchor, LIST_SCHEMA)`), not a custom resolver. The typed list anchor's own schemaUID prevents cross-`targetSchema` collisions.
7. **Lists are NOT folders.** Anchors are containers; lists, folders, files, and tags are separate things that can coexist inside anchors. Each kind has its own typed name anchor (lists: `Anchor<LIST>`; properties: `Anchor<PROPERTY>`; files use generic anchors today).
8. **Membership patterns use TAGs**, not lists. Allowlists, blocklists, follow graphs, DAO membership, categorization, permissions — all are tagging patterns.
9. **`isActiveEdge` is the membership primitive** for tag patterns.
10. **Target-bearing entries always have inner PIN; freeform entries optional.** For `entryIdentity ∈ {0, 1}` the inner PIN is required. For `entryIdentity = 2` (freeform), the inner PIN is optional — the entry anchor IS the entry when no PIN is present.
11. **LIST schema (NEW EAS schema, `revocable: false`, no required resolver).** Field set: `(uint8 entryIdentity, uint8 targetKind, bytes32 targetSchema)`. Three values for `entryIdentity` (target/occurrence/freeform). Optional `ListSchemaResolver` may validate enum ranges.
12. **Smart contracts read directly via three new `EdgeResolver` view methods** (carried from rounds 7/8). Generic graph-composition names.
13. **Reader API splits placer from curator scope.** `resolveListPlacement(anchor, placer) → listUID`; `readListByUID(listUID, curator)`; convenience `read(anchor, placer, curator?)` with curator defaulting to the LIST attestation's `attester`.
14. **Single-curator-scoped reads as default.** Multi-attester is opt-in. Subgraphs MUST scope active-set queries to a curator (anti-spam invariant).
15. **Default ordering: `weight desc`, tie-break by entry-UID asc, then `tagUID` asc.**
16. **Sparse `int256` weights are an SDK SHOULD for manual ordering**, NOT a universal MUST.
17. **Page cap MUST = 100**, enforced via `PageSizeTooLarge()` revert.
18. **`clientNonce` ≥128 bits CSPRNG** — convention only; kernel cannot enforce.
19. **Snapshot consistency MUST**: smart contracts get atomicity; off-chain pin `blockTag`; governance reads finalized.
20. **Convention-violating lists are accepted v1 risk** with named revisit triggers.
21. **Shopping lists, todos, stateful per-entry items are core supported use cases** via `entryIdentity = 2` + per-entry PROPERTYs (with optional inner PIN).
22. **`specs/06` rewrite required before dev** writes list data. `specs/08` superseded.
23. **`specs/02` and `specs/03` SHOULD note the lists-vs-tags distinction** explicitly.
24. **Round-14 use cases**: same-list-multiple-paths, list-bookmarking-across-attesters, moving-a-list-between-folders, DAO co-contribution. All naturally enabled by typed-anchor + free-floating LIST model.
25. **List "deletion" semantics**: revoke placement PINs to remove from path; LIST attestation itself is permanent. Curators wanting full disappearance must revoke entry TAGs too. Bookmarks from other curators cannot be force-removed.

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
- **`ListSchemaResolver` enum-range validation** — optional v1 soft check; not strictly required since clients reject unknown values per advisory rule.
- **Kernel-side nonce-entropy resolver** — long-tail-risk-trigger response.
- **Free-floating folders** (Gemini's "fourth frame" suggestion — placement portability for folders via PIN) — defer to v2; folder hierarchy via `refUID` ownership is fine for v1.

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
   - `revocable: false`
   - `resolver: 0x0` (no required resolver) OR optional `ListSchemaResolver` for enum-range validation
   - Registered in deploy script.

2. **`EdgeResolver` extensions** — three view methods (carried from rounds 7/8):
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length)`
   - `validateAnchorNameMatchesPinTarget(anchorUID, attester) → bool`
   All revert with `PageSizeTooLarge()` on `length > 100`.

3. **Reserved-key anchor names** — entry-level: `note`, `status`, `quantity`, `completedAt`. List-level (on LIST attestation): `title`, `description`, `cover`, `icon`, `category`.

4. **SDK helpers:**
   - `efs.lists.create(opts) → listUID` — creates free-floating LIST attestation
   - `efs.lists.placeAt(listUID, parentAnchor, name) → {anchorUID, pinUID}` — creates typed list anchor + placement PIN
   - `efs.lists.unplaceFrom(listAnchor)` — revokes placement PIN at typed list anchor
   - `efs.lists.bookmarkAtMyPath(listUID, parentAnchor, name)` — Bob creates typed list anchor + PIN to Alice's LIST UID
   - `efs.lists.addEntry(listUID, target | name, opts)` — creates entry anchor + (optional) PIN + weight TAG
   - `efs.lists.setEntryMetadata(entryAnchor, key, value)` — per-entry PROPERTY
   - `efs.lists.setListMetadata(listUID, key, value)` — list-level PROPERTY (title, description, etc.)
   - `efs.lists.resolveListPlacement(anchor, placer) → listUID | null`
   - `efs.lists.readListByUID(listUID, curator?, opts) → ListView`
   - `efs.lists.read(anchor, placer, curator?, opts) → ListView` — convenience wrapper combining placement resolution + curator-scoped read
   - `canonicalEntryAnchorName(targetID, schemaUID, identityKind) → string`
   - `cryptoRandomNonce() → bytes32`

5. **Frontend list-renderer** in `packages/nextjs/` debug UI.

6. **Spec rewrite:** `specs/06` describes round-14 typed-anchor + free-floating LIST model; `specs/08` marked superseded.

7. **Doc note in `specs/02` and `specs/03`** clarifying lists-vs-tags distinction and list-level metadata location.

8. **Optional demo seed:** one LIST + one typed list anchor placement + a freeform-entry shopping-list demo.

**Required pre-launch tests (conformance matrix):**

| # | Category | Test |
|---|---|---|
| 1 | LIST creation | Create free-floating LIST attestation; UID exists; `revocable: false` |
| 2 | LIST placement | Create `Anchor<LIST>` typed anchor + placement PIN; reader resolves via `getActivePinTarget(anchor, placer, LIST_SCHEMA_UID)` |
| 3 | LIST entries | Add 5 entries (`refUID = LIST UID`); read via `getActiveTagPinTargetsWithWeights(LIST_UID, curator, ANCHOR_SCHEMA_UID, ...)` |
| 4 | LIST | Reorder via re-attest weight TAG at same edgeHash |
| 5 | LIST | Revoke entry TAG; swap-and-pop semantics |
| 6 | LIST | Address-target entries via PIN `recipient` |
| 7 | LIST | Negative weight stays active (ADR-0042 doesn't apply) |
| 8 | LIST | Add `note` PROPERTY to entry; update via PIN re-attest |
| 9 | LIST | `validateAnchorNameMatchesPinTarget` passes/fails correctly |
| 10 | LIST | Multi-attester at shared entry anchor (target-derived) |
| 11 | LIST | Two distinct entries, same target (occurrence-derived) |
| 12 | LIST | Re-PIN occurrence-derived entry to different target |
| 13 | LIST | Freeform entry "milk" with no inner PIN; reader returns `pinTargetID = bytes32(0)`; `entryIdentity=2` clients render as intrinsic |
| 14 | LIST | Freeform entry with optional inner PIN; reader returns target |
| 15 | LIST | List-level `title` PROPERTY attaches to LIST attestation; bookmark resolves with same title |
| 16 | **Same LIST, two anchors** | Place LIST at typed list anchor A1; place same LIST at A2; both paths resolve to same LIST UID |
| 17 | **Bob bookmarks Alice's LIST** | Bob's typed list anchor PINs Alice's LIST UID; `read(anchor, placer=bob, curator=alice)` returns Alice's entries; `read(anchor, placer=bob)` defaults curator to LIST attester (alice) |
| 18 | **Move LIST between anchors** | Revoke placement PIN at A1; create new typed list anchor + PIN at A2; LIST follows |
| 19 | **List "deletion"** | Revoke placement PIN; LIST UID still readable via direct `readListByUID`; placement-based read returns null |
| 20 | **DAO co-contribution** | Multiple attesters write entries against same LIST UID; per-attester reads return only that attester's entries |
| 21 | Reader | Page-size cap revert at length=101 |
| 22 | LIST schema | `revocable: false` — revoke attempt fails or has no effect at the LIST level |
| 23 | Snapshot | Read at finalized block tag matches active state |
| 24 | Anchor names | Validator passes on 42-char address hex + 66-char UID hex |
| 25 | Adversarial | Squatter mismatch detected by validator |
| 26 | Indexer | TAG re-attest detected as supersession via edgeHash |
| 27 | Indexer | PIN re-attest at same slot detected as supersession (target may change) |
| 28 | Indexer | Reverse lookup `getEdgeDefinitions(LIST_UID)` returns all placement anchors |
| 29 | Tag patterns | Allowlist via TAG + isActiveEdge works (no list infrastructure) |
| 30 | Cross-targetSchema | Typed list anchor's schemaUID prevents file-PIN collision (anchor's own type signals intent) |

**NatSpec requirements** (carried from earlier rounds): document address-target encoding, `pinTargetID = bytes32(0)` semantics, occurrence-derived trust model, validation scope, placer-vs-curator semantics.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, plus independent validation passes from Gemini and a fresh Claude instance, mediated by James Carnley. Fourteen rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md). Round 13 adopted the free-floating LIST model (parallel to how files work in EFS), enabling same-list-at-multiple-paths and cross-attester sharing. Round 14 unified that with typed list anchors (parallel to PROPERTY slots), set `revocable: false` to match DATA's permanence, defined list-level metadata location, made freeform entries' inner PIN optional, and split the reader API into placer/curator scopes.
