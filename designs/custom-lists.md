# EFS Lists — Design

**Status:** Draft (round 18 — converged on LIST + LIST_ENTRY architecture via 5-agent parallel design proposals; pending external review before ADR freeze)
**Date:** 2026-05-27
**Permanence-tier:** Etched-adjacent (introduces two new EAS schemas; the data model is permanent post-mainnet freeze)
**Authors:** Claude Sonnet 4.7 (round-18 convergence synthesis; 17 prior rounds with Codex GPT-5, Gemini 2.5 Pro, and fresh-Claude review passes) + James Carnley (architectural direction; requirements crystallization; final-frame decisions)
**Related:** ADR-0007, ADR-0025, ADR-0030, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history through 18 rounds, parked ideas, rejected reframes
**Supersedes:** rounds 11-17 (entry-anchor + weight-TAG model). Historical content preserved in notes file.

---

## TL;DR

**Two new schemas: `LIST` (declaration, non-revocable) + `LIST_ENTRY` (membership, revocable, gated by `ListEntryResolver`).** All declared list options — duplicates policy, target type, append-only, capped, intrinsic-allowed — are enforced at write time by the resolver. Smart contracts can iterate active entries with O(N) reads and full type confidence. O(1) membership check for all modes.

```
                   ┌─────────────────────────────────────────────────────┐
LIST (declaration) │  allowsDuplicates, appendOnly, targetType,          │
                   │  targetSchema, maxEntries, allowIntrinsic           │
                   │  refUID = 0x0 (free-floating, like DATA)            │
                   │  revocable: false                                    │
                   │  resolver: ListResolver (field-shape validation)     │
                   └─────────────────────────────────────────────────────┘
                                          ▲
                                          │ (referenced via field, not refUID)
                                          │
                   ┌─────────────────────────────────────────────────────┐
LIST_ENTRY         │  bytes32 listUID                                    │
(membership)       │  bytes32 target  (attestation UID, or addr-as-     │
                   │                   bytes32, or 0x0 for intrinsic)    │
                   │  int256  weight  (sort/rank metadata)               │
                   │  revocable: true (resolver rejects revoke if list   │
                   │              is appendOnly)                          │
                   │  resolver: ListEntryResolver                         │
                   └─────────────────────────────────────────────────────┘
```

**Per-attester editions** are preserved via attester-keyed resolver state. **Per-entry metadata** uses the standard PROPERTY-on-attestation pattern attached to the LIST_ENTRY UID. **List placement** in paths uses a standard PIN (`Anchor → PIN → LIST`).

**Picker decision (when to use what):**

> *Need write-time-enforced shape (no-dupes, typed, append-only) or curated rank/order?*
>   Yes → use a LIST
>   No  → use TAGs directly

Lists are for curated/ranked/typed/shape-enforced collections. Pure membership without shape guarantees (allowlists with no type constraint, follow graphs, casual labeling) uses TAGs.

---

## What this design replaces and why

Rounds 11-16 explored an **entry-anchor model**: each entry was an anchor child of the LIST UID, with a PIN to the target and a weight TAG for ordering (3 attestations per entry). Round 17 attempted to plug write-time enforcement gaps with a generic constraint-callback mechanism (ADR-0043) — three external reviewers independently returned RED on the same finding: the mechanism solved a non-problem inside a frame that presupposed it was needed.

Round 18 started by crystallizing requirements with the human (MUST/NICE/DEFERRED) and then ran 5 parallel agents with different design framings (defend round-16; refine LIST+LIST_ENTRY; greenfield; consumer-first; hybrid). **4 of 5 independently converged on the LIST + LIST_ENTRY architecture documented here.** The round-16 defender admitted MEDIUM confidence and recommended a head-to-head bake-off; the hybrid agent collapsed to LIST+LIST_ENTRY when its "escape hatch" was removed.

**What round-16 couldn't deliver without surgery:**
- `targetType` write-time enforcement: EdgeResolver doesn't validate target.schema against any declared field
- `appendOnly` write-time enforcement: requires cross-resolver coordination
- `allowsDuplicates=false` enforcement: relies on convention (target-derived naming) + ADR-0025, not direct enforcement
- All three together: not achievable without polluting EdgeResolver (shared kernel) or introducing the constraint-callback mechanism that ADR-0043 deferred

**What round-18 delivers cleanly:**
- All three above enforced by `ListEntryResolver` at write time
- Per-attester editions, O(1) membership, O(N) iteration unchanged
- Per-entry metadata via standard PROPERTY-on-attestation (LIST_ENTRY UID is the scope target)
- ADR-0041 (cardinality-in-schema-UID) reconciled, not violated

---

## Locked requirements

These are the requirements crystallized with the human before round-18's design pass. They are not revisited by this design; they are the goalposts.

### MUST satisfy

- **Ordered lists** (rank/weight semantics) + **Unordered lists** (membership only)
- **No-duplicates lists** (write-time enforced) + **Duplicates-allowed lists**
- **Typed lists** (declared target schema, write-time enforced) + **Untyped lists** (any bytes32 as target) + **Address-typed lists** (target is an Ethereum address, including `address(0)`)
- **Append-only lists, list-level** (write-time enforced — revokes rejected)
- **Per-attester editions preserved** (each attester has their own version of any list)
- **Smart contracts iterate active entries with O(N) reads + full type confidence** (no per-entry validation in the consumer)
- **O(1) membership check** ("X in list L by attester A?") **for ALL list modes**

### NICE (support if cheap; design must not preclude)

- **Per-entry metadata** — notes, ratings, status flags (via PROPERTY-on-LIST_ENTRY-UID)
- **Per-entry deprecation/tombstone flags** — pairs with append-only (entry stays, flagged)
- **Intrinsic items** — items that aren't pre-existing attestations (shopping-list "milk")
- **Reorderable** via sparse int256 weights
- **Capped / max-N** lists

### DEFERRED (out of scope for v1)

- Generic constraint-callback / extension mechanism (ADR-0043 — wrong abstraction)
- Cross-attester merged on-chain view (client/SDK concern)
- On-chain reverse-lookup index ("what lists contain X?" for arbitrary X — subgraph concern)
- Mainnet 50-year freeze (devnet ships first; mainnet freeze applies later)

### Validation model

**Write-time, by resolver.** When a `LIST_ENTRY` is attested, `ListEntryResolver` validates against the parent `LIST`'s declared options before storage. Once written, downstream readers trust without re-validation. `address(0)` is a valid target for ADDR-typed lists.

---

## Architecture

### Schemas

**`LIST` — declaration (the list's identity and configuration)**

```solidity
LIST schema:
  bool    allowsDuplicates    // false = no-duplicates enforced at write time
  bool    appendOnly          // true  = entry revokes rejected by resolver
  uint8   targetType          // 0=ANY, 1=ADDR, 2=SCHEMA
  bytes32 targetSchema        // non-zero iff targetType==SCHEMA
  uint32  maxEntries          // 0 = uncapped; per-attester cap
  bool    allowIntrinsic      // true = entries may have target=bytes32(0)
revocable: false
resolver:  ListResolver       // field-shape validation only (see below)
refUID:    bytes32(0)          // free-floating, like DATA
recipient: address(0)          // never directed
```

**Field rationale:**

- `allowsDuplicates` — bool, not bitfield. Programmers thank us in 2076.
- `appendOnly` — bool, list-level. When true, the resolver rejects every entry revoke for this list. Use cases: software version registries, on-chain receipts, immutable references. Pairs with per-entry deprecation PROPERTYs (NPM/crates.io model — entries can be flagged "deprecated" without being removed).
- `targetType` — uint8 enum: `0=ANY`, `1=ADDR`, `2=SCHEMA`. Not a bitfield. A future targetType=3 (e.g., DELEGATED) requires a new schema, not a flag.
- `targetSchema` — non-zero iff `targetType==SCHEMA`; the EAS schema UID every entry's target must match. The resolver checks `eas.getAttestation(target).schema == targetSchema` at every entry write.
- `maxEntries` — uint32, 0 = uncapped. Per-attester (matches editions model). Included now because adding it later would require a new schema UID.
- `allowIntrinsic` — bool. When true, entries may have `target = bytes32(0)` (the "milk" case in a shopping list). When false, target==0 is rejected. Implies `targetType==ANY` (only ANY-typed lists may have intrinsic entries).

**Why these fields are on LIST (not on each LIST_ENTRY):** The list's *configuration* is the predicate-coordination layer (see ADR-0041 reconciliation below). Putting it on each entry would be redundant and contradictory if entries diverged. Putting it on LIST once, with LIST being non-revocable, means every entry reader can derive the constraints from one immutable source.

**Why LIST is non-revocable:** The list's *identity* is permanent. Deletion is per-entry (revoking entries) or impossible (when `appendOnly=true`). A user who wants to abandon a list stops adding to it; the declaration persists as historical fact. This matches DATA (also non-revocable — content identity is permanent; specific placements via MIRROR are revocable).

---

**`LIST_ENTRY` — membership (one entry in one list)**

```solidity
LIST_ENTRY schema:
  bytes32 listUID             // the LIST attestation this entry belongs to
  bytes32 target              // attestation UID, or bytes32(uint160(addr)),
                              //   or bytes32(0) for intrinsic items
  int256  weight              // sort/rank metadata (ignored when no SORT_INFO)
revocable: true               // resolver rejects revoke when LIST.appendOnly=true
resolver:  ListEntryResolver
refUID:    bytes32(0)          // listUID is in the data payload, not refUID
recipient: address(0)          // never directed
```

**Field rationale:**

- `listUID` — explicit field, not `refUID`. Using `refUID` would conflate "this entry is in this list" with EAS's generic refUID semantics. Putting it in the data payload makes indexers' jobs explicit.
- `target` — explicit field for the entry's target. Three encodings:
  - Attestation UID (for `targetType=ANY` or `targetType=SCHEMA`)
  - `bytes32(uint160(addr))` (for `targetType=ADDR`)
  - `bytes32(0)` (for intrinsic items, only when `allowIntrinsic=true`)
- `weight` — int256, kept on every entry regardless of order semantics. The gas saved by removing it from unordered entries doesn't justify a schema UID split; unordered readers simply ignore the field. Sparse int256 spacing gives infinite room for re-ordering without rewriting other entries.

**Why a single attestation per entry (not 3 like round-16):** Round-16's entry-anchor + PIN + weight-TAG required 3 attestations per entry. The flat LIST_ENTRY needs 1. Per-entry metadata still uses the standard PROPERTY pattern (3 attestations per metadata field) but only when actually wanted — most entries don't have metadata.

**Why revocable:** Non-append-only lists need revocable entries. The resolver branches on the parent LIST's `appendOnly` flag: revocable in spirit, rejected at write-time if the list says append-only.

---

### Resolver behavior

#### `ListResolver` (on LIST schema)

Field-shape validation only. Does NOT maintain state. The expensive work happens in `ListEntryResolver`.

```solidity
function onAttest(Attestation calldata a, uint256) returns (bool) {
    require(a.data.length == EXPECTED_LIST_DATA_LENGTH, "bad LIST payload");
    (
      bool allowsDuplicates,
      bool appendOnly,
      uint8 targetType,
      bytes32 targetSchema,
      uint32 maxEntries,
      bool allowIntrinsic
    ) = abi.decode(a.data, (bool, bool, uint8, bytes32, uint32, bool));

    require(a.refUID == bytes32(0),    "LIST must be free-floating");
    require(a.recipient == address(0), "LIST must not be directed");
    require(targetType <= 2,            "invalid targetType");

    // (targetType, targetSchema) coherence
    if (targetType == 2 /* SCHEMA */) {
        require(targetSchema != bytes32(0), "SCHEMA targetType requires targetSchema");
    } else {
        require(targetSchema == bytes32(0), "non-SCHEMA targetType must have zero targetSchema");
    }

    // allowIntrinsic only meaningful with ANY-typed lists
    if (allowIntrinsic) {
        require(targetType == 0 /* ANY */, "allowIntrinsic requires targetType=ANY");
    }

    emit ListAttested(a.uid, a.attester, allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries, allowIntrinsic);
    return true;
}
// onRevoke unreachable: LIST is revocable: false.
```

#### `ListEntryResolver` (on LIST_ENTRY schema)

State maps:

```solidity
struct CachedListDecl {
    bool    exists;
    bool    allowsDuplicates;
    bool    appendOnly;
    uint8   targetType;
    bytes32 targetSchema;
    uint32  maxEntries;
    bool    allowIntrinsic;
}

// Cache the LIST's declaration on first touch (cold path: 1 EAS read; warm: 1 SLOAD)
mapping(bytes32 listUID => CachedListDecl) private _decl;

// Per-list, per-attester active entries (insertion order; iteration source)
mapping(bytes32 listUID => mapping(address attester => bytes32[])) private _entries;

// O(1) membership + no-dupes counter
//   serves both: enforces "count == 0" when !allowsDuplicates, and provides "count > 0" for isMember
mapping(bytes32 listUID => mapping(bytes32 target => mapping(address attester => uint256))) private _entryCount;

// Swap-and-pop index for revoke
mapping(bytes32 entryUID => uint256) private _entryPosPlusOne;
```

`onAttest`:

```solidity
function onAttest(Attestation calldata a, uint256) returns (bool) {
    require(a.data.length == EXPECTED_ENTRY_DATA_LENGTH, "bad LIST_ENTRY payload");
    (bytes32 listUID, bytes32 target, int256 weight) =
        abi.decode(a.data, (bytes32, bytes32, int256));
    require(listUID != bytes32(0), "missing listUID");

    // Hydrate declaration on first touch
    CachedListDecl memory d = _decl[listUID];
    if (!d.exists) {
        Attestation memory L = eas.getAttestation(listUID);
        require(L.schema == LIST_SCHEMA_UID, "listUID is not a LIST");
        (d.allowsDuplicates, d.appendOnly, d.targetType, d.targetSchema,
         d.maxEntries, d.allowIntrinsic) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32, bool));
        d.exists = true;
        _decl[listUID] = d;
    }

    // Type enforcement (write-time)
    if (target == bytes32(0)) {
        // Intrinsic item
        require(d.allowIntrinsic, "intrinsic entries not allowed");
        // targetType MUST be ANY (enforced at LIST attest time)
    } else if (d.targetType == 1 /* ADDR */) {
        // Address-typed: target must fit in 160 bits (high 96 bits zero)
        // address(0) is rejected by target==bytes32(0) check above only if
        // allowIntrinsic; otherwise address(0) is a valid ADDR target.
        // BUT: ADDR-typed lists must NOT have allowIntrinsic (enforced at LIST attest).
        // So address(0) for ADDR-typed list: target encoding is bytes32(uint160(0)) == bytes32(0),
        // which gets caught above. To support address(0) for ADDR lists, we use a sentinel:
        // ADDR encoding is `bytes32(uint160(addr) | (1 << 160))` — high bit set distinguishes
        // "this is an address" from "this is intrinsic/empty".
        // [OPEN: this needs review — see Open Concerns §3]
        require(uint256(target) >> 160 != 0 || addrSentinelSet(target), "invalid ADDR encoding");
    } else if (d.targetType == 2 /* SCHEMA */) {
        Attestation memory t = eas.getAttestation(target);
        require(t.uid != bytes32(0), "target attestation missing");
        require(t.schema == d.targetSchema, "target schema mismatch");
    }
    // targetType == ANY with target != 0: any UID accepted

    // No-duplicates enforcement
    if (!d.allowsDuplicates) {
        require(_entryCount[listUID][target][a.attester] == 0, "duplicate target");
    }

    // Cap enforcement (per-attester)
    if (d.maxEntries != 0) {
        require(_entries[listUID][a.attester].length < d.maxEntries, "list full");
    }

    // Append + index
    _entries[listUID][a.attester].push(a.uid);
    _entryPosPlusOne[a.uid] = _entries[listUID][a.attester].length;
    _entryCount[listUID][target][a.attester] += 1;

    emit ListEntryAttested(listUID, a.attester, a.uid, target, weight);
    return true;
}
```

`onRevoke`:

```solidity
function onRevoke(Attestation calldata a, uint256) returns (bool) {
    (bytes32 listUID, bytes32 target, ) = abi.decode(a.data, (bytes32, bytes32, int256));

    CachedListDecl memory d = _decl[listUID];
    require(d.exists, "unknown listUID");

    // Append-only enforcement: reject revocation entirely
    require(!d.appendOnly, "list is append-only");

    // Gate cleanup behind position check (idempotent on stale revoke)
    uint256 pp1 = _entryPosPlusOne[a.uid];
    if (pp1 == 0) return true;

    // Swap-and-pop
    uint256 idx = pp1 - 1;
    bytes32[] storage arr = _entries[listUID][a.attester];
    uint256 last = arr.length - 1;
    if (idx != last) {
        bytes32 movedUID = arr[last];
        arr[idx] = movedUID;
        _entryPosPlusOne[movedUID] = idx + 1;
    }
    arr.pop();
    delete _entryPosPlusOne[a.uid];
    _entryCount[listUID][target][a.attester] -= 1;

    emit ListEntryRevoked(listUID, a.attester, a.uid, target);
    return true;
}
```

**Reentrancy note:** `eas.getAttestation()` is a pure storage read in EAS 1.x — no resolver callbacks fire. The resolver has no untrusted external calls and no ETH-handling surface. Documented as load-bearing assumption; if EAS adds callback hooks in a future version, re-audit. (Not blocking for v1.)

**Events:** `ListAttested` on declaration; `ListEntryAttested` / `ListEntryRevoked` on membership changes. These are sufficient for any subgraph to materialize lists without reading resolver mappings.

---

### Smart contract reader (`ListReader`)

A stateless view contract on top of `ListEntryResolver`. Provides a stable ABI for consumers; lets the resolver evolve internal layout without breaking integrations.

```solidity
interface IListReader {
    struct ListMode {
        bool    exists;
        bool    allowsDuplicates;
        bool    appendOnly;
        uint8   targetType;
        bytes32 targetSchema;
        uint32  maxEntries;
        bool    allowIntrinsic;
    }

    struct ListEntry {
        bytes32 entryUID;
        bytes32 target;
        int256  weight;
    }

    /// Returns the list's declared configuration. One SLOAD via resolver cache.
    function getMode(bytes32 listUID) external view returns (ListMode memory);

    /// Number of active entries for (list, attester). O(1).
    function length(bytes32 listUID, address attester) external view returns (uint256);

    /// Page of active entries. Insertion order; O(N) reads, one SLOAD per entry.
    function entries(bytes32 listUID, address attester, uint256 start, uint256 len)
        external view returns (ListEntry[] memory);

    /// O(1) membership check. Works for all modes (no-dupes, dups-allowed, append-only, etc.).
    /// For duplicates-allowed lists: returns true iff at least one entry with this target exists.
    function isMember(bytes32 listUID, address attester, bytes32 target)
        external view returns (bool);

    /// O(1) entry count for a specific target (== 1 for no-dupes; can be > 1 for dups-allowed).
    function countOf(bytes32 listUID, address attester, bytes32 target)
        external view returns (uint256);
}
```

**Consumer pattern (NFT allowlist):**

```solidity
function buy(uint256 tokenId, address curator) external payable {
    require(
        listReader.isMember(allowlistUID, curator, bytes32(uint256(uint160(msg.sender)))),
        "not on allowlist"
    );
    _executePurchase(msg.sender, tokenId);
}
```

**Consumer pattern (DAO weighted distribution):**

```solidity
function distribute(bytes32 listUID, address curator, uint256 pool) external {
    IListReader.ListMode memory m = listReader.getMode(listUID);
    require(m.exists && m.targetType == 1 /* ADDR */, "wrong list type");

    uint256 n = listReader.length(listUID, curator);
    IListReader.ListEntry[] memory es = listReader.entries(listUID, curator, 0, n);

    int256 totalWeight;
    for (uint i; i < es.length; i++) totalWeight += es[i].weight;
    require(totalWeight > 0, "no positive weights");

    for (uint i; i < es.length; i++) {
        if (es[i].weight <= 0) continue;
        address recipient = address(uint160(uint256(es[i].target)));
        uint256 share = (pool * uint256(es[i].weight)) / uint256(totalWeight);
        payable(recipient).transfer(share);
    }
}
```

The consumer trusts target encoding (no per-entry validation), trusts schema correctness (for TYPED lists), and pays a single bulk SLOAD for the entry array. Type confidence comes from the resolver's write-time enforcement.

---

## Per-entry metadata pattern

EFS already has a generic mechanism for attaching strings to any attestation UID: the PROPERTY pattern. Per-entry metadata uses it directly.

**Three metadata scopes, three different UIDs to attach to:**

| Scope | Attach PROPERTY to | Example |
|---|---|---|
| Intrinsic to the content | DATA UID (or other target) | Avatar's release year (2009) — affects every list referencing Avatar |
| Per-entry in this list | LIST_ENTRY UID | Alice's rating of Avatar in her Top-10 (9/10) — affects only Alice's entry |
| Per-list (whole list) | LIST UID | List display name, description, cover image |

**Concrete example — Alice's Letterboxd-style top-10 with per-entry ratings:**

```
LIST L1
  ├── allowsDuplicates=false, appendOnly=false, targetType=SCHEMA,
  │   targetSchema=FILM_SCHEMA, maxEntries=10, allowIntrinsic=false
  │
  ├── PROPERTY on L1: name="Alice's Top 10 of 2009" (list-scope metadata)
  │
  ├── LIST_ENTRY E1: target=avatar_film_uid, weight=900
  │   └── PROPERTY on E1: rating="9/10"      (entry-scope metadata)
  │
  └── LIST_ENTRY E2: target=district9_film_uid, weight=850
      └── PROPERTY on E2: rating="8.5/10"   (entry-scope metadata)

(Films themselves carry release-year PROPERTYs on their FILM UIDs — content-scope.
These are independent of any list.)
```

Each metadata attestation costs 3 attestations (Anchor + PIN + PROPERTY). Apps choose how heavy their metadata layer is. No special design needed; the LIST_ENTRY UID is just another attestation that PROPERTYs can hang off.

---

## ADR-0041 reconciliation

ADR-0041 establishes that **cardinality lives in the schema UID** because the schema UID is the only "Etched" globally-coordinated slot. PIN (cardinality 1) and TAG (cardinality N) are distinct schema UIDs for this reason. Putting cardinality switches on individual attestations was explicitly rejected.

This design has cardinality (`allowsDuplicates`) and type (`targetType`) switches as fields on the LIST attestation. This *looks* like the pattern ADR-0041 rejected. It isn't — here's why:

**ADR-0041's principle, restated:** A predicate's cardinality coordination point must be permanent, coordinated, machine-readable, and located at the right layer.

**For PIN/TAG**, the predicate is the schema itself (`isPinned(target, definition)`). The coordination point is the schema UID.

**For LIST**, the predicate is not the LIST_ENTRY schema in general — it's *this specific list's membership*. The predicate is "is X in LIST L by attester A?" Each LIST has its own coordination point: its declaration attestation.

That declaration:
- **Permanent** — LIST is non-revocable; the cardinality field can never change after attest
- **Coordinated** — every reader of "list L" agrees on its UID and reads its fields the same way
- **Machine-readable** — `eas.getAttestation(L).data` exposes the fields directly; one read
- **Located at the right layer** — at the predicate's coordination object (the LIST), not on each instance (the LIST_ENTRY)

This satisfies ADR-0041's principle one level of indirection deeper than the PIN/TAG case. **The LIST attestation IS the predicate-coordination layer for that specific list.** A subgraph indexing LIST_ENTRYs reads each entry's LIST and knows the coordination layout deterministically.

**ADR-0041 supersession is NOT required.** What IS required is a sibling ADR documenting this reconciliation so a 2076 reader doesn't conclude (wrongly) that ADR-0041 was violated. That sibling ADR is the LIST ADR itself.

---

## Use case walkthrough

Confirming the design handles the use cases that drove the requirements.

### MySpace top-8 friends (ranked, no-dupes, addresses)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR,
      maxEntries=8, allowIntrinsic=false
LIST_ENTRY × 8: target=friend_addr, weight=rank (1=highest)
```

Consumer: `listReader.entries(top8, alice, 0, 8)` returns all 8, ordered by insertion. Client sorts by weight in memory. O(1) "is X in Alice's top 8?" via `isMember`.

### NFT allowlist (no-dupes, addresses, on-chain read)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR
LIST_ENTRY × N: target=member_addr, weight=0
```

Marketplace contract: `listReader.isMember(allowlist, curator, bytes32(uint256(uint160(msg.sender))))` — single SLOAD, ~4k gas.

### Letterboxd top-10 films with ratings (ranked, no-dupes, typed, per-entry metadata)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=SCHEMA,
      targetSchema=FILM_SCHEMA, maxEntries=10
LIST_ENTRY × 10: target=film_uid, weight=rank
  PROPERTY on each LIST_ENTRY: rating="X/10"
```

Per-entry rating is independent of the film's intrinsic year (PROPERTY on film UID).

### Spotify-style playlist with repeats (ranked, duplicates-allowed, typed)

```
LIST: allowsDuplicates=true, appendOnly=false, targetType=SCHEMA,
      targetSchema=DATA_SCHEMA
LIST_ENTRY × N: target=song_data_uid, weight=position
```

"Waterfalls" can appear 3 times. `isMember(playlist, alice, waterfalls_uid)` returns true; `countOf(...)` returns 3.

### Shopping list with intrinsic items (unordered, no-dupes, ANY, intrinsic-allowed)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ANY,
      allowIntrinsic=true, maxEntries=0
LIST_ENTRY × N: target=bytes32(0), weight=N
  PROPERTY on each LIST_ENTRY: name="milk", status="to-buy"
```

The list permits intrinsic entries (target=0). The item identity lives in the PROPERTY name on the LIST_ENTRY UID. Bob marks "milk" as bought → PROPERTY on his LIST_ENTRY changes status to "bought" (or he revokes the entry; non-append-only).

### Software version registry (append-only, typed, capped or uncapped)

```
LIST: allowsDuplicates=false, appendOnly=true, targetType=SCHEMA,
      targetSchema=RELEASE_SCHEMA, maxEntries=0
LIST_ENTRY × N: target=release_uid, weight=release_timestamp
```

Version 1.2.3 is permanent. If buggy, attach a `deprecated=true` PROPERTY to the LIST_ENTRY — the entry stays in the list (dependents can still reference v1.2.3) but consumers see the signal. NPM/crates.io model.

### DAO delegate weighted slate (ranked, no-dupes, addresses, capped)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR,
      maxEntries=15
LIST_ENTRY × ≤15: target=delegate_addr, weight=delegation_amount
```

Governance contract iterates the slate, multiplies vote weight by each delegate's allocation share. Type confidence: every target is an address; the governance contract `address(uint160(uint256(entry.target)))` without validation.

---

## What's deferred and why

**Generic constraint-callback / extension mechanism (ADR-0043).** Three external reviewers killed it in round 17: solves a non-problem inside a frame that presupposed it was needed. Stays deferred. If future use cases genuinely need extension, they get their own purpose-built schema following this design's pattern.

**Cross-attester merged on-chain view.** ("Show me the union of Alice's and Bob's lists at this name.") Per-attester editions ARE the kernel model; merging is presentation/composition logic that lives in clients or subgraphs. On-chain merge would force a viewer-sovereignty violation. Deferred indefinitely.

**On-chain reverse-lookup "what lists contain X?"** Maintaining this index requires writes proportional to the cardinality of (target × list × attester) — quadratic-ish state growth. Subgraphs handle this efficiently off-chain. The on-chain "X in list L by A?" check (O(1)) covers the most-frequent use case (DAO checks msg.sender against a known list); cross-list scans are subgraph queries.

**Mainnet 50-year freeze.** This design targets devnet; mainnet freeze happens months later. The 50-year test will be applied rigorously then. Devnet usage will surface issues that pure design review cannot.

---

## Open concerns / honest ugly bits

Things we want external reviewers to attack.

### 1. Two new schemas + two new resolvers is real Etched surface

EFS goes from 7 schemas to 9. The reconciliation argument (LIST as predicate-coordination layer) is sound but adds complexity to a 2076 reader's mental model. A reviewer who can show how to do this with one schema (or zero — extending TAG with a sibling resolver) without losing a MUST capability would dissolve significant complexity.

### 2. `address(0)` encoding for ADDR-typed lists

The current encoding is `target = bytes32(uint160(addr))`. For `addr = address(0)`, this yields `target = bytes32(0)`, which collides with the intrinsic-item sentinel. The resolver pseudocode above sketches a fix (high-bit sentinel for ADDR encoding), but this is the place I'm least sure. Options:

- **A**: Reject `address(0)` despite the locked requirement ("address(0) is valid"). Honest but goes against the lock.
- **B**: Use a sentinel-bit encoding for ADDR (e.g., `bytes32(uint256(uint160(addr)) | (1 << 160))`). Distinguishes "this is an address" from "this is empty/intrinsic" cleanly but uglier in tooling.
- **C**: Forbid intrinsic entries on ADDR-typed lists structurally (already enforced by `allowIntrinsic ⇒ targetType=ANY`) and accept that ADDR-typed lists can have `target=bytes32(0)` only when it actually means `address(0)`. The resolver still needs to distinguish; this only works if we trust the LIST's `allowIntrinsic` flag.
- **D**: Add a separate `address recipient` field on LIST_ENTRY, used only for ADDR-typed lists. Cleaner but adds a field.

Recommendation: **C** if we can prove the type-check ordering works; **D** if not. Reviewer input wanted.

### 3. Duplicates-allowed `isMember` semantics

For a duplicates-allowed list with target X appearing 3 times, `isMember(list, attester, X)` returns true (count > 0). `countOf(...)` returns 3. Is there a real consumer where this causes correctness bugs? Should we expose only `countOf` and let consumers compare to 0?

### 4. State growth for append-only uncapped lists

Worst case: an attacker creates an `appendOnly=true, maxEntries=0` LIST and spams entries. Per-attester storage liability is real. Mitigation: each attester pays their own gas; storage is keyed `[listUID][attester]` so attackers can't bloat other curators' state. But a curator's own genuine append-only list (versioning) has unbounded growth over decades. Acceptable?

### 5. `_entryCount` cleanup on revoke for NO_DUPES + revocable lists

Mechanical but needs careful testing. Sequence: attest E1 with target X (count=1) → revoke E1 (count=0) → attest E2 with target X (must succeed). Resolver pseudocode handles this via decrement on revoke, but the test matrix needs to cover all permutations.

### 6. Resolver cache poisoning

`_decl[listUID]` is hydrated from `eas.getAttestation(listUID)` on first LIST_ENTRY write. Because LIST is non-revocable and its data is immutable, the cache is correct forever. But: if an attacker can attest a LIST_ENTRY pointing at a `listUID` that doesn't exist yet, then later create the LIST with that exact UID... EAS UIDs are content-derived; this would require finding a hash collision. Not feasible. Confirmed safe but worth documenting as a load-bearing assumption.

### 7. The frame question

We've spent 18 rounds on this design. The frame has shifted four times:
- "lists are folders" (R11-12) → unwound
- "free-floating LIST is enough" (R13-14) → refined
- "TAG-with-weight covers it" (R15-16) → ADR-0043 attempt
- "constraint callbacks" (R17) → rejected
- "LIST + LIST_ENTRY with dedicated resolver" (R18) → current

Each prior frame felt right inside the room. What's the next-frame question we haven't asked?

---

## Field-set decisions

### Locked (no further iteration)

- LIST options expressed as **explicit bools and discrete enum values** (no bitfields)
- `targetType` as enum `0=ANY, 1=ADDR, 2=SCHEMA` (not bitfield)
- LIST attestation is **non-revocable**
- LIST_ENTRY is **revocable** (resolver rejects when LIST.appendOnly=true)
- `listUID` is in LIST_ENTRY's data payload, not `refUID`
- `target` is an explicit field on LIST_ENTRY (admits attestation UID, address encoding, or sentinel-zero)
- `weight` is always present on LIST_ENTRY (unordered readers ignore)
- **Stateless `ListReader` view contract** as the documented consumer ABI
- Per-entry metadata via **standard PROPERTY-on-attestation pattern**, scoped to LIST_ENTRY UID
- `address(0)` is a valid target for ADDR-typed lists (encoding details TBD per Open Concern §2)
- `maxEntries` included as a `uint32` field on LIST (0 = uncapped)
- `allowIntrinsic` is a separate bool, required to be true for `target=bytes32(0)` entries

### Open (pending external review)

- `address(0)` encoding mechanism (Open Concern §2 — options A/B/C/D)
- Whether to expose `countOf` only or both `isMember` + `countOf` (Open Concern §3)
- Exact event schema and indexed parameter choices for `ListAttested` / `ListEntryAttested` / `ListEntryRevoked`
- Whether to defer or include reverse-target lookup as a NICE (currently deferred)

---

## Frame history recap

Five frame-level refinements across 18 rounds:

- **Round 11-12**: lists are folders → unwound (unification didn't match the graph model)
- **Round 13-14**: free-floating LIST attestation + typed list anchors + PIN placement
- **Round 15-16**: schema simplification + principled editions stance + SortOverlay TAG-source + entry-anchor + weight TAG (3 attestations per entry)
- **Round 17**: constraint-callback / IEFSConstraintCallback mechanism (ADR-0043) → rejected by 3 external reviewers (wrong abstraction)
- **Round 18** (this design): LIST + LIST_ENTRY with dedicated `ListEntryResolver` enforcing all declared options at write time; single attestation per entry; per-entry metadata via standard PROPERTY pattern on LIST_ENTRY UID

The pattern across all five: agents converge inside a frame; humans question the frame. Round-18's convergence was validated by 4-of-5 independently-framed parallel agents arriving at the same architecture — but the convergence is internal-only; external review has not yet seen this design.

---

## Open questions for human / external review

1. Should `address(0)` encoding use a sentinel-bit (Open Concern §2 option B/D), live with the collision (option C), or break the lock and reject `address(0)` (option A)?
2. Should `isMember` return bool, or should we expose only `countOf(...) > 0`?
3. Is the schema-count cost (7 → 9) justified, or should we attempt a one-schema or extend-TAG variant?
4. What's the next-frame question we haven't asked?
