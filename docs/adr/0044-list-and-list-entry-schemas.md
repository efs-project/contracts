# ADR-0044: LIST + LIST_ENTRY schemas for curated, shape-enforced collections

**Status:** Proposed
**Date:** 2026-05-28
**Permanence-tier:** Etched (two new EAS schema field strings; resolver address baked into LIST_ENTRY's schema UID)
**Related:** ADR-0041 (PIN/TAG cardinality split — the precedent this builds on and deliberately deviates from), ADR-0043 (EFS Edge Constraint Callbacks — deferred; what this replaces), ADR-0030 (mainnet permanence), ADR-0025 (anchor name uniqueness), ADR-0037 (pinned Sepolia fork / deterministic deploy), ADR-0009 (append-only kernel), ADR-0042 (effective-TAG weight filter / editions)
**Design doc:** [`designs/custom-lists.md`](../../designs/custom-lists.md) (full mechanical detail, resolver pseudocode, worked example, use-case walkthrough). **History:** [`designs/custom-lists_notes.md`](../../designs/custom-lists_notes.md) (18 rounds + 3 external review cycles).

## Context

EFS needs a **list primitive**: an ordered-or-unordered, typed-or-untyped, deduplicated-or-not, optionally-append-only collection that other smart contracts can read and trust. The motivating use cases (MySpace top-8, NFT allowlists, DAO delegate slates, Letterboxd-style ranked entries with per-entry metadata, software version registries, shopping lists with intrinsic items) share one demand the existing primitives cannot meet: **declared data shape must be enforced at write time, so an on-chain consumer can iterate a list and trust every entry without per-entry validation.**

The locked requirements (crystallized with the human before the converging design round):

- **MUST:** ordered + unordered; no-duplicates (write-time enforced) + duplicates-allowed; typed (write-time enforced) + untyped + address-typed (incl. `address(0)`); append-only list-level (write-time enforced); per-attester editions preserved; smart contracts iterate active entries with O(N) reads + full type confidence; O(1) membership check for all modes.
- **NICE:** per-entry metadata; deprecation flags; intrinsic items; reorderable; capped.
- **DEFERRED:** generic constraint-callback mechanism (ADR-0043); cross-attester merged on-chain view; on-chain reverse-lookup index; mainnet 50-year freeze (devnet first).

### Why not existing schemas

An internal inverted-framing pass ("implement every MUST using only PIN/TAG/ANCHOR/PROPERTY, allowing a new resolver and a view contract, but no new schema UID") returned **RED**. Four MUSTs cannot be satisfied without a new schema:

1. **Typed write-time enforcement** — no existing resolver compares a target's schema against a per-list declared type at attest time. EdgeResolver is frozen (its address is in PIN/TAG's schema UIDs per ADR-0041); EFSIndexer is the kernel and must not learn list semantics.
2. **Append-only write-time enforcement** — rejecting an entry revoke requires a resolver that knows the parent list's policy. No existing resolver does.
3. **Per-attester editions for membership state** — ADR-0025 anchor-name uniqueness is **global per `(parent, name, schemaUID)`**, not per-attester. Any anchor-based entry scheme collides across editions. List membership needs attester-keyed resolver state.
4. **On-iteration type confidence** — a generic edge gives a UID; trusting "every entry is type X" requires the resolver to have enforced it at write time.

The earlier attempt to plug these gaps with a generic constraint-callback mechanism (ADR-0043) was rejected by three external reviewers as the wrong abstraction ("solves a non-problem inside a frame that presupposed it was needed"). This ADR takes the other path: a purpose-built schema pair, following the ADR-0041 precedent that **a predicate whose cardinality/shape the kernel must enforce gets its own schema UID.**

## Decision

### 1. Two sibling schemas: LIST (declaration) + LIST_ENTRY (membership)

```
LIST schema:
  bool    allowsDuplicates    // false = no-duplicates enforced at write time
  bool    appendOnly          // true  = entry revokes rejected by resolver
  uint8   targetType          // 0=ANY (opaque member key), 1=ADDR, 2=SCHEMA
  bytes32 targetSchema        // non-zero iff targetType==SCHEMA
  uint32  maxEntries          // 0 = uncapped; per-attester. Required >0 when appendOnly && allowsDuplicates
  revocable: false
  resolver:  ListResolver     // field-shape validation only; no state

LIST_ENTRY schema:
  bytes32 listUID             // the LIST this entry belongs to (data payload, not refUID)
  bytes32 target              // SCHEMA: attestation UID; ANY: opaque nonzero member key; ADDR: must be 0
  int256  weight              // opaque ranking metadata; consumer interprets
  revocable: true             // resolver rejects revoke when LIST.appendOnly == true
  resolver:  ListEntryResolver
```

LIST is **free-floating** (`refUID = 0`, non-revocable) — content identity for "a list," parallel to DATA. LIST_ENTRY is the membership edge, parallel to MIRROR's relationship to DATA. A list is placed in a path via a standard PIN (`Anchor → PIN → LIST`).

Options live on LIST (the per-list predicate-coordination object), not on each entry — see §"ADR-0041 reconciliation."

### 2. Per-mode encoding via native EAS fields

`targetType` selects which EAS field carries entry identity and whether existence is checked. There is **no in-band polymorphism on a single field** — each mode uses a structurally distinct field:

| Mode | identity field | `target` | `recipient` | existence check |
|---|---|---|---|---|
| ADDR (1) | EAS `recipient` | `bytes32(0)` | the address (incl. `address(0)`) | none |
| SCHEMA (2) | `target` | attestation UID | `address(0)` | UID exists AND schema == `targetSchema` |
| ANY (0) | `target` | opaque nonzero member key | `address(0)` | none (opaque) |

This resolves the `address(0)` ambiguity that plagued earlier drafts: ADDR addresses live in the native `recipient` field, so `address(0)` is a normal value, not a sentinel collision. Intrinsic items (shopping-list "milk") use ANY mode with a member key (`keccak256(abi.encode("efs-list-intrinsic", normalizedPayload))`) — there is no separate `allowIntrinsic` flag.

The resolver derives a canonical `identityKey` for membership/dedup: `bytes32(uint160(recipient))` for ADDR, the UID for SCHEMA, the member key for ANY.

### 3. Write-time enforcement by ListEntryResolver

On `LIST_ENTRY` attest, `ListEntryResolver`:
1. Enforces lifecycle invariants: `revocable == true`, `expirationTime == 0`, `refUID == 0`.
2. Hydrates and caches the parent LIST's declaration (`require(L.schema == LIST_SCHEMA_UID)`). LIST is immutable, so the cache is correct forever.
3. Enforces the per-mode encoding + type check (§2).
4. Enforces no-duplicates: `require(_entryCount[listUID][identityKey][attester] == 0)` when `!allowsDuplicates`.
5. Enforces the cap: `require(_entries[listUID][attester].length < maxEntries)` when `maxEntries != 0`.
6. Appends to per-attester state.

On revoke: rejects if `appendOnly`; otherwise swap-and-pops the entry and decrements the count. `ListResolver` rejects the `appendOnly && allowsDuplicates && maxEntries == 0` combination at LIST attest time (the only unbounded-growth combination).

All enforcement is at write time. Downstream readers trust without re-validation. Membership state is keyed `[listUID][identityKey][attester]` — **per-attester editions fall out naturally**; an attacker can only bloat their own edition.

### 4. Wide storage layout

The per-attester active-entry array stores a struct inline, not bare UIDs:

```solidity
struct EntryRecord { bytes32 entryUID; bytes32 identityKey; int256 weight; }
mapping(bytes32 listUID => mapping(address attester => EntryRecord[])) private _entries;
```

On-chain consumers iterate `(identityKey, weight)` with **no per-entry `eas.getAttestation()`**. This directly mirrors ADR-0041's deliberate widening of `_activeByAAS` from `bytes32[]` to `TagEntry[]`, for the identical reason: the alternative N+1 SLOAD pattern collides with block gas limits on long lists, defeating on-chain iteration (MUST). Storing `identityKey` inline also subsumes any side map (revoke reads it from the array element). Cost: ~2 extra storage slots per entry write. This is the fail-safe direction — over-provision is wasted write gas; under-provision is a functional wall.

### 5. ListReader view contract + safe-by-construction accessors

A stateless, redeployable `ListReader` is the documented consumer ABI. `getMode(listUID)` decodes the LIST attestation directly via EAS (schema-check before data-decode; works for empty lists). `entries(...)` returns the inline `EntryRecord` page. `countOf(listUID, attester, identityKey)` is the O(1) membership primitive — **there is no `isMember` bool** (bool semantics on a multiset is a footgun; consumers compare to 0 explicitly).

Typed accessors `targetAs{Address,UID,MemberKey}(listUID, curator, entryUID)` are safe-by-construction: each requires LIST_ENTRY schema, `attester == curator` (the trusted edition), `revocationTime == 0`, `entryListUID == listUID`, and mode match. The `curator` comes from `getMode().curator` or a contract constant, **never the caller** — because editions are permissionless, scoping to the trusted curator is what prevents a same-list wrong-edition injection.

### 6. Events

`ListEntryAttested` / `ListEntryRevoked` index `(listUID, attester, identityKey)` and carry `entryUID`, `targetType` (denormalized), `weight` as data. Indexing `identityKey` enables raw-RPC "is member X in list L?" log filtering across editions — the partial reverse-lookup otherwise deferred to subgraphs. `targetType` denormalization lets indexers decode without a parent-LIST lookup per entry.

### 7. Per-entry metadata via the standard PROPERTY pattern

Metadata attaches to the LIST_ENTRY UID using the existing `Anchor<PROPERTY> + PIN + PROPERTY` pattern — no new mechanism. Three scopes: PROPERTY on the target UID (content-intrinsic), on the LIST_ENTRY UID (per-entry), on the LIST UID (per-list). Ordered metadata-bearing lists should reorder via SortOverlay (stable entry UID) rather than weight-rewrites (which mint a new UID and orphan attached metadata).

### 8. CREATE2 deterministic deploy + schema-UID freeze invariant

Because `ListEntryResolver`'s address is hashed into LIST_ENTRY's schema UID, the resolver MUST be CREATE2-deployed with a deterministic salt, the address recorded in this ADR at acceptance, and a deploy-time `assert(LIST_ENTRY_SCHEMA_UID == expected)` plus a CI pin check (analogous to ADR-0037's `deployedContracts.ts` check). Any change to `ListEntryResolver` bytecode — including the `EntryRecord` storage layout — changes the schema UID and orphans prior entries. Free on devnet; etched at mainnet freeze.

## Consequences

**Enables**

- **Trustable on-chain reads.** A contract iterates a list and trusts every entry's type and shape without per-entry validation. This is the property that makes EFS list data useful to other contracts — the core motivation.
- **Write-time-enforced no-duplicates, append-only, and typing.** "If a list says no duplicates, the chain refuses the duplicate." Declared shape is a guarantee, not a convention.
- **O(1) membership for all modes** via `_entryCount` (which doubles as the no-dupe gate).
- **Per-attester editions for free** from attester-keyed state — consistent with the rest of EFS's viewer-sovereignty model.
- **Per-entry metadata** via the existing PROPERTY pattern, scoped cleanly by UID.
- **Partial reverse-lookup** (member → lists) via indexed event topics, without an on-chain index.

**Costs**

- **Two new schema UIDs + two new resolvers.** EFS goes from 7 schemas to 9. Justified by the S1 RED verdict — the MUSTs cannot be met otherwise.
- **Wide storage costs ~2 extra slots per entry write** (~+40k cold gas). Accepted: EFS is gas-heavy by design (archival, not commodity), and the alternative breaks on-chain iteration.
- **Field set is frozen at registration.** A fourth `targetType`, an extra option, or a storage-layout change each requires a new schema UID post-mainnet. `require(targetType <= 2)` makes the bound explicit.
- **State growth is NOT bounded by no-duplicates** — only by `maxEntries`. No-dupes bounds duplicates per identity key, not total entries; an attester can add unboundedly many distinct keys/UIDs to an uncapped list. On-chain full-iteration consumers must require `maxEntries != 0 && maxEntries <= LOCAL_MAX` to protect themselves. Per-attester keying confines any one griefer to their own edition.
- **Entries are immune to target lifecycle.** A SCHEMA-typed entry stays valid even if its target attestation is later revoked. Consumers needing target liveness must check `revocationTime` themselves. (Deliberate: matches the editions principle — your view is permanent; downstream churn doesn't unwind it.)

**Load-bearing**

- **Write-time enforcement is the whole point.** Moving any declared-shape check to read time or SDK convention defeats the requirement and reopens the round-16 gap.
- **`identityKey` keying is per-`(listUID, identityKey, attester)`.** This is what makes editions, dedup, and O(1) membership all work from one map. Changing the key shape is a Tier-1 change.
- **Wide `EntryRecord[]` storage (not bare `bytes32[]`).** Required for on-chain iteration feasibility. Slimming it is a schema-UID-changing event.
- **CREATE2 deterministic resolver deploy.** Required for cross-environment schema-UID stability; without it, devnet and mainnet diverge and entries orphan.

## ADR-0041 reconciliation (this design deliberately deviates — read both ADRs together)

ADR-0041 established that **cardinality lives in the schema UID** because a generic edge resolver must not need to look up predicate metadata to process an edge. This design puts cardinality (`allowsDuplicates`) and type (`targetType`) as **fields on the LIST attestation**, and `ListEntryResolver.onAttest` reads the parent LIST to learn them before processing an entry — **exactly the pattern ADR-0041 worried about.** Two external reviewers flagged the earlier "no supersession needed" framing as rationalization. The honest reckoning:

- **The deviation is real and is at a new layer.** ADR-0041's principle applies to the *edge layer* (PIN/TAG), which this design leaves untouched. LIST introduces a *predicate-coordination layer above the edge layer*: the LIST attestation is the immutable, named, machine-readable coordination object for one specific list's shape. A reader asks "what is the configuration of LIST L?" (L's UID is the handle), not "is this generic edge a Set or a Bag?" (the per-edge-flag pattern ADR-0041 killed).
- **The metadata read is bounded, not per-edge-per-consumer.** The resolver reads the LIST once and caches (LIST is immutable); indexers do likewise. This is the structural difference from ADR-0041's rejected alternative #2 (a mutable cardinality PROPERTY requiring a lookup per write with no immutability guarantee).
- **The accepted cost:** a reader of a LIST_ENTRY must fetch the parent LIST to interpret `target` and the dedup/append-only policy. We pay this because the alternative — enumerating one schema per `(allowsDuplicates × targetType × appendOnly)` combination — yields 18+ schemas and is unusable.

**ADR-0041 stays Accepted and in force at the edge layer. This ADR is the documented exception at the list layer.** A 2076 reader sees both and understands each made sense at its layer. ADR-0041 is NOT superseded.

## Alternatives considered

1. **Round-16 entry-anchor model** (entry = child anchor + PIN + weight TAG; 3 attestations/entry). Rejected: cannot enforce typing/append-only/no-dupes at write time without EdgeResolver pollution or cross-resolver coordination; per-attester editions collide with ADR-0025 global anchor-name uniqueness; ambiguous which of 3 UIDs carries per-entry metadata.
2. **ADR-0043 generic constraint callbacks.** Deferred by three external reviewers — wrong abstraction, speculative, permanent commitment for hypothetical flexibility.
3. **Existing schemas only (no new schema UID).** S1 inverted-framing pass: RED. Four MUSTs unsatisfiable (see Context).
4. **Single LIST schema with inline entries / config-on-every-entry.** Rejected: contradicts per-entry divergence; loses empty-list declarations; bloats every entry.
5. **Split LIST_ENTRY by cardinality (LIST_ENTRY_UNIQUE / LIST_ENTRY_MULTI), mirroring PIN/TAG.** Considered. Rejected: cardinality here is one of several per-list options (with type, append-only, cap); enumerating the cross-product is 18+ schemas. The LIST declaration is the right coordination object.
6. **Bitfield for options.** Rejected by the human: explicit bools/enums for 50-year legibility (reserved bits are an ADR-0035-shape mistake risk).
7. **Sentinel-bit encoding for `address(0)`.** Rejected: in-band polymorphism on one field is the "weird EFS thing"; native `recipient` field is cleaner and reuses primitives every EAS consumer understands.
8. **`isMember` bool accessor.** Rejected: bool semantics on a multiset is a footgun (three reviewers); `countOf > 0` forces explicit comparison.

## Migration

- New LIST and LIST_ENTRY schema UIDs registered at deploy time alongside `ListResolver` and `ListEntryResolver` (CREATE2, deterministic).
- `ListReader` deployed as a stateless view contract (redeployable; not baked into any schema UID).
- `deployedContracts.ts` regenerates deterministically against the pinned Sepolia fork (ADR-0037); a CI check asserts the LIST_ENTRY schema UID matches the expected constant.
- Pre-launch — no user-data migration. The `ListReader` ABI may evolve until clients depend on it; the schema field strings are frozen as of the three-GO confirmation review (design-doc commit `d685332`).
- Spec follow-up: rewrite `specs/06-Lists-and-Collections.md` to describe the shipped primitive; add `LIST` / `LIST_ENTRY` rows to `specs/02` and `specs/overview.md`.

## Note on status

Marked **Proposed** pending the human's formal acceptance. The design decision itself is locked (three independent external reviewers returned GO on the schema field strings; the human approved the wide-storage layout). On acceptance, flip to **Accepted** and record the CREATE2 resolver addresses + frozen schema UIDs in the Migration section. Per repo discipline, this ADR becomes immutable once Accepted; corrections to prose (not the Decision) follow the 30-day retroactive grace window.
