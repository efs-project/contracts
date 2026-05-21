# EFS Lists — Design

**Status:** Draft (round 15 — schema simplification + principled editions stance + extracted ADRs)
**Date:** 2026-05-20
**Permanence-tier:** Etched-adjacent (introduces one new EAS schema; the data model is permanent post-1.0)
**Authors:** Claude Sonnet 4.7 (cross-agent brainstorming across 14 prior rounds with Codex GPT-5, Gemini 2.5 Pro, and a fresh Claude review pass) + James Carnley (architectural direction; final-frame decisions)
**Related:** ADR-0007, ADR-0025, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07, specs/08
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history, parked ideas, fifteen rounds of refinement
**Sibling ADRs being drafted in parallel** (governance, not list-specific):
- PIN-trust-extension — system-wide invariant about how lens/editions interact with PIN-following
- Per-schema namespace + UX-layer cross-schema view + type-qualified URL syntax

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
  ├── sorted           = true/false
  ├── allowsDuplicates = true/false
  ├── targetType       = ANY / ADDR / SCHEMA
  └── targetSchema     = bytes32

  List-level metadata (name, description, cover, etc.) attaches to L1 via PROPERTY slots:
    Anchor<PROPERTY>(name="name", refUID=L1)          ← ADR-0034 display-name PROPERTY
      └── PIN(refUID=nameValuePropertyUID)

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

## What changed in round 15

Round 15 keeps round-14's structural shape (it survived four rounds of adversarial reframe stress-testing) but simplifies the schema, takes a principled stance on co-contribution, drops kernel paternalism on page-size, and extracts two cross-cutting concerns to their own ADRs.

### Schema field changes

| Round-14 | Round-15 |
|---|---|
| `uint8 entryIdentity` (3 enum values) | dropped — entry naming is a client convention, not a kernel concern |
| `uint8 targetKind` (5 effective values) | `uint8 targetType` (3 values: ANY / ADDR / SCHEMA) |
| `bytes32 targetSchema` | unchanged |
| `revocable: true` | `revocable: false` (matches DATA) |
| — | `bool allowsDuplicates` (NEW — explicit, replaces inference from `entryIdentity`) |
| optional resolver | mandatory `ListResolver` (field-validation only) |

Final shape:

```solidity
LIST schema:
  bool    allowsDuplicates   // false = set semantics; true = playlist semantics
  uint8   targetType         // 0=ANY, 1=ADDR, 2=SCHEMA
  bytes32 targetSchema       // schema UID when targetType=SCHEMA, else bytes32(0)
revocable: false
resolver: ListResolver       // validates field ranges + (targetType, targetSchema) coherence
```

### Principled stance changes

**Editions ARE the access control.** The kernel does not gate writes at any layer. Anyone can attest entries against any LIST UID. Spam-resistance happens at the viewer layer through edition-scoped reads. The doc previously framed this as "we keep co-contribution"; round-15 frames it as "the kernel does not have a concept of write-gating, ever." Future agents (and reviewers) reading this should understand that `coContributionPolicy`-style fields are a category error in EFS — the model doesn't have a slot for them.

**Page-size is not enforced.** Round-14's `MAX_LIST_PAGE_SIZE = 100` + `PageSizeTooLarge` revert was paternalism. View reads are billed to the caller (memory expansion is quadratic-priced; callers hit their own gas ceiling before causing harm). RPC providers handle their own timeouts and connection budgets. **Round-15: no kernel cap.** SDK default `length = 100` as a sensible hint; callers may pass any value.

**Naming is a client convention.** Target-derived hex names, occurrence-derived nonce names, freeform names — all are client patterns above the kernel. The kernel just enforces `(parent, name, schemaUID)` uniqueness per ADR-0025. The round-14 `validateAnchorNameMatchesPinTarget` reader is dropped — clients that want to validate name-content consistency can do so themselves.

### Extracted ADRs

Two concerns surfaced in earlier rounds were broader than lists. Pulled out:

- **PIN-trust-extension.** When a reader follows a PIN from attester A's anchor to attester B's target attestation, lens trust extends to B for that subtree. Applies to files, lists, properties — anywhere PIN-following crosses attester boundaries. Deserves its own ADR; round-15 just references it.

- **Per-schema namespace + URL syntax.** Anchors with different `schemaUID`s at the same parent + name coexist (kernel-level), but the file browser UX presents a unified-by-default view with cross-schema awareness. URL syntax disambiguates type. DNS precedent: `dig MX example.com` vs `dig A example.com`. Separate ADR governs the syntax (`/foo` vs `/foo[]` vs `/foo{}` vs `/foo<schemaUID>`).

### What the side-thread stress-tested and rejected

Each was a real reframe candidate. Each lost on merits. Recording so future agents don't re-litigate:

- **Dissolving LIST attestation** (typed anchor IS the list): LIST attestation gives stable identity separate from path placement, mirroring DATA. Kept.
- **Pure-TAG entries** (1 attestation per entry, weight on TAG, no entry anchor): metadata fragility on weight updates is unacceptable. A TAG re-attest with new weight orphans per-entry metadata that referenced the prior TAG UID. Catastrophic for annotated lists. Rejected.
- **TAG + listIndex PROPERTY** (move weight off TAG, kernel change to ADR-0041): phantom advantage. PROPERTYs cost 3 attestations each, heavier than round-14, not lighter. Rejected.
- **Shared `_entries/` container for cross-list reuse:** the reusable thing is the canonical target (`/food/apple/`), not the per-list entry anchor. List-context notes ARE per-list and should not be shared. Rejected.
- **Free-floating folders** (Gemini's fourth-frame): out of scope for v1. Folder hierarchy stays `refUID`-bound.
- **One-enum schema field instead of discrete fields:** discrete fields are more self-documenting. Enums require lookup tables to interpret.
- **`coContributionPolicy` field:** category error per principled stance above. Editions are the access control; the kernel has no write-gating concept.
- **Mandatory curator-write-gate resolver:** same reasoning.
- **Ownership transfer mechanism:** accept non-transferability. Old curator stays in editions chain forever.

### "Drill-into collections" mental model

A unifying frame for the spec rewrite: lists, folders, and any future browse-into container types are siblings in the user's mental model. The kernel-level distinction (folder = anchor with child anchors; list = anchor PINed to LIST attestation with TAG-ordered entries) is implementation detail. UX treats them as "things you click into to see what's inside."

This is round-15's most clarifying framing improvement. The file browser doesn't need separate "folder mode" and "list mode" — both are containers; the difference is presentation (unordered tree vs ordered + scored entries with metadata).

### Frame-history recap

Five frame-level refinements across fifteen rounds:
- Round 11: lists are folders (overshoot; unification didn't match the graph model)
- Round 12: lists are NOT folders; membership is tags (separates the patterns)
- Round 13: free-floating LIST attestation, placed via PIN (file-like portability)
- Round 14: typed list anchors (parallel to PROPERTY slots) + free-floating LIST + revocable=false + freeform-no-PIN + placer/curator split
- Round 15: schema simplification + principled editions stance + drop kernel paternalism + extract cross-cutting ADRs + "drill-into collections" mental model

The pattern across all five: agents converge inside a frame; humans question the frame. Round-15's reframes were caught primarily through a side-thread that explicitly stress-tested round-14 against alternatives. Future agents proposing a sixth frame-level refinement should expect a higher bar — but should not silently assume the design space is exhausted.

---

## Why this matters

EFS is a graph-database substrate. The graph kernel (Anchors, PINs, TAGs) supports many overlay patterns. Each pattern should do one thing well; they coexist in the graph.

EFS's existing design separates content from placement: DATA (free-floating content) + Anchor (path) + PIN (placement). This is what makes content portable — you can place the same DATA at multiple paths, share it via cross-attester PINs, and edit content without changing path identity. Lists adopt the same pattern in round-13.

Smart contracts read these structures directly. The data layer + public reader APIs MUST be sufficient on their own; the design cannot rely on SDK enforcement of invariants.

---

## The list primitive

A list has three layers, mirroring the file model:

1. **A LIST attestation** (free-floating; no `refUID` required) — the canonical list. Carries the configuration: whether the list is sorted on-chain, whether duplicates are allowed, what types of items entries point at. Has its own UID. List-level metadata (`name`, `description`, `cover`) attaches to the LIST attestation as PROPERTYs.

2. **Entry anchors and their content** — children of the LIST UID (`refUID = LIST UID`). Target-bearing entries PIN to their target item; freeform entries skip the inner PIN (the anchor IS the entry). Weight TAGs against the LIST UID provide ordering. PROPERTYs on the entry carry per-entry metadata.

3. **One or more typed list anchor placements** — `Anchor<schemaUID=LIST_SCHEMA_UID>` at paths, each with a PIN to the LIST UID. The typed anchor names the list at a path AND signals "this slot is a list"; the PIN binds the anchor to the list. The same LIST can have multiple placements.

### Concrete example

**Example A — Top 10 memes** (typed-schema target, set semantics, sorted):

```
/alice.eth/                                          (Anchor<generic> — Alice's identity)
  └── memes/                                         (Anchor<generic> — a folder)
        └── top10/                                   (Anchor<schemaUID=LIST_SCHEMA_UID>
                                                      — typed list slot, refUID=memes)
              └── PIN(definition=top10_anchor,
                      refUID=L1,
                      targetSchema=LIST_SCHEMA_UID,
                      attester=alice)                ← places list L1 at this path

LIST attestation L1                                  (free-floating; UID=L1; revocable: false)
  sorted           = true                            ← SDK auto-creates SORT_INFO
  allowsDuplicates = false                           ← set semantics
  targetType       = 2 (SCHEMA)
  targetSchema     = DATA_SCHEMA_UID

  SORT_INFO(parentAnchor=L1, sortFunc=WeightSort, attester=alice)
                                                     ← created by SDK alongside the LIST

  List-level metadata (travels with L1, not the path anchor):
    Anchor<PROPERTY>(name="name", refUID=L1)
      └── PIN(refUID=nameProp_attestation_uid)       ← name = "Alice's Top 10 Memes"
    Anchor<PROPERTY>(name="description", refUID=L1)
      └── PIN(refUID=descProp_attestation_uid)

  Entry anchor "0xMemeAHash..."  (Anchor<generic>, refUID=L1, target-derived name)
    ├── PIN(definition=entry, refUID=memeA_DATA, attester=alice)
    └── TAG(definition=L1, refUID=entry, weight=100, attester=alice)

  Entry anchor "0xMemeBHash..."  (Anchor<generic>, refUID=L1)
    ├── PIN(definition=entry, refUID=memeB_DATA, attester=alice)
    └── TAG(definition=L1, refUID=entry, weight=90, attester=alice)
```

Path resolution: `web3://...alice.eth/memes/top10/` walks anchors to `top10`. The reader sees `top10`'s schemaUID = `LIST_SCHEMA_UID` and knows this is a list slot. Reading its PIN with `targetSchema = LIST_SCHEMA_UID` returns the LIST UID. Reading the LIST attestation gives the configuration; `sorted=true` directs ranked reads via `EFSSortOverlay.getSortedChunk(L1's SORT_INFO, ...)`.

**Example B — Grocery list** (freeform, no inner PINs, unsorted):

```
/alice.eth/groceries/                                (Anchor<schemaUID=LIST_SCHEMA_UID>)
  └── PIN(refUID=L2, targetSchema=LIST_SCHEMA_UID, attester=alice)

LIST attestation L2
  sorted           = false                           ← no SortOverlay
  allowsDuplicates = false
  targetType       = 0 (ANY)
  targetSchema     = bytes32(0)

  Anchor<PROPERTY>(name="name", refUID=L2)
    └── PIN(refUID="Groceries" property)

  Entry anchor "milk"  (refUID=L2, freeform name; NO inner PIN — the anchor IS the entry)
    ├── Anchor<PROPERTY>(name="status",   refUID=milk_entry) → PIN to "to-buy"
    └── Anchor<PROPERTY>(name="quantity", refUID=milk_entry) → PIN to "2 gal"
  Entry anchor "eggs"  (refUID=L2)
    └── Anchor<PROPERTY>(name="status",   refUID=eggs_entry) → PIN to "to-buy"
  Entry anchor "bread" (refUID=L2)
    └── Anchor<PROPERTY>(name="status",   refUID=bread_entry) → PIN to "bought"

  TAG(definition=L2, refUID=milk_entry,  weight=1, attester=alice)
  TAG(definition=L2, refUID=eggs_entry,  weight=2, attester=alice)
  TAG(definition=L2, refUID=bread_entry, weight=3, attester=alice)
```

**Example C — Music playlist with repeats** (allowsDuplicates, occurrence-derived names, sorted):

```
/alice.eth/playlist/                                 (Anchor<schemaUID=LIST_SCHEMA_UID>)
  └── PIN(refUID=L3, targetSchema=LIST_SCHEMA_UID, attester=alice)

LIST attestation L3
  sorted           = true
  allowsDuplicates = true                            ← enables Waterfalls × 3
  targetType       = 2 (SCHEMA)
  targetSchema     = DATA_SCHEMA_UID

  Entry anchors (names use occurrence-derived hex — each unique even when target repeats):
    Anchor("0x91a2c...{nonce1}", refUID=L3) → PIN(refUID=tlc_waterfalls_DATA)  ← #1
    Anchor("0x4f8e3...{nonce2}", refUID=L3) → PIN(refUID=mariah_vision_DATA)
    Anchor("0x2cb7a...{nonce3}", refUID=L3) → PIN(refUID=tlc_waterfalls_DATA)  ← #2
    Anchor("0x9de1f...{nonce4}", refUID=L3) → PIN(refUID=adele_someone_DATA)
    Anchor("0x5ab38...{nonce5}", refUID=L3) → PIN(refUID=tlc_waterfalls_DATA)  ← #3

  TAGs assign track order (weight=1,2,3,4,5).
```

Entry names are `keccak256("efs:list-occurrence:v1", L3_UID, alice_addr, clientNonce)` rendered as 66-char `0x` + 64 hex. Different nonces → distinct anchor names → no namespace collision even though three of them PIN to the same `tlc_waterfalls_DATA` UID.

### LIST schema (NEW — Etched commitment)

```solidity
LIST schema:
  bool    sorted             // true (default) = maintains SortOverlay-backed sorted index;
                             //   false = unsorted active-entry set
  bool    allowsDuplicates   // false = set semantics; true = playlist/duplicates allowed
  uint8   targetType         // 0 = ANY, 1 = ADDR, 2 = SCHEMA
  bytes32 targetSchema       // EAS schema UID when targetType=SCHEMA; else bytes32(0)
revocable: false
resolver: ListResolver       // mandatory; validates field ranges + coherence at attest time
```

Field semantics:

- **`sorted`** declares whether the curator maintains a SortOverlay-backed sorted index for this list.
  - `true` (SDK default) — at LIST creation, SDK additionally attests `SORT_INFO(parentAnchor=LIST_UID, sortFunc=WeightSort)` so entries are kept ordered by `weight desc` via SortOverlay. Smart contracts read via `EFSSortOverlay.getSortedChunk(...)` for globally-ranked top-N. Cost: ~5.5k gas per `repositionItem` on weight change (handled by SDK on the curator's behalf).
  - `false` — no SortOverlay index. Entries are read as an unsorted active-entry set via `EdgeResolver.getActiveTagPinTargetsWithWeights(...)`; clients sort client-side. Use for small lists, freeform lists where order doesn't matter, or write-heavy lists where the per-update overhead isn't worth it.
  
  The field is a **read-path declaration**, not a write-gate. The curator declares intent; readers honor it. Changing the sort discipline post-creation requires publishing a new LIST at a fresh UID (per `revocable: false` permanence).

- **`allowsDuplicates`** declares whether the list permits multiple entries that PIN to the same target.
  - `false` — set semantics. Two entries can't PIN to the same target from the same curator. Use for top-N favorites, allowlists, ranked picks. Clients SHOULD name entries with target-derived hex for natural deduplication (target → unique anchor name).
  - `true` — playlist semantics. Multiple entries can PIN to the same target. Use for playlists with repeats, ranked ballots, syllabi. Clients SHOULD name entries with nonce-derived hex (`keccak256(abi.encode("efs:list-occurrence:v1", listUID, attester, clientNonce))`) so identical targets get distinct anchor names. `clientNonce` MUST be ≥128 bits CSPRNG entropy (convention, unenforceable at kernel).

- **`targetType`** declares what each entry's optional inner PIN binds to:
  - `0` (ANY) — entries may PIN any UID type or skip the inner PIN entirely. Use for heterogeneous lists or freeform lists (shopping lists, todos) where the entry IS the data.
  - `1` (ADDR) — entries' inner PIN uses `recipient` for an Ethereum address. Use for address-typed lists (top friends, DAO delegates, follow graph as ordered list).
  - `2` (SCHEMA) — entries' inner PIN refUID points to an attestation of `targetSchema`. Use for typed lists (top-N memes pointing to DATA, curated NFT collections pointing to a specific schema).

- **`targetSchema`** is the EAS schema UID required for entry inner PINs when `targetType = SCHEMA`. Must equal `bytes32(0)` when `targetType ≠ SCHEMA`.

**Entry naming is a client convention, not a kernel concern.** The kernel enforces `(parent, name, schemaUID)` uniqueness per ADR-0025. Target-derived, occurrence-derived, and freeform naming patterns are all client choices. Different clients reading the same list MAY disagree about whether names are valid; this is acceptable because reads are edition-scoped and the curator's own choices define their list.

**`revocable: false`**: a LIST attestation is permanent at its UID, like DATA. There is no "revoke the LIST" operation. To remove a list from a path, revoke the typed list anchor's placement PIN — the LIST attestation stays at its UID (still readable; if it was placed at other anchors, it's still reachable there). To deprecate a list entirely, revoke all its placement PINs and entry TAGs. Bookmark PINs from other curators' anchors stay valid as long as the bookmarker doesn't revoke them. Curator key-compromise note: `revocable: false` protects UID resolution but does not protect contents — a compromised curator key can revoke entry TAGs and metadata PINs from the curator's own slot. Recovery requires the curator to publish a new LIST at a fresh UID and re-PIN their typed list anchors to it; bookmarkers choose whether to re-bookmark.

**`ListResolver` (mandatory).** Validates at attest time:
- `targetType ≤ 2`
- If `targetType == SCHEMA`: `targetSchema != bytes32(0)`
- If `targetType != SCHEMA`: `targetSchema == bytes32(0)`
- `refUID == bytes32(0)` (LIST attestations are free-floating)
- No expiration unless explicitly supported in a future field
- `recipient == address(0)` (LIST attestations are not directed at a recipient)

Field-validation only for v1. No SortOverlay hooks until SortOverlay integration is wired (see Reader API §"Ordered reads via SortOverlay (opt-in)"). The resolver does NOT gate writes by attester — anyone may attest a LIST. Co-contribution + spam-resistance is handled by viewer-side edition scoping, not by kernel write-gating.

### List-level metadata

List-level metadata (`name`, `description`, cover, etc.) attaches to the **LIST attestation**, not the path anchor. Metadata travels with the LIST UID — when Bob bookmarks Alice's LIST at his path, Bob's view sees Alice's name automatically.

The pattern follows ADR-0034/ADR-0041 PROPERTY conventions:

```
LIST attestation L1
  └── Anchor<schemaUID=PROPERTY_SCHEMA_UID>(name="name", refUID=L1)
        └── PIN(definition=nameAnchor, refUID=nameValue_PROPERTY_UID, attester=alice)
```

**Reserved key anchor names for list-level metadata** (apps SHOULD NOT shadow):
- `name` — display name per ADR-0034
- `description` — longer description
- `cover` — DATA UID for cover image
- `icon` — DATA UID for small icon
- `category` — string category label

Updating metadata: re-PIN at the same `(curator, key_anchor, PROPERTY_SCHEMA)` slot — O(1) supersede. Per-curator: each curator's metadata PINs are independent. Default reads scope to the LIST's attester (the curator).

### Entry anchors

Entries are children of the LIST UID (`refUID = LIST UID`). Each entry is a regular `Anchor<generic>` attestation. The entry's `schemaUID` field declares the inner target's schema (when an inner PIN is present):

- `targetType == SCHEMA`: entry's `schemaUID == targetSchema` (e.g., `DATA_SCHEMA_UID` for a books list).
- `targetType == ADDR`: entry's `schemaUID == bytes32(0)` (`ADDRESS_TARGET` sentinel); inner PIN uses `recipient` rather than `refUID`.
- `targetType == ANY`: entry's `schemaUID` declares per-entry; entries can be heterogeneous within one list, or skip the inner PIN entirely.
- Entry with no inner PIN: entry's `schemaUID == bytes32(0)`. The entry stands alone (intrinsic entry); the anchor name IS the entry.

Entry naming is a client convention (see "Identity convergence" section): target-derived, occurrence-derived, or freeform. The kernel just enforces `(parent, name, schemaUID)` uniqueness per ADR-0025.

### PIN: binding the entry to its target (optional)

When an entry has an inner PIN, it has at most one active PIN per attester per target schema:

- For UID targets: `PIN(definition=entry, refUID=targetUID, attester=curator)`
- For address targets: `PIN(definition=entry, recipient=address, attester=curator)`

Re-PINning supersedes O(1). For occurrence-derived and freeform entries, re-PINning to a different target is the *intended* affordance — the entry's identity is its name, not its current target binding. For target-derived entries, the canonical name → target invariant is a client convention; clients that care should validate themselves.

**Intrinsic entries without inner PIN.** When the entry IS the data (e.g., a grocery list item "milk", a todo task description), the inner PIN is omitted entirely. The entry anchor's name carries the meaning; per-entry PROPERTYs (`status`, `quantity`, `completedAt`) carry mutable state. The reader returns `pinTargetID = bytes32(0)` for such entries — clients render them as intrinsic entries (no link follow-through). Most common with `targetType=ANY`, but legal for any `targetType` if the curator chooses.

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

**Reserved generic PROPERTY keys**: `note`, `name`, `description`, `icon`, `cover`, `status`, `quantity`, `completedAt`. Apps SHOULD NOT shadow these with conflicting semantics. Other PROPERTY keys are app-defined. Use `name` (per ADR-0034) for the display-name PROPERTY at both list level and entry level.

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
| Sequence with duplicates (playlists, ballots) | **List** with `allowsDuplicates=true` (client uses occurrence-derived names). |
| Folder of files | **Anchor + child anchors with PINs to DATA** (existing EFS folder pattern). No list. |
| Categorization (`#nsfw`, `#favorites`) | **TAG** — at a tag anchor. ADR-0038. |
| Permissions / roles / DAO membership | **TAG** — membership claim. |

Lists are heavy (LIST + entries + anchor PIN); they exist to serve use cases tags can't (ranking, per-entry mutable state). Don't make lists do tag work.

---

## Reader API (v1)

Smart contracts and clients read lists via two paths depending on whether the LIST declares `sorted = true`:

**Path A — sorted lists** (`sorted = true`): read via `EFSSortOverlay`:
- `getSortedChunk(sortInfoUID, parentAnchor, startNode, limit, showRevoked) → (items[], nextCursor)` — paginated, cursor-driven, returns entries in `weight desc` order. Per ADR-0007's SortOverlay pattern.
- `sortInfoUID` is the curator's `SORT_INFO(parentAnchor=LIST_UID, sortFunc=WeightSort)` attestation UID — discoverable via `EFSSortOverlay.getSortInfo(LIST_UID)`.

**Path B — unsorted lists** (`sorted = false`): read via existing `EdgeResolver`:
- `getActiveTagEntries(definition, attester, targetSchema, start, length) → (tagUID, weight)[]` (per ADR-0041 §8)
- `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]` — **canonical unsorted list-entry reader** when called with `definition = LIST_UID`, `tagTargetSchema = ANCHOR_SCHEMA_UID`. `pinTargetID = bytes32(0)` is a valid result for freeform entries without inner PIN.

**Generic readers used by both paths**:
- `getActivePinTarget(definition, attester, targetSchema) → targetID` — for placement resolution
- `isActiveEdge(attester, targetID, definition, schema) → bool` — for tag-based membership patterns (used outside lists)
- `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]` — generic TAG bucket reader (lighter than the PIN-resolving variant when entries don't need their inner PIN dereferenced)

**Pagination is not capped at the kernel.** `length` is a caller hint; caller pays the gas. SDK helpers default to `length = 100` for safety, but callers may pass any value. View calls (`eth_call`) are bounded by RPC provider timeouts; in-transaction calls are bounded by the caller's gas. No `PageSizeTooLarge` revert (round-14 paternalism dropped).

### WeightSort comparator (NEW for v1)

A new `ISortFunc` implementation deployed alongside the LIST schema:

```solidity
contract WeightSort is ISortFunc {
    IEAS public immutable eas;
    EdgeResolver public immutable edgeResolver;
    
    function isLessThan(bytes32 a, bytes32 b, bytes32 sortInfoUID) external view returns (bool) {
        // a, b are entry anchor UIDs. The sort key is each entry's active weight TAG.
        bytes32 listUID = _getParent(sortInfoUID);     // parentAnchor from SORT_INFO
        address curator = _getCurator(sortInfoUID);    // curator from SORT_INFO
        
        int256 weightA = _getEntryWeight(a, curator, listUID);
        int256 weightB = _getEntryWeight(b, curator, listUID);
        
        if (weightA != weightB) return weightA > weightB;  // desc order
        return a < b;  // tie-break by entry UID asc
    }
    
    function _getEntryWeight(bytes32 entryUID, address curator, bytes32 listUID) internal view returns (int256) {
        // Look up the active weight TAG for (curator, entryUID, listUID, ANCHOR_SCHEMA_UID)
        // via EdgeResolver's edgeHash index, then decode weight from TAG attestation.
    }
}
```

Two EAS reads per comparison. O(N log N) reads to build initial sort; O(1) `repositionItem` per weight update.

### Placer vs curator: two scopes for two questions

A list read involves two distinct attester scopes:

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

For a typed list anchor at a path, placer `bob`, curator `alice` (where `alice` may equal `bob` in the single-attester case):

```
1. Path-walk to the typed list anchor (mylist_anchor).
   - Verify anchor.schemaUID == LIST_SCHEMA_UID.
   - If not, this isn't a list slot; render appropriate other primitive.

2. Resolve the LIST UID via the placer's PIN:
   listUID = EdgeResolver.getActivePinTarget(
     mylist_anchor,
     bob,                 // placer
     LIST_SCHEMA_UID
   )
   - If bytes32(0): the placer has no list at this path; render empty.

3. Determine the curator (default = LIST's own attester):
   listAttestation = eas.getAttestation(listUID)
   curator = curator_override ?? listAttestation.attester
   - Decode (sorted, allowsDuplicates, targetType, targetSchema) from listAttestation.data.
   - LIST is revocable: false; no revocation check needed.

4. Read list-level metadata (curator-scoped):
   name        = readPropertyAt(listUID, "name", curator)        // per ADR-0034
   description = readPropertyAt(listUID, "description", curator)
   ...

5. Enumerate entries with weights (curator-scoped):

   If sorted == true:
     sortInfoUID = EFSSortOverlay.getSortInfo(listUID, curator)
     (entries, nextCursor) = EFSSortOverlay.getSortedChunk(
       sortInfoUID,
       listUID,            // parentAnchor
       cursor,             // bytes32(0) on first call; nextCursor on subsequent
       limit,              // caller hint; uncapped at kernel
       showRevoked=false
     )
     // entries[] returned in weight desc order.
     // For each entry UID, dereference inner PIN + metadata as in step 6+.

   If sorted == false:
     entries = EdgeResolver.getActiveTagPinTargetsWithWeights(
       listUID,
       curator,
       ANCHOR_SCHEMA_UID,
       start,
       length              // caller hint; uncapped
     )
     // Returns (entryUID, tagUID, innerTargetID, innerTargetSchema, weight, attester)[]
     // Caller sorts client-side if order is desired.

6. For each entry:
   - If targetType == SCHEMA AND innerTargetID != bytes32(0):
       validate innerTargetSchema matches targetSchema.
   - If targetType == ADDR: inner PIN binds via recipient (innerTargetID = bytes32(uint160(addr))).
   - If innerTargetID == bytes32(0):
       render as intrinsic entry (no inner PIN; the anchor name IS the entry).
       (Valid for any targetType; common for targetType=ANY freeform lists.)

7. For per-entry metadata PROPERTYs (note, status, quantity, etc.):
   - Resolve named key anchor under entry; read PROPERTY value (curator-scoped).

8. Tie-break (sorted=false path) and final ordering:
   - Sort by weight desc, tie-break by entryUID asc, then tagUID asc.
```

The recipe makes the placer/curator split explicit. For single-attester reads (Alice reads Alice's list at Alice's path), `placer == curator == alice` — the split is invisible. For shared/bookmarked lists, the split prevents reading Bob's empty bucket when the actual contents are Alice's.

**Smart-contract top-N reads.** If `sorted == true`, contracts call `getSortedChunk` with `limit = N` and ignore `nextCursor` — single atomic call returns the top N. If `sorted == false`, contracts must either (a) accept that they only see a single arbitrary page, or (b) read multiple pages and sort in-contract (gas-bounded by the caller). For governance use cases that need reliable top-N, curate with `sorted = true`.

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

### Identity convergence (client-naming conventions)

The kernel doesn't care about naming patterns; it just enforces `(parent, name, schemaUID)` uniqueness. Three client conventions are useful, each with different multi-attester convergence properties:

**Target-derived names (Example A pattern):** clients name entries by the canonical hex of their target. Alice and Bob's "entry for book X" land at the same anchor name (deterministic name → shared anchor UID). Each writes their own PIN, weight TAG, and metadata under that shared name. Readers filter at the PIN/TAG layer (per-curator). Use for set-semantics lists where the same target shouldn't appear twice (top-N favorites, allowlists).

**Occurrence-derived names (Example C pattern):** clients name entries by `keccak256(abi.encode("efs:list-occurrence:v1", listUID, attester, clientNonce))`. Each occurrence is independent — same target can appear at multiple distinct entries. Entry-anchor sets are per-curator. Use with `allowsDuplicates=true` for playlists, ballots, syllabi.

**Freeform names (Example B pattern):** entry name = curator's choice (subject to ADR-0025 anchor name validation). No deterministic structure. Multi-attester convergence is opportunistic. Use for human-meaningful named lists (groceries, todos).

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

Schema configuration shorthand: `dup` = `allowsDuplicates`; `target` = `targetType`; `sort` = `sorted`. Naming convention is a client choice (see "Identity convergence" above).

| # | Use case | dup | target | sort | Naming | Notes |
|---|---|---|---|---|---|---|
| 1 | Top-N favorites (memes, books, etc.) | false | SCHEMA | true | target-derived | Weight = ranking |
| 2 | Annotated favorites with notes per entry | false | SCHEMA | true | target-derived | `note` PROPERTY on entry |
| 3 | Ratings (1–5★ per item) | false | SCHEMA | false | target-derived | Weight = rating value; sort optional |
| 4 | Reading list (priority order) | false | SCHEMA | true | target-derived | Weight = read order |
| 5 | Wishlist (priority order, with details) | false | SCHEMA | true | target-derived | Weight = priority; `note` PROPERTY |
| 6 | Tier list (S/A/B with sub-rank) | false | SCHEMA | true | target-derived | Weight encodes tier+rank, or `tier` PROPERTY |
| 7 | Curated awesome-EFS guide | false | ANY | true | target-derived | Per-entry rationale |
| 8 | DAO delegate slate (ranked candidates) | false | ADDR | true | target-derived | Weight = preference; smart-contract reads top-N |
| 9 | "People I trust for X topic" | false | ADDR | true | target-derived | Per-list context note |
| 10 | Cross-list reuse (same target in multiple lists) | varies | varies | varies | target-derived | Independent LIST UIDs sharing target via canonical-target PIN |
| 11 | Annotated bookmarks | false | SCHEMA | true | target-derived | URL via DATA wrapper; `note` PROPERTY |
| 12 | Inventory / stock list | false | SCHEMA | false | target-derived | `stock`, `price` PROPERTYs |
| 13 | Achievements with date earned | false | SCHEMA | true | target-derived | `earnedAt` PROPERTY |
| 14 | **Same list at multiple paths** | varies | varies | varies | any | Multiple typed list anchors PIN to same LIST UID |
| 15 | **Bob bookmarks Alice's list** | varies | varies | varies | any | Bob's typed list anchor PINs Alice's LIST UID |
| 16 | **Moving a list between folders** | varies | varies | varies | any | Revoke old placement PIN; create new typed list anchor at new path |
| 16a | **DAO co-contribution to shared list** | varies | varies | varies | any | Multiple attesters write entries against same LIST UID; viewer chooses scope |
| 17 | Playlist with duplicates | **true** | SCHEMA | true | occurrence-derived | Same DATA at multiple entries |
| 18 | Syllabus / step-by-step guide | **true** | ANY | true | occurrence-derived | Per-step prose |
| 19 | Ranked ballot | **true** | ADDR or SCHEMA | true | occurrence-derived | Position is meaningful |
| 20 | Shopping list (items with status) | false | ANY | false or true | freeform | Names like "milk", "eggs"; no inner PIN; `status` PROPERTY |
| 21 | Todo list (status per task) | false | ANY | false or true | freeform | Names are task descriptions; no inner PIN; `status` PROPERTY |
| 22 | Custom-named curated catalogue | false | varies | varies | freeform | Curator chooses entry names |
| 23 | Course curriculum (lessons with status) | **true** | ANY | true | occurrence-derived | `status` per lesson |

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

### Entry naming inconsistency (client convention only)

Since entry naming is a client convention, not a kernel concern, a buggy or malicious attester can author an entry anchor with a name that doesn't match its claimed convention. Examples:
- Target-derived list with an entry named `0xBob…` that PINs to a different target.
- Occurrence-derived entry name not actually derived from `keccak256(...)`.
- Freeform name that violates the curator's own UX expectations.

This is a **trust-the-curator** invariant. The kernel doesn't validate it; clients reading lists should treat the entry's TAG attestation and its `(attester, weight, target via PIN)` tuple as the trust unit, not the anchor's name pattern. Smart contracts consuming on-chain reads should reason about target UIDs, not name strings.

If naming hygiene becomes a real problem post-launch, a future ADR can add an optional `EntryNameValidator` reader as a soft check. v1 ships without it.

### `clientNonce` convention is unenforceable at the kernel

Sequential nonces and CSPRNG output produce identical-looking `keccak256` hashes. The kernel cannot distinguish.

Smart contracts consuming `allowsDuplicates=true` lists SHOULD treat the entry's UID and the curator's TAG attestation as the trust unit — NOT the entry name pattern.

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

## Decisions resolved (round-15)

1. **LIST attestations are free-floating, `revocable: false`.** Like DATA. The LIST UID is permanent at its UID; deletion happens at the placement-PIN layer, not the LIST itself.
2. **Schema fields: `(bool sorted, bool allowsDuplicates, uint8 targetType, bytes32 targetSchema)`.** No `entryIdentity` — naming is a client convention. No `coContributionPolicy` — category error in EFS (editions ARE the access control).
3. **Path placement is a typed list anchor + PIN.** `Anchor<schemaUID=LIST_SCHEMA_UID>` declares "this slot holds a list"; the PIN attaches the specific LIST UID. Same shape as `Anchor<PROPERTY>` slots.
4. **Same LIST can be placed at multiple typed list anchors.** Multiple PINs from different list anchors all reference the same LIST UID.
5. **Cross-attester sharing and contribution work natively.** Bob can create his own typed list anchor and PIN to Alice's LIST UID (bookmark); Bob can write entries/weights against Alice's LIST UID (co-contribution). **Editions handle spam-resistance at read time** — kernel does not gate writes at any layer.
6. **List-level metadata attaches to the LIST attestation**, not the path anchor. Uses ADR-0034 `name` PROPERTY for display name. `description`, `cover`, `icon`, `category` follow the same pattern.
7. **Singleton-per-list-anchor is enforced by PIN cardinality** (`(attester, list_anchor, LIST_SCHEMA)`). Typed list anchor's own schemaUID prevents cross-`targetSchema` collisions.
8. **Lists are NOT folders, BUT both are "drill-into containers" at the UX layer.** Kernel-level: lists = typed anchor + LIST attestation + TAG-ordered entries; folders = generic anchor + child anchors. UX-level: both are "click to see contents."
9. **Membership patterns use TAGs**, not lists. Allowlists, blocklists, follow graphs, DAO membership, categorization, permissions — all are tagging patterns. `isActiveEdge` is the membership primitive.
10. **Entry inner PIN is always optional.** Target-bearing entries (typical for `targetType=SCHEMA` or `targetType=ADDR`) PIN to their target. Freeform/intrinsic entries (`targetType=ANY` shopping-list style) skip the inner PIN; the anchor name IS the entry.
11. **Mandatory `ListResolver`** for field-validation only. Validates `targetType ≤ 2`, (targetType, targetSchema) coherence, free-floating envelope (refUID=0, recipient=0). Does NOT gate writes by attester.
12. **Ranked reads via `sorted` field.** `sorted=true` (SDK default) creates a SORT_INFO + WeightSort; smart contracts read via `EFSSortOverlay.getSortedChunk`. `sorted=false` skips SortOverlay; reads are unsorted active-entry pages. SDK transparently handles `repositionItem` on weight changes when `sorted=true`.
13. **Reader API splits placer from curator scope.** `resolveListPlacement(anchor, placer) → listUID`; `readListByUID(listUID, curator)`; convenience `read(anchor, placer, curator?)` with curator defaulting to `LIST.attester`.
14. **Single-curator-scoped reads as default.** Multi-attester is opt-in. Subgraphs MUST scope active-set queries to a curator (anti-spam invariant).
15. **Default ordering: `weight desc`, tie-break by entry-UID asc, then `tagUID` asc.**
16. **Sparse `int256` weights are an SDK SHOULD for manual ordering**, NOT a universal MUST.
17. **No kernel page-size cap.** Round-14's `PageSizeTooLarge` revert dropped. Caller pays for what they read; RPC providers handle their own timeouts. SDK default hint `length = 100`.
18. **Client `clientNonce` for occurrence-derived naming MUST be ≥128 bits CSPRNG** — convention only; kernel cannot enforce.
19. **Snapshot consistency MUST**: smart contracts get atomicity per call; off-chain clients pin `blockTag`; governance reads finalized.
20. **Convention-violating lists are accepted v1 risk** with named revisit triggers in §"Conventions vs enforcement."
21. **Shopping lists, todos, stateful per-entry items are core supported use cases** via `targetType=ANY` + freeform entries + per-entry PROPERTYs.
22. **`specs/06` rewrite required before dev** writes list data. `specs/08` superseded.
23. **`specs/02` and `specs/03` SHOULD note the lists-vs-tags distinction** explicitly.
24. **List "deletion" semantics**: revoke placement PINs to remove from path. The LIST attestation is permanent. Curators wanting full disappearance must revoke entry TAGs too. Bookmarks from other curators cannot be force-removed.
25. **`name` is the canonical display-key PROPERTY** per ADR-0034. Round-14's `title` is dropped (was convention drift; reverted).
26. **PIN-trust-extension** (system-wide; not list-specific) is extracted to its own ADR. References from this design link to that ADR.
27. **Per-schema namespace + URL syntax** (system-wide; not list-specific) is extracted to its own ADR.

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
   - `(bool sorted, bool allowsDuplicates, uint8 targetType, bytes32 targetSchema)`
   - `revocable: false`
   - `resolver: ListResolver` (mandatory; field-validation only)
   - Registered in deploy script.

2. **New contract: `ListResolver`** — minimal field validator (see schema section). ~50 lines of Solidity.

3. **New contract: `WeightSort`** — `ISortFunc` implementation that reads each entry's active weight TAG via EdgeResolver and compares by `int256 weight desc`, tie-break by entry UID asc. Deployed once; reused as the `sortFunc` for every `sorted=true` LIST. ~80 lines of Solidity.

4. **`EdgeResolver` extensions** (carried from rounds 7/8 — generic graph-composition names, no list-specific vocabulary):
   - `getActiveTagTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, weight, attester)[]`
   - `getActiveTagPinTargetsWithWeights(definition, attester, tagTargetSchema, start, length) → (tagTargetID, tagUID, pinTargetID, pinTargetSchema, weight, attester)[]`
   - No `PageSizeTooLarge` revert; `length` is a caller hint.

5. **Reserved-key anchor names**:
   - **Entry-level**: `note`, `status`, `quantity`, `completedAt`.
   - **List-level** (on LIST attestation): `name` (per ADR-0034), `description`, `cover`, `icon`, `category`.

6. **SDK helpers**:
   - `efs.lists.create(opts) → listUID` — creates free-floating LIST attestation; if `opts.sorted !== false`, also attests `SORT_INFO(parentAnchor=listUID, sortFunc=WeightSort)`
   - `efs.lists.placeAt(listUID, parentAnchor, anchorName) → {listAnchorUID, pinUID}` — creates typed list anchor + placement PIN
   - `efs.lists.unplaceFrom(listAnchorUID)` — revokes placement PIN
   - `efs.lists.bookmarkAtMyPath(listUID, parentAnchor, anchorName)` — Bob creates his typed list anchor + PIN to Alice's LIST UID
   - `efs.lists.addEntry(listUID, opts) → entryAnchorUID` — creates entry anchor + (optional) inner PIN + weight TAG; if `sorted=true` on the LIST, also calls `EFSSortOverlay.processItems` and `repositionItem` for the new entry
   - `efs.lists.setEntryWeight(entryUID, newWeight)` — re-attests weight TAG; if `sorted=true`, also calls `repositionItem`
   - `efs.lists.setEntryMetadata(entryAnchor, key, value)` — per-entry PROPERTY
   - `efs.lists.setListMetadata(listUID, key, value)` — list-level PROPERTY (uses `name` for display name per ADR-0034)
   - `efs.lists.resolveListPlacement(anchor, placer) → listUID | null`
   - `efs.lists.readListByUID(listUID, curator?, opts) → ListView` — uses sorted vs unsorted path based on LIST's `sorted` field
   - `efs.lists.read(anchor, placer, curator?, opts) → ListView` — convenience wrapper
   - `canonicalTargetDerivedName(targetID) → string` — for target-derived naming convention
   - `canonicalOccurrenceName(listUID, attester, clientNonce) → string` — for occurrence-derived naming
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
| 3 | LIST entries (unsorted) | Add 5 entries; read via `getActiveTagPinTargetsWithWeights(LIST_UID, curator, ANCHOR_SCHEMA_UID, ...)` |
| 4 | LIST entries (sorted) | Add 5 entries to `sorted=true` LIST; SDK creates SORT_INFO; read via `getSortedChunk` returns weight-desc order |
| 5 | WeightSort | Re-attest weight TAG via SDK; SortOverlay `repositionItem` is called; subsequent `getSortedChunk` reflects new order |
| 6 | LIST | Revoke entry TAG; swap-and-pop semantics in EdgeResolver; SortOverlay unlinks the entry |
| 7 | LIST | Address-target entries via PIN `recipient` (`targetType=ADDR`) |
| 8 | LIST | Negative weight stays active (ADR-0042 doesn't apply); negative weights sort below positive ones |
| 9 | LIST | Add `note` PROPERTY to entry; update via PIN re-attest |
| 10 | LIST | Multi-attester at shared target-derived entry anchor (each curator's PIN/weight independent) |
| 11 | LIST | Two distinct entries, same target (occurrence-derived names, `allowsDuplicates=true`) |
| 12 | LIST | Freeform entry "milk" with no inner PIN; reader returns `pinTargetID = bytes32(0)`; clients render as intrinsic |
| 13 | LIST | Freeform entry with optional inner PIN; reader returns target |
| 14 | LIST | List-level `name` PROPERTY attaches to LIST attestation; bookmark resolves with same name (ADR-0034 alignment) |
| 15 | **Same LIST, two anchors** | Place LIST at typed list anchor A1; place same LIST at A2; both paths resolve to same LIST UID |
| 16 | **Bob bookmarks Alice's LIST** | Bob's typed list anchor PINs Alice's LIST UID; `read(anchor, placer=bob, curator=alice)` returns Alice's entries; `read(anchor, placer=bob)` defaults curator to LIST attester (alice) |
| 17 | **Move LIST between anchors** | Revoke placement PIN at A1; create new typed list anchor + PIN at A2; LIST follows |
| 18 | **List "deletion"** | Revoke placement PIN; LIST UID still readable via direct `readListByUID`; placement-based read returns null |
| 19 | **DAO co-contribution** | Multiple attesters write entries against same LIST UID; per-attester reads return only that attester's entries |
| 20 | LIST schema (`revocable: false`) | Revoke attempt on LIST attestation fails or has no effect; entries and TAGs are individually revocable |
| 21 | `ListResolver` validation | Attest LIST with `targetType=3` reverts; attest LIST with `targetType=SCHEMA, targetSchema=0` reverts |
| 22 | Snapshot | Read at finalized block tag matches active state |
| 23 | Anchor names | Validator passes on 42-char address hex + 66-char UID hex (ADR-0025) |
| 24 | Indexer | TAG re-attest detected as supersession via edgeHash |
| 25 | Indexer | PIN re-attest at same slot detected as supersession (target may change) |
| 26 | Indexer | Reverse lookup `getEdgeDefinitions(LIST_UID)` returns all placement anchors |
| 27 | Tag patterns | Allowlist via TAG + isActiveEdge works (no list infrastructure) |
| 28 | Cross-targetSchema | Typed list anchor's schemaUID prevents file-PIN collision (anchor's own type signals intent) |
| 29 | Pagination | `length=10000` does NOT revert; gas-bounded by caller |
| 30 | `sorted=false` path | Reader returns unsorted active-entry page; client sorts client-side |

**NatSpec requirements** (carried from earlier rounds): document address-target encoding, `pinTargetID = bytes32(0)` semantics, occurrence-derived trust model, placer-vs-curator semantics, `sorted=true` vs `sorted=false` read path branching.

---

## Provenance

Design produced through cross-agent brainstorming between Claude Sonnet 4.7 and Codex GPT-5, with independent validation passes from Gemini 2.5 Pro and a fresh Claude review at rounds 13 and 14, plus a focused side-thread that stress-tested round-14 against alternatives. Mediated and decided by James Carnley throughout. Fifteen rounds of refinement preserved in [`custom-lists_notes.md`](./custom-lists_notes.md).

**Round trajectory:**
- Round 13: free-floating LIST attestation, file-like portability via PIN.
- Round 14: typed list anchors (parallel to PROPERTY slots), `revocable: false`, list-level metadata on LIST attestation, freeform-no-PIN, placer/curator API split.
- Round 15: schema field simplification (`bool sorted, bool allowsDuplicates, uint8 targetType`), principled editions-as-access-control stance, drop kernel page-cap paternalism, extract cross-cutting ADRs (PIN-trust-extension, per-schema-namespace+URL syntax), "drill-into collections" mental model.
