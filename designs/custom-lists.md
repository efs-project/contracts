# EFS Lists — Design

**Status:** Draft (round 18d — schema field strings GO from all three confirmation reviewers; ListReader typed-accessor ABI hardened with curator+schema+active checks per Codex; emit arg order fixed; state-growth overclaim corrected. Schema is freeze-ready; reader contract is Durable/redeployable.)
**Date:** 2026-05-28
**Permanence-tier:** Etched-adjacent (introduces two new EAS schemas; the data model is permanent post-mainnet freeze)
**Authors:** Claude Sonnet 4.7 (round-18 convergence synthesis; 17 prior rounds with Codex GPT-5, Gemini 2.5 Pro, and fresh-Claude review passes) + James Carnley (architectural direction; requirements crystallization; final-frame decisions)
**Related:** ADR-0007, ADR-0025, ADR-0030, ADR-0033, ADR-0034, ADR-0038, ADR-0041, ADR-0042; specs/02, specs/03, specs/06, specs/07
**Notes / scratchpad:** [`custom-lists_notes.md`](./custom-lists_notes.md) — design history through 18 rounds, parked ideas, rejected reframes
**Supersedes:** rounds 11-17 (entry-anchor + weight-TAG model). Historical content preserved in notes file.

---

## TL;DR

**Two new schemas: `LIST` (declaration, non-revocable) + `LIST_ENTRY` (membership, revocable, gated by `ListEntryResolver`).** All declared list options — duplicates policy, target type, append-only, capped — are enforced at write time by the resolver. Smart contracts can iterate active entries with O(N) reads and full type confidence. O(1) membership check for all modes. (Intrinsic items use `targetType=ANY` with opaque member keys — there is no separate "intrinsic" flag.)

```
                   ┌─────────────────────────────────────────────────────┐
LIST (declaration) │  allowsDuplicates, appendOnly, targetType,          │
                   │  targetSchema, maxEntries                            │
                   │  refUID = 0x0 (free-floating, like DATA)            │
                   │  revocable: false                                    │
                   │  resolver: ListResolver (field-shape validation)     │
                   └─────────────────────────────────────────────────────┘
                                          ▲
                                          │ (referenced via field, not refUID)
                                          │
                   ┌─────────────────────────────────────────────────────┐
LIST_ENTRY         │  bytes32 listUID                                    │
(membership)       │  bytes32 target  (per-mode encoding — see below)    │
                   │  int256  weight  (opaque metadata; consumer-defined)│
                   │  revocable: true (resolver rejects revoke if list   │
                   │              is appendOnly)                          │
                   │  resolver: ListEntryResolver                         │
                   │                                                      │
                   │  Per-mode encoding:                                  │
                   │   ADDR:   target=0,   recipient=addr (incl. addr 0) │
                   │   SCHEMA: target=UID, recipient=0                    │
                   │   ANY:    target=opaque key (nonzero), recipient=0   │
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

Rounds 11-16 explored an **entry-anchor model**: each entry was an anchor child of the LIST UID, with a PIN to the target and a weight TAG for ordering (3 attestations per entry). Round 17 attempted to plug write-time enforcement gaps with a generic constraint-callback mechanism (ADR-0045) — three external reviewers independently returned RED on the same finding: the mechanism solved a non-problem inside a frame that presupposed it was needed.

Round 18 started by crystallizing requirements with the human (MUST/NICE/DEFERRED) and then ran 5 parallel agents with different design framings (defend round-16; refine LIST+LIST_ENTRY; greenfield; consumer-first; hybrid). **4 of 5 independently converged on the LIST + LIST_ENTRY architecture documented here.** The round-16 defender admitted MEDIUM confidence and recommended a head-to-head bake-off; the hybrid agent collapsed to LIST+LIST_ENTRY when its "escape hatch" was removed.

**What round-16 couldn't deliver without surgery:**
- `targetType` write-time enforcement: EdgeResolver doesn't validate target.schema against any declared field
- `appendOnly` write-time enforcement: requires cross-resolver coordination
- `allowsDuplicates=false` enforcement: relies on convention (target-derived naming) + ADR-0025, not direct enforcement
- All three together: not achievable without polluting EdgeResolver (shared kernel) or introducing the constraint-callback mechanism that ADR-0045 deferred

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

- Generic constraint-callback / extension mechanism (ADR-0045 — wrong abstraction)
- Cross-attester merged on-chain view (client/SDK concern)
- On-chain reverse-lookup index ("what lists contain X?" for arbitrary X — subgraph concern)
- Mainnet 50-year freeze (devnet ships first; mainnet freeze applies later)

### Validation model

**Write-time, by resolver.** When a `LIST_ENTRY` is attested, `ListEntryResolver` validates against the parent `LIST`'s declared options before storage. Once written, downstream readers trust without re-validation.

**Encoding by target type** (resolves the round-18 `address(0)` collision):

- **ADDR-typed lists** use EAS's native `recipient` field. The LIST_ENTRY's `target` field MUST be `bytes32(0)`. `address(0)` is fully supported (recipient field carries the address; sentinel-bit hacks rejected).
- **SCHEMA-typed lists** put the target attestation UID in the `target` field. `recipient` MUST be `address(0)`.
- **ANY-typed lists** put an opaque caller-chosen nonzero member key in the `target` field. The resolver does NOT check existence — `target` is an opaque identifier, not necessarily an attestation UID. `recipient` MUST be `address(0)`. Conventions for member keys (e.g., `keccak256(abi.encode("efs-list-intrinsic", payload))`) are documented in the SDK guide.

This structural separation means each `targetType` uses a different EAS field for its primary identity, and consumers branch on `targetType` to decide which field to read. There is no in-band polymorphism on a single field.

**Consequence for generic EAS indexers (document loudly).** Because ADDR-typed entries put the listed address in EAS's native `recipient` field, a generic EAS indexer (one that doesn't know about EFS lists) will interpret a LIST_ENTRY as "an attestation *received by* that address." The listed address did not consent to being listed and is not the subject of the attestation in any meaningful sense — it's a membership key that happens to live in the `recipient` slot. Anyone building dashboards or notifications off raw EAS `recipient` indexing must special-case the LIST_ENTRY schema UID, or they'll surface "you received an attestation" noise for every allowlist/slate an address appears on. This is an accepted cost of reusing the native field (the alternative — a sentinel-bit-packed `target` — was rejected as worse); it just needs to be visible to integrators.

---

## Architecture

### Schemas

**`LIST` — declaration (the list's identity and configuration)**

```solidity
LIST schema:
  bool    allowsDuplicates    // false = no-duplicates enforced at write time
  bool    appendOnly          // true  = entry revokes rejected by resolver
  uint8   targetType          // 0=ANY (opaque member key), 1=ADDR, 2=SCHEMA
  bytes32 targetSchema        // non-zero iff targetType==SCHEMA
  uint32  maxEntries          // 0 = uncapped; per-attester cap.
                              //   Required (>0) when appendOnly && allowsDuplicates.
revocable: false
resolver:  ListResolver       // field-shape validation only (see below)
refUID:    bytes32(0)          // free-floating, like DATA
recipient: address(0)          // never directed
```

**Field rationale:**

- `allowsDuplicates` — bool, not bitfield. Programmers thank us in 2076.
- `appendOnly` — bool, list-level. When true, the resolver rejects every entry revoke for this list. Use cases: software version registries, on-chain receipts, immutable references. Pairs with per-entry deprecation PROPERTYs (NPM/crates.io model — entries can be flagged "deprecated" without being removed). **When combined with `allowsDuplicates=true`, `maxEntries` MUST be non-zero** — append-only multisets have no natural upper bound and would permit unbounded state growth.
- `targetType` — uint8 enum: `0=ANY`, `1=ADDR`, `2=SCHEMA`. Each value selects a different *encoding* (which EAS field carries the entry's identity) and a different *validation* (whether existence is checked):
  - **ANY**: entry identity is in `LIST_ENTRY.target` as an opaque nonzero bytes32 member key. No existence check.
  - **ADDR**: entry identity is in `LIST_ENTRY.recipient` (EAS native field). `address(0)` valid. No existence check.
  - **SCHEMA**: entry identity is in `LIST_ENTRY.target` as an attestation UID. Existence + schema match enforced.
- `targetSchema` — non-zero iff `targetType==SCHEMA`; the EAS schema UID every entry's target must match.
- `maxEntries` — uint32, 0 = uncapped. Per-attester (matches editions model). **Primary rationale: contract-safety and bounded-list semantics.** On-chain consumers that iterate a list need a schema-visible upper bound to protect themselves from block-gas-limit DoS; a capped list is a promise the consumer can rely on. (Secondary: it's also impossible to add later without a new schema UID — but the load-bearing reason is the bound itself, not future-proofing.) **Required >0 when `appendOnly && allowsDuplicates`** — that combination is the only one where unbounded growth is possible without any other constraint.

**Note on intrinsic items:** The earlier `allowIntrinsic` flag has been REMOVED. Intrinsic items (shopping-list "milk", todo "buy groceries") use `targetType=ANY` with an opaque member key — e.g., `keccak256(abi.encode("efs-list-intrinsic", "milk"))`. This dissolves the `address(0)`/intrinsic collision the prior design had Open Concern §2 about. Documented intrinsic-key derivation conventions live in the SDK guide so clients agree on key encoding.

**Why these fields are on LIST (not on each LIST_ENTRY):** The list's *configuration* is the predicate-coordination layer (see ADR-0041 reconciliation below). Putting it on each entry would be redundant and contradictory if entries diverged. Putting it on LIST once, with LIST being non-revocable, means every entry reader can derive the constraints from one immutable source.

**Why LIST is non-revocable:** The list's *identity* is permanent. Deletion is per-entry (revoking entries) or impossible (when `appendOnly=true`). A user who wants to abandon a list stops adding to it; the declaration persists as historical fact. This matches DATA (also non-revocable — content identity is permanent; specific placements via MIRROR are revocable).

---

**`LIST_ENTRY` — membership (one entry in one list)**

```solidity
LIST_ENTRY schema:
  bytes32 listUID             // the LIST attestation this entry belongs to
  bytes32 target              // SCHEMA: attestation UID; ANY: opaque member key (nonzero); ADDR: MUST be 0
  int256  weight              // opaque int256 metadata; consumer interprets (see below)
revocable: true               // resolver rejects revoke when LIST.appendOnly=true
resolver:  ListEntryResolver

Per-mode encoding (enforced by resolver at write time):
  ADDR-typed lists:
    target    = bytes32(0)     (must be zero)
    recipient = the address    (EAS native field; address(0) valid)
    refUID    = bytes32(0)
  SCHEMA-typed lists:
    target    = attestation UID (must exist; must match LIST.targetSchema)
    recipient = address(0)
    refUID    = bytes32(0)
  ANY-typed lists:
    target    = opaque member key (must be nonzero bytes32; no EAS existence check)
    recipient = address(0)
    refUID    = bytes32(0)

Plus universal lifecycle invariants (enforced by resolver):
  revocable        = true            (NOT allowed to be revocable=false at the attestation level)
  expirationTime   = 0               (entries never expire)
```

**Field rationale:**

- `listUID` — explicit field, not `refUID`. Using `refUID` would conflate "this entry is in this list" with EAS's generic refUID semantics. Putting it in the data payload makes indexers' jobs explicit.
- `target` — explicit field for the entry's identity *when ADDR is not the mode*. Two encodings:
  - **SCHEMA mode**: attestation UID. Existence + schema-match validated at write time.
  - **ANY mode**: opaque nonzero bytes32 (any 32-byte member key the curator picks). No existence check; opaque identity per the member-key reframe.
  - **ADDR mode**: must be `bytes32(0)` (address lives in the EAS `recipient` field instead).
- `weight` — opaque int256 metadata. The kernel does not interpret it. Consumers and curators must agree on meaning out-of-band — common conventions: rank position, score, allocation share, timestamp, vote weight. SORT_INFO (when present) is one such interpretation (ordering); absence of SORT_INFO does NOT mean weight is meaningless. The doc-level convention is "consumers documented in their own ADR/spec how they interpret weight." Sparse int256 spacing gives infinite room for re-ordering without rewriting other entries.

**Lifecycle invariants enforced by ListEntryResolver** (closes external review BLOCKING item B3):

The resolver rejects entry attestations that don't satisfy the lifecycle shape, because EAS permits attestation-level overrides that would corrupt resolver state:

| Field | Required value | Why |
|---|---|---|
| `revocable` (per-attestation) | `true` | A `revocable=false` entry can never be removed even from non-append-only lists, breaking `maxEntries` and no-dupe slot reuse. |
| `expirationTime` | `0` | Expiring entries silently leave but resolver state still counts them. |
| `refUID` | `bytes32(0)` | `listUID` is in the data payload; mixing with EAS's generic refUID semantic invites indexer confusion. |
| ADDR mode: `target` | `bytes32(0)` | Address lives in recipient; nonzero target is a misencoding. |
| ADDR mode: `recipient` | any address (incl. 0) | The address being listed; `address(0)` is permitted. |
| SCHEMA mode: `target` | existing UID with matching schema | Type confidence at iteration depends on this. |
| SCHEMA mode: `recipient` | `address(0)` | recipient field unused. |
| ANY mode: `target` | nonzero bytes32 | The opaque member key. |
| ANY mode: `recipient` | `address(0)` | recipient field unused. |

**Why a single attestation per entry (not 3 like round-16):** Round-16's entry-anchor + PIN + weight-TAG required 3 attestations per entry. The flat LIST_ENTRY needs 1. Per-entry metadata still uses the standard PROPERTY pattern (3 attestations per metadata field) but only when actually wanted — most entries don't have metadata.

**Why revocable:** Non-append-only lists need revocable entries. The resolver branches on the parent LIST's `appendOnly` flag: revocable in spirit, rejected at write-time if the list says append-only.

---

### Resolver behavior

#### `ListResolver` (on LIST schema)

Field-shape validation only. Does NOT maintain state. The expensive work happens in `ListEntryResolver`.

```solidity
function onAttest(Attestation calldata a, uint256) returns (bool) {
    require(a.data.length == EXPECTED_LIST_DATA_LENGTH, "bad LIST payload");
    require(a.revocable == false,       "LIST must be non-revocable");
    require(a.expirationTime == 0,      "LIST must not expire");
    require(a.refUID == bytes32(0),     "LIST must be free-floating");
    require(a.recipient == address(0),  "LIST must not be directed");

    (
      bool allowsDuplicates,
      bool appendOnly,
      uint8 targetType,
      bytes32 targetSchema,
      uint32 maxEntries
    ) = abi.decode(a.data, (bool, bool, uint8, bytes32, uint32));

    require(targetType <= 2, "invalid targetType");

    // (targetType, targetSchema) coherence
    if (targetType == 2 /* SCHEMA */) {
        require(targetSchema != bytes32(0), "SCHEMA targetType requires targetSchema");
    } else {
        require(targetSchema == bytes32(0), "non-SCHEMA targetType must have zero targetSchema");
    }

    // Forbid the unbounded combination: append-only + duplicates-allowed + uncapped
    if (appendOnly && allowsDuplicates) {
        require(maxEntries != 0, "appendOnly + allowsDuplicates requires maxEntries cap");
    }

    emit ListAttested(
      a.uid, a.attester,
      allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries
    );
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
}

// Cache the LIST's declaration on first touch (cold path: 1 EAS read; warm: 1 SLOAD)
mapping(bytes32 listUID => CachedListDecl) private _decl;

// Per-entry record stored INLINE in the iteration array. "Wide" storage layout
// (decided 2026-05-28): on-chain consumers read (identityKey, weight) directly
// without an eas.getAttestation() per entry. This mirrors ADR-0041's deliberate
// widening of EdgeResolver._activeByAAS from bytes32[] to TagEntry[] — same reason
// (LIST requirement #10: smart contracts iterate entries on-chain). The identityKey
// being stored inline also subsumes a separate _entryIdentityKey side map: revoke
// reads it from the array element directly.
//
//   identityKey semantics:
//     ADDR-typed:   bytes32(uint160(recipient))
//     SCHEMA-typed: target (the attestation UID)
//     ANY-typed:    target (the opaque member key)
struct EntryRecord {
    bytes32 entryUID;       // the LIST_ENTRY attestation UID (for metadata lookups)
    bytes32 identityKey;    // membership identity (see semantics above)
    int256  weight;         // opaque ranking metadata
}

// Per-list, per-attester active entries (insertion order; iteration source).
mapping(bytes32 listUID => mapping(address attester => EntryRecord[])) private _entries;

// O(1) membership + no-dupes counter — keyed by the canonical "identity key".
// Serves two purposes simultaneously:
//   - enforces "count == 0" when !allowsDuplicates (no-dupe gate)
//   - provides "count > 0" for membership check
mapping(bytes32 listUID => mapping(bytes32 identityKey => mapping(address attester => uint256))) private _entryCount;

// Swap-and-pop index for revoke: entryUID => (position in _entries[list][attester]) + 1
mapping(bytes32 entryUID => uint256) private _entryPosPlusOne;
```

**Storage-layout note (Etched):** this "wide" layout is locked for v1. The fields baked into `EntryRecord` are part of the resolver bytecode → CREATE2 address → LIST_ENTRY schema UID. Trimming it later (e.g., dropping `weight` if on-chain ranking turns out unused) is free on devnet but requires a new schema UID after mainnet freeze. Devnet usage is the window to confirm the fields earn their keep; the default is to over-provision because under-provisioning is a functional wall for on-chain iterators (block-gas-limit), whereas over-provisioning is only wasted write gas.

`onAttest`:

```solidity
function onAttest(Attestation calldata a, uint256) returns (bool) {
    require(a.data.length == EXPECTED_ENTRY_DATA_LENGTH, "bad LIST_ENTRY payload");

    // Lifecycle invariants (close BLOCKING B3 from external review)
    require(a.revocable == true,      "LIST_ENTRY must be revocable");
    require(a.expirationTime == 0,    "LIST_ENTRY must not expire");
    require(a.refUID == bytes32(0),   "LIST_ENTRY must not use refUID (listUID is in payload)");

    (bytes32 listUID, bytes32 target, int256 weight) =
        abi.decode(a.data, (bytes32, bytes32, int256));
    require(listUID != bytes32(0), "missing listUID");

    // Hydrate declaration on first touch (LIST is non-revocable, immutable; cache valid forever)
    CachedListDecl memory d = _decl[listUID];
    if (!d.exists) {
        Attestation memory L = eas.getAttestation(listUID);
        require(L.schema == LIST_SCHEMA_UID, "listUID is not a LIST");
        (d.allowsDuplicates, d.appendOnly, d.targetType, d.targetSchema, d.maxEntries) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        d.exists = true;
        _decl[listUID] = d;
    }

    // Per-mode encoding + identity-key derivation
    bytes32 identityKey;

    if (d.targetType == 1 /* ADDR */) {
        require(target == bytes32(0),         "ADDR mode: target must be 0 (use recipient)");
        // a.recipient holds the address; address(0) is permitted
        identityKey = bytes32(uint256(uint160(a.recipient)));

    } else if (d.targetType == 2 /* SCHEMA */) {
        require(a.recipient == address(0),    "SCHEMA mode: recipient must be 0");
        require(target != bytes32(0),         "SCHEMA mode: target must be set");
        Attestation memory t = eas.getAttestation(target);
        require(t.uid != bytes32(0),          "SCHEMA mode: target attestation missing");
        require(t.schema == d.targetSchema,   "SCHEMA mode: target schema mismatch");
        // NOTE: We do NOT check t.revocationTime. Entries are immune to target lifecycle —
        // a list entry remains valid even if the underlying target attestation is later
        // revoked. Consumers that care about target liveness should check revocation
        // status themselves at read time. This policy matches the editions principle:
        // each attester's view is permanent; downstream churn doesn't unwind history.
        identityKey = target;

    } else /* ANY */ {
        require(a.recipient == address(0),    "ANY mode: recipient must be 0");
        require(target != bytes32(0),         "ANY mode: target must be nonzero member key");
        // No existence check — target is opaque per the member-key reframe
        identityKey = target;
    }

    // No-duplicates enforcement (per-attester edition)
    if (!d.allowsDuplicates) {
        require(_entryCount[listUID][identityKey][a.attester] == 0, "duplicate identity");
    }

    // Cap enforcement (per-attester)
    if (d.maxEntries != 0) {
        require(_entries[listUID][a.attester].length < d.maxEntries, "list full");
    }

    // Append wide record + index (identityKey + weight stored inline for cheap on-chain reads)
    _entries[listUID][a.attester].push(EntryRecord({
        entryUID:    a.uid,
        identityKey: identityKey,
        weight:      weight
    }));
    _entryPosPlusOne[a.uid] = _entries[listUID][a.attester].length;
    _entryCount[listUID][identityKey][a.attester] += 1;

    // Event arg order matches the indexed declaration: (listUID, attester, identityKey) indexed.
    emit ListEntryAttested(listUID, a.attester, identityKey, a.uid, d.targetType, weight);
    return true;
}
```

`onRevoke`:

```solidity
function onRevoke(Attestation calldata a, uint256) returns (bool) {
    require(a.data.length == EXPECTED_ENTRY_DATA_LENGTH, "bad LIST_ENTRY payload");

    // Idempotency check FIRST: if this entry was never indexed (e.g., stale revoke
    // on an attestation our state doesn't know about — possible after resolver
    // redeploy or in test scenarios), bail before touching anything else.
    uint256 pp1 = _entryPosPlusOne[a.uid];
    if (pp1 == 0) return true;

    (bytes32 listUID, , ) = abi.decode(a.data, (bytes32, bytes32, int256));

    CachedListDecl memory d = _decl[listUID];
    // d.exists MUST be true at this point — we wouldn't have an _entryPosPlusOne
    // unless onAttest ran successfully (which hydrates _decl). Defensive require:
    require(d.exists, "unknown listUID (resolver state inconsistency)");

    // Append-only enforcement: reject revocation entirely
    require(!d.appendOnly, "list is append-only");

    // Swap-and-pop. identityKey is read from the array record inline — no side map.
    uint256 idx = pp1 - 1;
    EntryRecord[] storage arr = _entries[listUID][a.attester];
    bytes32 identityKey = arr[idx].identityKey;
    uint256 last = arr.length - 1;
    if (idx != last) {
        // Direct copy (Gemini nit): avoids a local storage-pointer alias; read the
        // moved element's uid AFTER the copy so the index update is unambiguous.
        arr[idx] = arr[last];
        _entryPosPlusOne[arr[idx].entryUID] = idx + 1;
    }
    arr.pop();
    delete _entryPosPlusOne[a.uid];
    _entryCount[listUID][identityKey][a.attester] -= 1;

    // Event arg order matches the indexed declaration.
    emit ListEntryRevoked(listUID, a.attester, identityKey, a.uid, d.targetType);
    return true;
}
```

**Reentrancy note:** `eas.getAttestation()` is a pure storage read in EAS 1.x — no resolver callbacks fire. The resolver has no untrusted external calls and no ETH-handling surface. Documented as load-bearing assumption; if EAS adds callback hooks in a future version, re-audit. (Not blocking for v1.)

**Lifecycle hardening notes (closes external review SF5):**
- **Both resolvers stay non-payable.** Do not override EAS's `isPayable` (default false). An implementer copying the pseudocode must not add a payable override — list operations never accept ETH, and a payable resolver is needless attack surface.
- **Append-only is enforced only against on-chain `revoke` / `multiRevoke` / `revokeByDelegation`.** EAS's off-chain timestamp/revocation registry never invokes the resolver, so it cannot touch resolver state — an off-chain "revocation" of a LIST_ENTRY is invisible to the kernel and does not remove the entry. This is correct (append-only means append-only on-chain) but a 2076 reader should not have to rediscover it.

**Events** (frozen as part of ABI contract — subgraphs and indexers depend on this shape):

```solidity
event ListAttested(
    bytes32 indexed listUID,
    address indexed attester,
    bool    allowsDuplicates,
    bool    appendOnly,
    uint8   indexed targetType,
    bytes32 targetSchema,
    uint32  maxEntries
);

event ListEntryAttested(
    bytes32 indexed listUID,
    address indexed attester,
    bytes32 indexed identityKey, // recipient (ADDR), target UID (SCHEMA), or member key (ANY)
    bytes32 entryUID,
    uint8   targetType,          // denormalized from parent LIST for indexer convenience
    int256  weight
);

event ListEntryRevoked(
    bytes32 indexed listUID,
    address indexed attester,
    bytes32 indexed identityKey,
    bytes32 entryUID,
    uint8   targetType
);
```

**Indexed-topic choice (closes Codex #3):** non-anonymous events allow 3 indexed topics. We index `listUID`, `attester`, and `identityKey` — NOT `entryUID`. Rationale: the natural raw-RPC log filter is "show me all entries where member X appears in list L" (`listUID + identityKey`), which directly serves the "is X listed?" reverse-lookup that on-chain `countOf` answers per-(list,attester) but raw log consumers want across editions. `entryUID` is rarely a filter key (if you have the entryUID you already have the entry); it stays as data. `targetType` is denormalized into entry events so subgraphs filter and decode without a parent-LIST lookup per entry (closes adversarial review I6). This is the partial reverse-lookup the design otherwise defers to subgraphs — available now via log topics, without an on-chain index.

---

### Worked example: lifecycle of a no-dupes ADDR-typed allowlist entry

To make resolver state changes concrete, here is the full lifecycle of one entry. Curator Alice (address `0xA110…`) runs an NFT allowlist with `targetType=ADDR, allowsDuplicates=false, appendOnly=false`. Alice adds Bob (address `0xB0B…`), then later removes him.

**State before any LIST operations:**

```
_decl                 = {} (empty)
_entries              = {} (empty)
_entryCount           = {} (empty)
_entryPosPlusOne      = {} (empty)
```

**Step 1 — Alice attests the LIST.** `ListResolver.onAttest` validates field shape; LIST is non-revocable. Resolver maintains no state. LIST gets UID `0xL1`.

**Step 2 — Alice attests her first LIST_ENTRY:** `LIST_ENTRY(listUID=0xL1, target=0x0, weight=0)` with `recipient=0xB0B…`. EAS assigns entry UID `0xE1`.

`ListEntryResolver.onAttest` flow:
1. Lifecycle checks pass (`revocable=true`, `expirationTime=0`, `refUID=0`)
2. `_decl[0xL1]` cold path: reads `eas.getAttestation(0xL1)`, decodes, hydrates cache (1 EAS read + 1 SSTORE — cold cost paid by first writer)
3. `targetType=1 (ADDR)`: requires `target==0` ✓; `identityKey = bytes32(uint256(uint160(0xB0B…))) = 0x000000000000000000000000B0B…`
4. `!allowsDuplicates`: `_entryCount[0xL1][0x000…B0B][0xA110…] == 0` ✓
5. `maxEntries=0`: no cap check
6. State writes:
   - `_entries[0xL1][0xA110…].push({ entryUID:0xE1, identityKey:0x000…B0B, weight:0 })` → length now 1
   - `_entryPosPlusOne[0xE1] = 1`
   - `_entryCount[0xL1][0x000…B0B][0xA110…] = 1`

**State after Step 2:**

```
_decl[0xL1]                     = { exists, allowsDup=false, appendOnly=false,
                                    targetType=1, targetSchema=0x0, maxEntries=0 }
_entries[0xL1][0xA110…]         = [ { 0xE1, 0x000…B0B, 0 } ]
_entryCount[0xL1][0x000…B0B][0xA110…] = 1
_entryPosPlusOne[0xE1]          = 1
```

A marketplace contract reading `listReader.countOf(0xL1, 0xA110…, identityKeyForAddress(0xB0B…))` returns `1`. Membership check passes.

**Step 3 — Alice attempts to add Bob again** (`recipient=0xB0B…`): EAS assigns entry UID `0xE2`. `ListEntryResolver.onAttest`:
1. Lifecycle checks pass
2. `_decl[0xL1]` warm path: cache hit
3. `targetType=ADDR`: `identityKey = 0x000…B0B`
4. `!allowsDuplicates`: `_entryCount[0xL1][0x000…B0B][0xA110…] == 1` ≠ 0 → **REVERT** "duplicate identity"

No state changes. Resolver correctly blocked the duplicate.

**Step 4 — Alice revokes 0xE1.** EAS calls `ListEntryResolver.onRevoke`:
1. Idempotency check: `_entryPosPlusOne[0xE1] = 1 ≠ 0` → proceed
2. Decode payload, hit cache: `_decl[0xL1].exists = true ✓`
3. `!d.appendOnly` ✓
4. `idx = 0`; read `identityKey = _entries[0xL1][0xA110…][0].identityKey = 0x000…B0B` (inline, no side map)
5. Swap-and-pop on `_entries[0xL1][0xA110…]`: only entry, so `arr.pop()` → empty
6. `delete _entryPosPlusOne[0xE1]` → 0
7. `_entryCount[0xL1][0x000…B0B][0xA110…] -= 1` → 0

**State after Step 4:**

```
_decl[0xL1]                     = { ... unchanged ... }
_entries[0xL1][0xA110…]         = []  (empty array, still allocated)
_entryCount[0xL1][0x000…B0B][0xA110…] = 0
_entryPosPlusOne[0xE1]          = 0  (deleted)
```

Bob is now removable AND re-addable. The no-dupes slot is freed (`_entryCount = 0`); Alice can now attest `0xE3` for Bob again if she wants, and it'll succeed (`count == 0` check passes).

**Step 5 — A stale revoke of `0xE1` arrives** (e.g., transaction included twice in some adversarial scenario). EAS calls `onRevoke` again:
1. Idempotency check: `_entryPosPlusOne[0xE1] = 0` → return true (no-op)

No state changes; resolver correctly idempotent.

---

This walkthrough surfaces several invariants the design relies on:
- The resolver's state remains consistent across `attest`/`revoke` cycles (identityKey read inline from the array record during revoke — no separate side map to keep in sync).
- The no-dupes slot is correctly freed on revoke (`count → 0`).
- Stale revokes are no-ops, not reverts.
- `_decl` cache is populated cold on first entry write and is correct forever (LIST non-revocable).

**Conformance-test note (implementation):** port this exact lifecycle (attest → dup-reject → revoke → re-add → stale-revoke) into a test verbatim — it's the precise state machine the wide-storage layout touches. Add one more vector the walkthrough doesn't exercise: an ADDR-typed entry with `recipient = address(0)`, where `identityKey = bytes32(0)`. Confirm it's storable, dedup-gated, membership-checkable, and revocable like any other key (the zero-key path is the trickiest and least-walked).

---

### Smart contract reader (`ListReader`)

A stateless view contract on top of `ListEntryResolver`. Provides a stable ABI for consumers; lets the resolver evolve internal layout without breaking integrations.

`getMode` decodes the LIST attestation directly via EAS (NOT from the resolver cache). This means empty lists — those with no entries yet — return a valid mode (closes external review S3). The resolver cache exists for entry-write fast-path; it is not the source of truth for queries about declared mode.

```solidity
interface IListReader {
    struct ListMode {
        bool    exists;
        address curator;            // LIST.attester — the canonical curator address
        bool    allowsDuplicates;
        bool    appendOnly;
        uint8   targetType;          // 0=ANY, 1=ADDR, 2=SCHEMA
        bytes32 targetSchema;        // nonzero iff targetType=SCHEMA
        uint32  maxEntries;
    }

    /// Returns the list's declared configuration. Decoded directly from the LIST attestation
    /// via EAS. IMPLEMENTATION REQUIREMENT: check `L.schema == LIST_SCHEMA_UID` FIRST and
    /// return `exists=false` WITHOUT decoding `L.data` on mismatch (closes external review SF2 —
    /// an attacker-chosen non-LIST attestation whose 96-byte payload happens to decode to a
    /// trusted-looking mode must NOT pass the secure-consumer guard). Works for empty lists.
    function getMode(bytes32 listUID) external view returns (ListMode memory);

    /// Number of active entries for (list, attester). O(1).
    function length(bytes32 listUID, address attester) external view returns (uint256);

    /// Page of active entries. Insertion order. With the wide storage layout, every field
    /// here is read from the resolver's own EntryRecord array — NO per-entry
    /// eas.getAttestation(). One bulk SLOAD-walk over the page; genuinely O(N) cheap.
    /// `identityKey` is the membership key (recipient for ADDR, UID for SCHEMA, member key
    /// for ANY); `targetType` is denormalized from the parent LIST.
    /// CAVEAT: pagination is NOT snapshot-isolated across separate calls — a revoke between
    /// page N and page N+1 can swap-and-pop a tail entry into an already-read slot. For
    /// consistent multi-call reads, pin to a block number (closes external review SF3).
    struct Entry {
        bytes32 entryUID;
        uint8   targetType;          // denormalized from LIST.targetType
        bytes32 identityKey;         // recipient (ADDR), target UID (SCHEMA), or member key (ANY)
        int256  weight;
    }
    function entries(bytes32 listUID, address attester, uint256 start, uint256 len)
        external view returns (Entry[] memory);

    /// Typed accessors — SAFE-BY-CONSTRUCTION decode of a single entry. Each takes the
    /// trusted `curator` explicitly and reverts unless ALL of:
    ///   1. listUID is the expected mode (ADDR / SCHEMA / ANY)
    ///   2. e.schema == LIST_ENTRY_SCHEMA_UID            (it's actually a list entry)
    ///   3. e.attester == curator                        (it's in the TRUSTED curator's edition)
    ///   4. e.revocationTime == 0                        (it's currently active)
    ///   5. decoded entryListUID == listUID              (it belongs to this list)
    ///
    /// Checks 2–4 close the same-list wrong-edition injection Codex flagged: without the
    /// curator+schema+active checks, Mallory could attest her own LIST_ENTRY against a
    /// trusted listUID (permissionless editions allow this) with recipient=Mallory, and a
    /// victim calling targetAsAddress(L, entryUID) would receive Mallory's address as if the
    /// trusted curator had listed it. Requiring `e.attester == curator` scopes the decode to
    /// the trusted edition; the curator comes from getMode(listUID).curator or a contract
    /// constant, NEVER from the calling user.
    ///
    /// These are single-entry decode helpers. For membership/iteration use countOf / entries,
    /// which are already attester-keyed.
    /// Implementation sketch:
    ///   Attestation memory e = eas.getAttestation(entryUID);
    ///   require(e.schema == LIST_ENTRY_SCHEMA_UID, "not a list entry");
    ///   require(e.attester == curator,            "wrong curator edition");
    ///   require(e.revocationTime == 0,            "entry revoked");
    ///   (bytes32 entryListUID, bytes32 target,) = abi.decode(e.data, (bytes32,bytes32,int256));
    ///   require(entryListUID == listUID,          "entry not in this list");
    ///   // then mode-check listUID and decode target/recipient per mode

    /// Decode entry as ADDR-typed. Reverts unless ADDR-typed, entry ∈ (listUID, curator), active.
    function targetAsAddress(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (address);

    /// Decode entry as SCHEMA-typed UID. Reverts unless SCHEMA-typed, entry ∈ (listUID, curator), active.
    function targetAsUID(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (bytes32);

    /// Decode entry as ANY-typed opaque member key. Reverts unless ANY-typed, entry ∈ (listUID, curator), active.
    function targetAsMemberKey(bytes32 listUID, address curator, bytes32 entryUID)
        external view returns (bytes32);

    /// O(1) entry count for a specific identity key (== 1 for no-dupes; can be > 1 for dups).
    /// `identityKey` semantics:
    ///   ADDR mode:   bytes32(uint160(address))
    ///   SCHEMA mode: the attestation UID
    ///   ANY mode:    the opaque member key
    /// For no-dupes lists, `countOf(...) > 0` is the membership check.
    /// For dupes-allowed lists, callers must explicitly compare to 0 — there is no
    /// `isMember` bool (closes external review BLOCKING B2: bool semantics on a multiset
    /// are a footgun; force explicit comparison at the call site).
    function countOf(bytes32 listUID, address attester, bytes32 identityKey)
        external view returns (uint256);

    /// Identity-key derivation helpers — pure functions documenting the canonical
    /// encoding for each mode. Callsite documentation is the point; bytecode cost is trivial.
    function identityKeyForAddress(address a) external pure returns (bytes32);   // = bytes32(uint256(uint160(a)))
    function identityKeyForUID(bytes32 uid)   external pure returns (bytes32);   // = uid
    function identityKeyForMemberKey(bytes32 k) external pure returns (bytes32); // = k
}
```

**Consumer pattern (NFT allowlist — SECURE):**

```solidity
function buy(uint256 tokenId) external payable {
    // Curator is fixed at construction; NOT taken from caller (closes BLOCKING B4)
    IListReader.ListMode memory m = listReader.getMode(allowlistUID);
    require(m.exists && m.targetType == 1 /* ADDR */, "wrong list type");
    require(m.curator == trustedCurator, "untrusted list curator");

    // Membership check via countOf — explicit comparison, no bool footgun
    bytes32 identityKey = bytes32(uint256(uint160(msg.sender)));
    require(listReader.countOf(allowlistUID, m.curator, identityKey) > 0, "not on allowlist");

    _executePurchase(msg.sender, tokenId);
}
```

**Anti-pattern (DO NOT DO THIS):**

```solidity
function buy(uint256 tokenId, address curator) external payable {  // ❌ caller picks curator
    require(listReader.countOf(allowlistUID, curator, ...) > 0, "not on allowlist");
    // Attacker passes their own curator-edition of the same allowlistUID and bypasses.
}
```

The curator MUST be derived from a trusted source — either `LIST.attester` (when the curator is the list's original publisher) or a contract constant (when one specific curator is trusted regardless of who published the LIST UID).

**Consumer pattern (DAO weighted distribution — SECURE):**

```solidity
function distribute(uint256 pool) external {
    // Curator and listUID are constants known at construction
    IListReader.ListMode memory m = listReader.getMode(slateListUID);
    require(m.exists && m.targetType == 1 /* ADDR */, "wrong list type");
    require(m.curator == trustedSlateAuthor, "untrusted slate");

    // Bound the iteration: only iterate lists whose size is capped to a sane local max.
    // Even though the primitive permits uncapped lists, an on-chain full-iteration consumer
    // MUST protect itself from block-gas-limit DoS (closes external review SHOULD-FIX #6).
    require(m.maxEntries != 0 && m.maxEntries <= LOCAL_MAX_ITERATION, "list not safely iterable");

    uint256 n = listReader.length(slateListUID, m.curator);
    IListReader.Entry[] memory es = listReader.entries(slateListUID, m.curator, 0, n);

    // Sum ONLY the positive eligible weights, so the denominator matches what we pay out.
    // (Summing all weights then skipping negatives at payout distorts shares — Codex #5.)
    uint256 totalEligible;
    for (uint i; i < es.length; i++) {
        if (es[i].weight > 0) totalEligible += uint256(es[i].weight);
    }
    require(totalEligible > 0, "no positive weights");

    for (uint i; i < es.length; i++) {
        if (es[i].weight <= 0) continue;
        // For ADDR lists, identityKey IS the address (validated at write time).
        address recipient = address(uint160(uint256(es[i].identityKey)));
        uint256 share = (pool * uint256(es[i].weight)) / totalEligible;
        payable(recipient).transfer(share);
    }
}
```

The consumer trusts target encoding (no per-entry validation), trusts schema correctness (for SCHEMA-typed lists), and reads the entry array directly from resolver storage — `identityKey` and `weight` are inline, so there is no `eas.getAttestation()` per entry (wide storage layout). Type confidence comes from the resolver's write-time enforcement. **Smart-contract consumers should ALWAYS (1) check `m.targetType` matches expectations and (2) bound iteration to a sane `maxEntries`** — a type mismatch indicates misconfiguration or an attack, and an unbounded list can DoS a full-iteration consumer via the block gas limit.

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
  │   targetSchema=FILM_SCHEMA, maxEntries=10
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

**Metadata and re-ordering — a stable-UID caveat (Gemini C).** Because EAS attestations are immutable, *changing an entry's weight* has different consequences depending on how ordering is done:

- **Via SortOverlay (recommended for ordered lists):** re-ordering updates pointers in the `EFSSortOverlay` contract (`repositionItem`) *without* revoking or re-attesting the LIST_ENTRY. The entry UID is stable, so any PROPERTY metadata hung off it is preserved.
- **Via revoke-and-re-attest (changing the `weight` field directly):** this mints a NEW LIST_ENTRY with a NEW UID, which **orphans** any PROPERTY metadata that referenced the old entry UID. Clients that attach rich per-entry metadata AND want mutable ordering should use SortOverlay for ordering and treat the LIST_ENTRY's own `weight` as a write-once initial value.

This is a strong reason to steer metadata-bearing ordered lists toward SortOverlay rather than weight-rewrites. Call it out in the SDK guide.

**SCHEMA-mode consumers and revoked targets (louder version of the C5 policy).** Recall LIST_ENTRYs are immune to target lifecycle — a SCHEMA-typed entry stays valid even if its target attestation is later revoked. Consumers that need target liveness (e.g., a registry that should ignore yanked entries) MUST check `eas.getAttestation(target).revocationTime == 0` themselves at read time. The list tells you "Alice put this UID here"; it does not tell you "this UID is still live." Those are different questions, and only the consumer knows which one it needs.

---

## ADR-0041 reconciliation (honest version)

ADR-0041 establishes that **cardinality lives in the schema UID** because the schema UID is the only Etched, globally-coordinated slot at the edge-predicate layer. PIN (cardinality 1) and TAG (cardinality N) are distinct schema UIDs for this reason.

This design puts cardinality (`allowsDuplicates`) and type (`targetType`) switches as fields on the LIST attestation, not on the LIST_ENTRY schema UID. **Two external reviewers in round-18 flagged this as rationalization-shaped.** They were right to scrutinize it; here is the more-honest reckoning.

### What ADR-0041 actually rejected

ADR-0041 §"Alternatives considered" rejected two specific patterns:

1. **Cardinality as a per-attestation flag on a generic EDGE schema.** E.g., `EDGE(target, definition, cardinality)` where cardinality is a field. Reviewers (correctly) noted that a generic edge reader cannot tell from the schema UID alone whether `(target, definition)` is set-shaped or bag-shaped.
2. **Cardinality as a PROPERTY on a definition anchor.** E.g., `definition anchor has a PROPERTY('cardinality', '1')`. Same problem one indirection deeper: the kernel must read PROPERTY state to know how to handle a generic edge.

ADR-0041's deeper principle was: **a generic edge resolver must not need to look up predicate metadata to know how to process the edge.** Each schema must be self-coordinating.

### Where this design genuinely deviates

`ListEntryResolver.onAttest` performs **exactly the pattern ADR-0041 worried about**: it reads the parent LIST attestation to learn `allowsDuplicates`, `appendOnly`, `targetType` before processing the entry. The cache reduces this to one EAS read per LIST-first-touch (warm path is one SLOAD), but the *shape* is still "kernel reads predicate metadata before processing the edge."

This is a real deviation. The mitigations:

- **The metadata read is bounded.** Per-LIST, one-time, immutable result (LIST is non-revocable). Not "every consumer of every edge must look up every predicate's flags" — that's the PIN/TAG-with-cardinality pattern ADR-0041 killed. Here, the resolver looks up the LIST once and caches; subsequent entries hit the cache. Indexers do the same.
- **The metadata source is a specific named attestation, not a generic flag.** Consumers don't need to ask "is this edge a Set or Bag?" They ask "what is the configuration of LIST L?" — and L's UID is the coordination handle. This is structurally cleaner than per-edge flags but does add one level of indirection vs. PIN/TAG.
- **LIST is not an edge.** PIN and TAG are edges (relationships between two existing things). LIST is a predicate-coordination object that *describes* a class of relationships. The two are different layers; ADR-0041's principle applies cleanly to the edge layer, and this design respects it there: PIN and TAG remain untouched.

### What the design accepts as cost

A 2076 reader of LIST_ENTRY must always fetch the parent LIST to know:
- Whether `target == X` means "X exists" (SCHEMA), "X is an address" (ADDR), or "X is an opaque member key" (ANY)
- Whether duplicates are permitted
- Whether entries can be revoked

This is the "kernel-read-per-write" cost ADR-0041 sought to avoid at the edge layer. We pay it here, justified by:

1. The cache makes the marginal cost one SLOAD per warm-path entry write (acceptable for archival semantics).
2. The alternative — splitting LIST_ENTRY into 6+ schemas (one per combination of allowsDuplicates × targetType × appendOnly) — produces 18+ schemas and an unusable enumeration.
3. Indexer cost is one EAS read per LIST (cached client-side), not per entry.

### Verdict

**This design deliberately deviates from ADR-0041's strictest reading.** ADR-0041 expresses a principle (no kernel-read-per-write at the edge layer); this design accepts that principle at the edge layer (PIN/TAG unchanged) but introduces a new layer above it (LIST predicate-coordination) where the cost is acceptable.

The sibling ADR that documents this — the LIST ADR — must explicitly note this deviation in its Consequences section, NOT claim "no supersession needed." A 2076 reader sees both ADR-0041 and the LIST ADR and understands: "ADR-0041 was about the edge layer; the LIST ADR introduces a higher layer where the trade-off is different."

**The earlier framing of "ADR-0041 supersession is NOT required, just a sibling ADR" was technically correct but read as rationalization.** The honest framing is: ADR-0041's principle is preserved at the edge layer; the LIST ADR introduces a new layer with a deliberate, documented trade-off. Both ADRs stand, both apply at their respective layers, and a 2076 reader can reconstruct why each made sense.

---

## Use case walkthrough

Confirming the design handles the use cases that drove the requirements.

### MySpace top-8 friends (ranked, no-dupes, addresses)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR,
      targetSchema=0x0, maxEntries=8
LIST_ENTRY × 8: target=0x0, recipient=friend_addr, weight=rank (1=highest)
```

Consumer: `listReader.entries(top8, alice, 0, 8)` returns `Entry[]`; each `.identityKey` holds the friend address (cast `address(uint160(uint256(identityKey)))`). Client sorts by weight in memory. O(1) "is X in Alice's top 8?" via `countOf(top8, alice, bytes32(uint256(uint160(X)))) > 0`.

### NFT allowlist (no-dupes, addresses, on-chain read)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR,
      targetSchema=0x0, maxEntries=0
LIST_ENTRY × N: target=0x0, recipient=member_addr, weight=0
```

Marketplace contract: see the "Consumer pattern (NFT allowlist — SECURE)" example above. Single SLOAD via `countOf`, ~4k gas.

### Letterboxd top-10 films with ratings (ranked, no-dupes, typed, per-entry metadata)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=SCHEMA,
      targetSchema=FILM_SCHEMA, maxEntries=10
LIST_ENTRY × 10: target=film_uid, recipient=0x0, weight=rank
  PROPERTY on each LIST_ENTRY: rating="X/10"
```

Per-entry rating is independent of the film's intrinsic year (PROPERTY on film UID).

### Spotify-style playlist with repeats (ranked, duplicates-allowed, typed)

```
LIST: allowsDuplicates=true, appendOnly=false, targetType=SCHEMA,
      targetSchema=DATA_SCHEMA, maxEntries=0
LIST_ENTRY × N: target=song_data_uid, recipient=0x0, weight=position
```

"Waterfalls" can appear 3 times. `countOf(playlist, alice, waterfalls_uid)` returns 3. Consumer must explicitly compare to expected count for correctness; no `isMember` bool to misuse.

### Shopping list with intrinsic items (unordered, no-dupes, ANY with opaque keys)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ANY,
      targetSchema=0x0, maxEntries=0
LIST_ENTRY × N: target=keccak256(abi.encode("efs-list-intrinsic", "milk")),
                recipient=0x0, weight=N
  PROPERTY on each LIST_ENTRY: name="milk", status="to-buy"
```

Items use a documented key-derivation convention (`keccak256(abi.encode("efs-list-intrinsic", payload))`) so different clients converge on the same key for the same item name. The PROPERTY on the LIST_ENTRY carries the human-readable name and status. Bob marks "milk" as bought → PROPERTY on his LIST_ENTRY changes status to "bought" (or he revokes the entry; non-append-only).

### Software version registry (append-only, typed, uncapped)

```
LIST: allowsDuplicates=false, appendOnly=true, targetType=SCHEMA,
      targetSchema=RELEASE_SCHEMA, maxEntries=0
LIST_ENTRY × N: target=release_uid, recipient=0x0, weight=release_timestamp
```

Version 1.2.3 is permanent. If buggy, attach a `deprecated=true` PROPERTY to the LIST_ENTRY — the entry stays in the list (dependents can still reference v1.2.3) but consumers see the signal. NPM/crates.io model.

(Note: `appendOnly=true` + `allowsDuplicates=false` does NOT require `maxEntries` — the required-cap rule only triggers when both `appendOnly=true` AND `allowsDuplicates=true`. This is NOT because no-dupes bounds total entries — it doesn't; an attester can add unboundedly many distinct release UIDs. It's because the only combination with *no possible* per-key limit is the append-only multiset, which is the one we force a cap on. A version registry's growth is bounded by its release cadence, not by the kernel.)

### DAO delegate weighted slate (ranked, no-dupes, addresses, capped)

```
LIST: allowsDuplicates=false, appendOnly=false, targetType=ADDR,
      targetSchema=0x0, maxEntries=15
LIST_ENTRY × ≤15: target=0x0, recipient=delegate_addr, weight=delegation_amount
```

Governance contract reads `recipient` (the delegate address) and `weight` (the allocation share). Type confidence: every entry's recipient was validated as an address at write time. The contract `payable(entry.recipient)` without validation.

---

## What's deferred and why

**Generic constraint-callback / extension mechanism (ADR-0045).** Three external reviewers killed it in round 17: solves a non-problem inside a frame that presupposed it was needed. Stays deferred. If future use cases genuinely need extension, they get their own purpose-built schema following this design's pattern.

**Cross-attester merged on-chain view.** ("Show me the union of Alice's and Bob's lists at this name.") Per-attester editions ARE the kernel model; merging is presentation/composition logic that lives in clients or subgraphs. On-chain merge would force a viewer-sovereignty violation. Deferred indefinitely.

**On-chain reverse-lookup "what lists contain X?"** Maintaining this index requires writes proportional to the cardinality of (target × list × attester) — quadratic-ish state growth. Subgraphs handle this efficiently off-chain. The on-chain "X in list L by A?" check (O(1)) covers the most-frequent use case (DAO checks msg.sender against a known list); cross-list scans are subgraph queries.

**Mainnet 50-year freeze.** This design targets devnet; mainnet freeze happens months later. The 50-year test will be applied rigorously then. Devnet usage will surface issues that pure design review cannot.

---

## Open concerns / honest ugly bits

Things we want external reviewers to attack.

### 1. Two new schemas + two new resolvers is real Etched surface

EFS goes from 7 schemas to 9. The reconciliation argument (LIST as predicate-coordination layer) is sound but adds complexity to a 2076 reader's mental model. The S1 inverted-framing pass (round-18b internal) verified that 4 MUSTs cannot be satisfied with existing schemas — the new schemas are load-bearing for the locked requirements.

**Forward compatibility note:** the LIST schema's field set is frozen at registration. Adding a fourth `targetType` value (e.g., `DELEGATED`, `MERKLE_ROOT`, `BLS12_PUBKEY`) post-launch requires a new LIST schema UID. This is the same constraint as PIN/TAG (ADR-0041) and is accepted. The `require(targetType <= 2)` in ListResolver makes the bound explicit; future additions are a deliberate Etched commitment, not a silent feature creep.

### 2. RESOLVED — `address(0)` encoding via EAS recipient field

Round-18 had four candidate options (A/B/C/D). Adopted in round-18b: **a refined Option D** that uses EAS's native `recipient` field for ADDR-typed entries instead of adding a new field. `target` is `bytes32(0)` for ADDR mode; `recipient` carries the address; `address(0)` is fully supported because `recipient=address(0)` is a normal EAS value, not a sentinel collision.

This dissolves the original concern. The structural separation also closes adversarial review I1 (high-bits ambiguity) — ADDR-typed entries use a different EAS field than ANY-typed, so the polymorphism is between fields, not within one field.

### 3. RESOLVED — `isMember` dropped; only `countOf` exposed

Round-18 asked whether to expose `isMember` bool. Round-18b answer: **drop it.** Three independent external reviewers (Claude, Codex, Gemini) flagged that bool semantics on a multiset is a footgun — quorum contracts reading `length` vs `isMember` semantics drift; consumer code on the same list gives different answers depending on which API it picks. `countOf(...) > 0` forces the comparison to be explicit at the call site.

### 4. Member-key collisions and ANY-typed safety (adversarial review I3, I8)

The member-key reframe for `targetType=ANY` puts opaque bytes32 keys in `target`. Different clients picking different conventions (`keccak256("milk")` vs `bytes32(bytes("milk"))` padded) get different keys for the same human concept.

**Mitigations adopted:**
- Document a canonical key-derivation convention in the SDK guide: `keccak256(abi.encode("efs-list-intrinsic", payload))` (domain-separated namespace).
- `ListReader.targetAsMemberKey()` is a typed accessor — consumers explicitly opt into "member key" semantics for ANY lists; can't silently misinterpret as an address or UID.
- `targetType` is denormalized into `ListEntryAttested` events so subgraphs filter correctly without parent-LIST lookups.

**Not mitigated (accepted cost):** different SDKs may derive different keys for the same logical item. This is a UX coordination problem at the client layer, not a protocol-level issue. The SDK guide is the coordination point.

**User-facing consequence to state plainly (SF6):** no-dupes enforcement runs on the derived `bytes32` key, not on human meaning. So an `allowsDuplicates=false` ANY-typed list CAN hold two entries a human reads as the same item ("milk") if two clients derived different keys for it. The kernel dedups bytes, not concepts. For an `appendOnly` ANY no-dupes list this duplicate is permanent. The SDK guide MUST publish one canonical derivation (`keccak256(abi.encode("efs-list-intrinsic", normalizedString))`, with the normalization rules spelled out — lowercasing, trimming, Unicode NFC) so clients converge. This is the same class of coordination as ENS name normalization.

### 5. State growth for append-only uncapped lists

**Correction (Codex): no-dupes does NOT provide a total-entry bound.** `allowsDuplicates=false` bounds *duplicates per identity key* (at most one entry per `(list, identityKey, attester)`), but it does NOT bound total entries — an ANY-typed or SCHEMA-typed list can grow without limit via distinct keys/UIDs. So the only real ceiling on an uncapped list is gas cost plus per-attester storage liability. The earlier "natural bound" framing was wrong; deleting it.

What IS true:
- State is per-attester-keyed, so a griefer can only bloat *their own* edition's storage, not the curator's. A consumer reading the trusted curator's edition is unaffected by spam editions.
- The truly pathological case (`appendOnly=true + allowsDuplicates=true + maxEntries=0` — unbounded multiset that can never shrink) is **rejected by ListResolver** at LIST attest time: that trio requires `maxEntries > 0` (closes Claude external review B4).
- On-chain full-iteration consumers must self-protect by requiring `maxEntries != 0 && maxEntries <= LOCAL_MAX` (shown in the DAO example) — they cannot assume an arbitrary list is safely iterable.

A curator's own genuine append-only list (e.g., a version registry adding ~10 entries/year) grows slowly and is fine. The point is the *primitive* doesn't promise a bound unless `maxEntries` is set; consumers and the SDK must treat unbounded lists accordingly.

### 6. Implicit invariants — load-bearing assumptions to document

Surfaced explicitly (closes round-18 implicit-invariant gap):

- **`IEAS.getAttestation` is a pure storage read in EAS 1.x.** No callback hooks fire. If EAS upgrades to add resolver callbacks at read time, ListEntryResolver must be re-audited (reentrancy surface).
- **LIST attestations are immutable after attest** (non-revocable, no expiration). `_decl` cache is correct forever; cache invalidation never required.
- **EAS UIDs are content-derived.** Attacker cannot precommit a `LIST_ENTRY` with a `listUID` that hasn't been minted yet — the LIST's UID is determined by its own attestation data, which the attacker can't predict for an arbitrary curator.
- **ADR-0025 anchor name uniqueness is (parent, name, schemaUID)-keyed and GLOBAL across attesters.** This is why per-attester editions of a list cannot be expressed as same-name anchors under one parent — and is why LIST + LIST_ENTRY's resolver-maintained per-attester state is necessary rather than reusable existing infrastructure. Documented because round-16's design assumed per-attester anchor scoping that doesn't exist.

### 7. CREATE2 deploy invariant for ListEntryResolver

Closes external review BLOCKING B5 (Claude). Because the resolver address is baked into LIST_ENTRY's schema UID at registration, deploying ListEntryResolver to different addresses on Sepolia vs mainnet would produce different schema UIDs, orphaning all Sepolia entries at mainnet cutover.

**Required pre-launch:**
- CREATE2-deploy ListEntryResolver and ListResolver with deterministic salts
- Document the resolver addresses in the freeze ADR
- Add a deploy-time invariant: `assert(LIST_ENTRY_SCHEMA_UID == expected)` that fails fast on drift
- Add CI check (analogous to existing `deployedContracts.ts` pin check from ADR-0037) verifying the schema UID matches the expected value

Round-16's pinned-Sepolia-fork pattern (ADR-0037) handles PIN/TAG correctly; LIST + LIST_ENTRY entering this same window must follow the same discipline.

### 8. The frame question (remains open)

We've spent 18 rounds + a post-external-review pass on this design. The frame has shifted multiple times:
- "lists are folders" (R11-12) → unwound
- "free-floating LIST is enough" (R13-14) → refined
- "TAG-with-weight covers it" (R15-16) → ADR-0045 attempt
- "constraint callbacks" (R17) → rejected
- "LIST + LIST_ENTRY with dedicated resolver" (R18) → current
- Round-18b internal S1 inverted-framing pass: tested "can existing schemas + a new resolver only" — verdict RED, four MUSTs cannot be satisfied without new schemas (typed write-time, append-only write-time, per-attester editions, on-iteration type confidence)

Three reviewers in round-18 surfaced candidate next frames:
- "Kernel enforces nothing; declared constraints are advisory" (Claude W1)
- "Lists as files" (Gemini WA)
- "target is a member key" (Codex W last) — **adopted into round-18b**

Codex's reframe was adopted. The other two remain candidates for a future iteration if v1 surfaces issues, but they each require relaxing the MUSTs as currently locked.

---

## Field-set decisions

### Locked (round-18c — after second external review)

- LIST options expressed as **explicit bools and discrete enum values** (no bitfields)
- `targetType` as enum `0=ANY, 1=ADDR, 2=SCHEMA` (not bitfield)
- LIST attestation is **non-revocable**; resolver requires `revocable=false, expirationTime=0, refUID=0, recipient=0`
- LIST_ENTRY is **revocable** (resolver rejects revoke when LIST.appendOnly=true)
- LIST_ENTRY lifecycle: resolver REQUIRES per-attestation `revocable=true`, `expirationTime=0`, `refUID=0`
- Both resolvers stay **non-payable** (no `isPayable` override)
- `listUID` is in LIST_ENTRY's data payload, not `refUID`
- **Per-mode encoding via EAS native fields:**
  - ADDR: target=`bytes32(0)`, address in EAS `recipient` field (address(0) valid)
  - SCHEMA: target=UID, recipient=`address(0)` (existence + schema validated; revoked targets allowed — entries immune to target lifecycle)
  - ANY: target=opaque nonzero member key, recipient=`address(0)` (no existence check)
- **WIDE resolver storage layout (locked 2026-05-28):** `_entries` stores `EntryRecord { entryUID, identityKey, weight }` inline so on-chain consumers iterate with no per-entry `eas.getAttestation()`. Mirrors ADR-0041's `TagEntry[]` widening. Subsumes the `_entryIdentityKey` side map. Trimmable on devnet, etched at mainnet freeze.
- `weight` is always present on LIST_ENTRY; opaque int256 metadata, consumer interprets
- **Stateless `ListReader` view contract** as the documented consumer ABI
- **Typed accessors on ListReader** take `(listUID, curator, entryUID)` and are safe-by-construction: reject mode mismatch, wrong schema, wrong curator edition, revoked entry, and cross-list injection. Curator comes from `getMode().curator` or a contract constant, never the caller (closes Codex same-list wrong-edition injection)
- `getMode` decodes LIST attestation directly via EAS, **schema-check before data-decode** (works for empty lists; rejects non-LIST UIDs)
- Per-entry metadata via **standard PROPERTY-on-attestation pattern**, scoped to LIST_ENTRY UID; ordered metadata-bearing lists use SortOverlay (stable UID) not weight-rewrites (orphans metadata)
- `maxEntries` included as a `uint32` field on LIST (0 = uncapped; REQUIRED >0 when appendOnly+allowsDuplicates). Primary rationale: contract-safety bound for on-chain iterators.
- **No `isMember` bool** — `countOf` only; consumers explicitly compare to 0
- **`allowIntrinsic` field removed** — replaced by `targetType=ANY` with opaque member keys (Codex reframe)
- **CREATE2 deterministic resolver deploy** with schema UID invariant + CI pin check
- **Events frozen**: `ListEntryAttested`/`ListEntryRevoked` index `(listUID, attester, identityKey)`; `targetType` denormalized as data; enables raw-RPC reverse lookup by member
- **ADR-0041 reconciliation framed honestly** as deliberate deviation at predicate-coordination layer (not "no supersession needed")

### Open (pending next external review pass)

- Final review of round-18c punch-list application
- Specifically: does the wide storage layout + typed-accessor cross-list checks hold up?
- Is the event indexing choice (identityKey over entryUID) right for the reverse-lookup use case?
- Any remaining issues before ADR drafting?

---

## Frame history recap

Six frame-level refinements across 18 rounds + 1 post-external-review revision:

- **Round 11-12**: lists are folders → unwound (unification didn't match the graph model)
- **Round 13-14**: free-floating LIST attestation + typed list anchors + PIN placement
- **Round 15-16**: schema simplification + principled editions stance + SortOverlay TAG-source + entry-anchor + weight TAG (3 attestations per entry)
- **Round 17**: constraint-callback / IEFSConstraintCallback mechanism (ADR-0045) → rejected by 3 external reviewers (wrong abstraction)
- **Round 18**: LIST + LIST_ENTRY with dedicated `ListEntryResolver` enforcing all declared options at write time; single attestation per entry; per-entry metadata via standard PROPERTY pattern on LIST_ENTRY UID
- **Round 18b** (this revision): post-external-review hardening — Codex's member-key reframe adopted for ANY; `address(0)` resolved via EAS native `recipient` field for ADDR; `isMember` dropped; lifecycle invariants enforced (revocable, expirationTime, refUID); CREATE2 deploy pinned; `appendOnly + allowsDuplicates + uncapped` combo rejected; ADR-0041 reconciliation framed honestly as deliberate deviation at the predicate-coordination layer

The pattern across all six: agents converge inside a frame; humans question the frame. Round-18 added a new dynamic: external reviewers (Claude/Codex/Gemini in parallel) found issues that the 4-of-5 internal convergence missed — including correctness bugs (allowlist example), missing lifecycle enforcement, and a clean reframe (member-key) that dissolved the design's biggest unresolved concern. Round-18b is the integration of that feedback + an internal S1 inverted-framing pass (verdict: RED, architecture justified).

---

## Open questions for human / external review (round-18b)

1. Does the EAS-native-`recipient` encoding for ADDR-typed lists hold up? Any indexer / SDK / EAS-quirk concerns we missed?
2. Does the documented key-derivation convention for ANY-typed lists (`keccak256(abi.encode("efs-list-intrinsic", payload))`) sufficiently coordinate clients, or do we need stronger protocol-level enforcement?
3. Are the lifecycle invariants (revocable, expirationTime, refUID) complete, or are there other EAS-level fields that need explicit resolver-side requires?
4. Is the ADR-0041 reconciliation now honest enough — is "deliberate deviation at a new layer" the right framing, or does it still read as rationalization?
5. The frame question stays open: what next-frame question haven't we asked?
