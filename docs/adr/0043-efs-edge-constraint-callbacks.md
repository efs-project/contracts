# ADR-0043: EFS Edge Constraint Callbacks

**Status:** Proposed
**Date:** 2026-05-21
**Related:** ADR-0030 (mainnet permanence), ADR-0032 (EAS as foundation), ADR-0041 (PIN/TAG schema split), ADR-0042 (effective-TAG filter); upcoming ADR-0044 (LIST schema), ADR-0045 (PIN-trust-extension)

## Context

EAS provides per-schema resolvers — contracts that validate attestations of their schema at write time. EFS uses this extensively: `EdgeResolver` for PIN/TAG, `MirrorResolver` for MIRROR, `EFSIndexer` itself as the resolver for ANCHOR. These resolvers see writes to **their own** schema only.

EFS introduces a **graph-structural dimension** EAS doesn't natively model: cross-attestation invariants. Concrete cases emerging in design work:

- **LIST.allowsDuplicates=false** — at most one entry (per curator) pins to a given target. The write that could violate this is a PIN whose definition is an entry anchor whose parent is the LIST. The PIN's own resolver (EdgeResolver) handles PIN, but EdgeResolver is schema-agnostic for PIN structure; it has no notion of "this PIN's parent is a LIST, so check LIST-specific rules."
- **Bounded TAG buckets** — "at most N delegates in this slate," "at most one category TAG per item from this attester."
- **PROPERTY value-type conformance** — the value PINed at a PROPERTY slot must conform to a declared type.
- **Append-only lists** — entries can be added but not revoked (governance ballots, audit logs).

These all share a structure: **a write to schema X is structurally related to an attestation of schema Y, and Y's rules constrain whether X is valid.** EAS's resolver model doesn't capture this because resolvers only see own-schema writes.

The round-15/16 cross-agent review surfaced this as a load-bearing gap. The available options were:

1. Hardcode LIST-specific logic into EdgeResolver. Works for LIST; doesn't generalize; every future cross-schema invariant requires EdgeResolver changes. EdgeResolver's address is baked into PIN/TAG schema UIDs and is frozen post-Sepolia.
2. Encode invariants in schema fields (bitfields). Adds a second permanent coordination slot beside the schema UID itself, violating ADR-0041's principle that schema UID is the only such slot. Rejected.
3. Resolver chains (multiple resolvers per schema). Solves an upgradeability problem EFS deliberately doesn't have. Rejected.
4. **A constraint-callback mechanism: EdgeResolver dispatches to registered callbacks based on the parent schema of a PIN/TAG's definition.** The callback contains the schema-specific validation logic; EdgeResolver stays schema-agnostic.

Option 4 — a small extension to EdgeResolver — generalizes naturally to any cross-attestation structural invariant on edge writes. It is the EFS-level analog of EAS's resolver model, in the graph-structural dimension EFS introduces.

This must land at Sepolia ship: EdgeResolver's behavior is frozen by PIN/TAG schema UID hashing post-launch. A callback dispatch mechanism added later is impossible without migrating all PIN/TAG attestations to new schemas. The interface itself becomes Etched at registration.

## Decision

Add a constraint-callback dispatch mechanism to `EdgeResolver`. Registered callbacks fire on PIN and TAG writes (attest and revoke) when the write's `definition` has a parent attestation whose schema matches a registration. The callback enforces cross-attestation structural invariants by reading state and reverting on violation.

### Interface

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Cross-schema structural-invariant callback for edge (PIN/TAG) writes.
///         Registered on EdgeResolver per parent schema. Fires when an edge attestation
///         is written or revoked whose `definition`'s parent attestation has the
///         registered schema.
///
/// REENTRANCY CONTRACT (MUST be honored by implementations):
///   - MAY call view functions on EAS, EFSIndexer, EdgeResolver.
///   - MUST NOT call eas.attest() or eas.revoke() — cascade attestations are forbidden.
///   - MUST NOT call mutating functions on EdgeResolver — guarded by transient
///     reentrancy lock; violations revert the outer attest/revoke.
///
/// GAS BUDGET: each callback dispatch is invoked with at most MAX_CALLBACK_GAS
/// (100,000) gas. Callbacks exceeding this OOG cleanly without affecting EdgeResolver
/// state; the outer attest reverts with ConstraintCallbackFailed.
///
/// FAILURE MODEL: callbacks revert (with custom errors) to veto a write or revoke.
/// EdgeResolver re-reverts with the inner reason preserved, so attesters see the
/// constraint-specific revert reason in the transaction trace.
interface IEFSEdgeConstraint is IERC165 {
    /// @notice Called after EdgeResolver has committed the slot/bucket state for
    ///         a PIN or TAG attestation, but before control returns to EAS.
    ///
    /// @param edgeUID         UID of the new edge (PIN or TAG) attestation.
    /// @param edgeSchema      Schema of the edge — PIN_SCHEMA_UID or TAG_SCHEMA_UID.
    /// @param definition      Edge's definition (predicate anchor UID).
    /// @param parentUID       Direct parent of `definition` in the anchor hierarchy.
    ///                        For list-entry edges: the LIST attestation UID.
    /// @param parentSchemaUID Schema UID of `parentUID`. Equals the schema this
    ///                        callback was registered for.
    /// @param targetID        Edge's resolved target: refUID, or bytes32(uint160(recipient))
    ///                        for address targets.
    /// @param targetSchema    Schema of the target attestation; bytes32(0) for address.
    /// @param attester        The edge's attester.
    /// @param weight          TAG weight; ignored for PIN (always 0 for PIN).
    function onEdgeAttest(
        bytes32 edgeUID,
        bytes32 edgeSchema,
        bytes32 definition,
        bytes32 parentUID,
        bytes32 parentSchemaUID,
        bytes32 targetID,
        bytes32 targetSchema,
        address attester,
        int256 weight
    ) external;

    /// @notice Called after EdgeResolver has cleared the slot/bucket state for a
    ///         revoked edge, but before control returns to EAS. Revert to veto
    ///         the revocation (e.g., append-only invariant).
    function onEdgeRevoke(
        bytes32 edgeUID,
        bytes32 edgeSchema,
        bytes32 definition,
        bytes32 parentUID,
        bytes32 parentSchemaUID,
        bytes32 targetID,
        bytes32 targetSchema,
        address attester,
        int256 weight
    ) external;
}
```

### EdgeResolver additions

```solidity
// Storage
mapping(bytes32 parentSchemaUID => IEFSEdgeConstraint) private _constraintCallback;

// Constants
uint256 private constant MAX_CALLBACK_GAS = 100_000;
bytes32 private constant CALLBACK_REENTRANCY_SLOT =
    keccak256("efs.edgeresolver.callbackActive.v1");

// Errors
error ConstraintCallbackAlreadyRegistered(bytes32 parentSchemaUID);
error ConstraintCallbackNotResolver(bytes32 parentSchemaUID, address caller, address expectedResolver);
error ConstraintCallbackFailed(bytes32 parentSchemaUID, bytes reason);
error ConstraintCallbackReentrancy();
error InvalidCallbackContract();

event ConstraintCallbackRegistered(bytes32 indexed parentSchemaUID, address indexed callback);

/// @notice Register a constraint callback for a parent schema.
/// @dev May only be called by the schema's registered EAS resolver. Append-only:
///      callbacks cannot be replaced once set. Bugs require schema supersession.
function registerConstraintCallback(
    bytes32 parentSchemaUID,
    IEFSEdgeConstraint callback
) external {
    if (parentSchemaUID == bytes32(0)) revert InvalidCallbackContract();
    if (address(_constraintCallback[parentSchemaUID]) != address(0)) {
        revert ConstraintCallbackAlreadyRegistered(parentSchemaUID);
    }
    SchemaRecord memory sr = _schemaRegistry.getSchema(parentSchemaUID);
    if (sr.uid == bytes32(0)) revert InvalidCallbackContract();
    if (msg.sender != address(sr.resolver)) {
        revert ConstraintCallbackNotResolver(parentSchemaUID, msg.sender, address(sr.resolver));
    }
    if (address(callback).code.length == 0) revert InvalidCallbackContract();
    if (!IERC165(address(callback)).supportsInterface(type(IEFSEdgeConstraint).interfaceId)) {
        revert InvalidCallbackContract();
    }
    _constraintCallback[parentSchemaUID] = callback;
    emit ConstraintCallbackRegistered(parentSchemaUID, address(callback));
}

/// @dev Dispatch helper. Called from _onAttestPin / _onAttestTag / _onRevokePin /
///      _onRevokeTag after slot/bucket state is committed.
function _dispatchConstraintCallback(
    bool isAttest,
    bytes32 edgeUID,
    bytes32 edgeSchema,
    bytes32 definition,
    bytes32 targetID,
    bytes32 targetSchema,
    address attester,
    int256 weight
) internal {
    // Skip dispatch when definition has no attestation-level parent
    // (address-target PINs, schemaUID-as-definition PINs).
    if (targetSchema == bytes32(0) && definition != bytes32(0)) {
        // address-target case still has a definition; check its parent
    }
    bytes32 parentUID = _indexer.getParent(definition);
    if (parentUID == bytes32(0)) return;  // root anchor or definition is non-anchor

    Attestation memory parentAtt = _eas.getAttestation(parentUID);
    if (parentAtt.uid == bytes32(0)) return;  // shouldn't happen but guard
    bytes32 parentSchemaUID = parentAtt.schema;

    IEFSEdgeConstraint cb = _constraintCallback[parentSchemaUID];
    if (address(cb) == address(0)) return;  // no callback registered for this schema

    // Failsafe-open: if callback contract was selfdestructed, treat as no-op
    if (address(cb).code.length == 0) return;

    // Transient reentrancy guard
    assembly {
        if tload(CALLBACK_REENTRANCY_SLOT) {
            // Bubble up a specific error
            mstore(0x00, 0xdeadbeef)  // placeholder; use actual ConstraintCallbackReentrancy selector
            revert(0x00, 0x04)
        }
        tstore(CALLBACK_REENTRANCY_SLOT, 1)
    }

    bool success;
    bytes memory returndata;
    if (isAttest) {
        (success, returndata) = address(cb).call{gas: MAX_CALLBACK_GAS}(
            abi.encodeWithSelector(
                IEFSEdgeConstraint.onEdgeAttest.selector,
                edgeUID, edgeSchema, definition, parentUID, parentSchemaUID,
                targetID, targetSchema, attester, weight
            )
        );
    } else {
        (success, returndata) = address(cb).call{gas: MAX_CALLBACK_GAS}(
            abi.encodeWithSelector(
                IEFSEdgeConstraint.onEdgeRevoke.selector,
                edgeUID, edgeSchema, definition, parentUID, parentSchemaUID,
                targetID, targetSchema, attester, weight
            )
        );
    }

    assembly {
        tstore(CALLBACK_REENTRANCY_SLOT, 0)
    }

    if (!success) {
        // Re-revert with inner reason preserved so attesters see the constraint's custom error.
        if (returndata.length > 0) {
            assembly { revert(add(returndata, 0x20), mload(returndata)) }
        }
        revert ConstraintCallbackFailed(parentSchemaUID, returndata);
    }
}
```

The dispatch call is added at the end of `_onAttestPin`, `_onAttestTag`, `_onRevokePin`, and `_onRevokeTag` — after all slot/bucket state writes, before returning.

### Scope: what dispatches fire

- **PIN attest:** yes. `_onAttestPin` dispatches after slot write.
- **TAG attest:** yes. `_onAttestTag` dispatches after bucket update.
- **PIN revoke:** yes. `_onRevokePin` dispatches after slot clear.
- **TAG revoke:** yes. `_onRevokeTag` dispatches after bucket swap-and-pop.

### Explicit out-of-scope (architecturally rejected)

1. **ANCHOR write callbacks.** Anchor name uniqueness via `_nameToAnchor` is the existing gating story. Adding cross-schema callbacks on anchor creation re-introduces ownership semantics through a side door. Anchors are neutral (see ADR-0045 once written).
2. **DATA write callbacks.** DATA is content identity. Gating its creation breaks the "anyone can publish" core property.
3. **Read-side enforcement.** Reads are arbitrary `eth_call`s; the kernel never sees the question. Editions are the only legitimate read-side filter.
4. **Cross-edition state inspection that gates by attester identity.** A callback inspecting other attesters' state to gate the current attester's write is attester-based write-gating in disguise. Editions ARE the access control (see design-lessons.md and the rounds-11-16 "category error" line). Callbacks MUST NOT veto based on `attester` identity beyond per-attester scoping of their own indices.
5. **Async / multi-block constraints.** All checks are single-call, synchronous, on current state.
6. **Constraint chaining.** One callback per parent schema. Composition lives in callback code if desired (coordinator pattern).
7. **Generic precondition framework over arbitrary remote state.** Specific cross-schema reads inside a callback's implementation are fine (already what MirrorResolver does). A generic "declare X must exist before Y" framework adds enormous surface for unclear gain.

## Consequences

### What this enables

- **LIST.allowsDuplicates=false enforced at kernel level.** ListResolver implements `IEFSEdgeConstraint`, registers for `LIST_SCHEMA_UID`. On PIN attest under a list entry, it checks its `_listTargetByAttester[listUID][attester][targetID]` index and reverts on duplicate.
- **Append-only lists.** A future schema's callback reverts on `onEdgeRevoke` for entries it has flagged immutable.
- **Bounded-N TAG buckets.** Future bounded-list schema's callback checks active bucket length and rejects writes beyond N.
- **PROPERTY value-type conformance.** Future PropertyResolver upgrade verifies the value PINed at a PROPERTY slot matches the declared type.
- **Cross-schema preconditions (limited).** Callbacks can read other contract state to validate (e.g., "DATA must have at least one MIRROR" → callback calls `_indexer.getReferencingCount(dataUID, MIRROR_SCHEMA_UID)`).

### Costs

- **Etched commitment.** EdgeResolver's address is baked into PIN/TAG schema UIDs at registration. The dispatch mechanism is permanent post-Sepolia. The `IEFSEdgeConstraint` interface signature is permanent — implementers cannot opt for a different shape later.
- **Per-edge dispatch overhead.** ~2,100 gas cold / ~150 gas warm per edge write for the registry lookup and parent inspection, even when no callback is registered. The `getParent` call is factored from existing EdgeResolver logic (already called at L250 for `_childrenWithEdge`), so this overhead is mostly a single SLOAD on the `_constraintCallback` mapping. Acceptable.
- **Per-edge dispatch overhead with callback registered.** Add ~2,600 gas for external CALL + ~5k for try/catch wrapping + callback's own work (capped at 100k). For LIST.allowsDuplicates: ~15-25k extra per list-entry PIN.
- **Registration is one-shot.** Bugs in a registered callback require schema supersession (deploy new resolver + new schema UID + ecosystem migration). Same cost model as any other ADR-0030-bound schema bug.

### Migration & evolution

- **Adding a constraint to an existing schema post-Sepolia:** impossible without schema supersession. The schema must be replaced with a new version (new resolver, new schema UID); the new schema can register a callback at deploy time.
- **Removing a constraint:** impossible. Callbacks are one-shot.
- **Updating a callback:** impossible. Same migration path.

This matches mainnet permanence (ADR-0030). Constraints, like schema fields, are Etched.

## Alternatives considered

### Hardcoded LIST logic in EdgeResolver
Works for LIST. Doesn't generalize. Every future cross-schema invariant requires EdgeResolver changes — but EdgeResolver is Etched. Rejected.

### Invariant declarations in schema field bitfield + generic ConstraintEvaluator
Adds a second Etched coordination slot beside the schema UID itself, violating ADR-0041's principle. Bitfield encoding becomes a 50-year decision on day one. Rejected.

### Resolver chains (multiple resolvers per schema)
Solves an upgradeability problem EFS deliberately doesn't have (resolvers are baked into schema UIDs). Adds complex composition semantics (ordering, partial failure). Rejected.

### PIN-only callbacks
Considered. Rejected on the grounds that EdgeResolver's address is baked into BOTH PIN and TAG schema UIDs; if TAG callbacks aren't possible at Sepolia, they're never possible. Three concrete near-term TAG cases (bounded buckets, mutual exclusion, weight ranges) justify shipping the full edge interface from day one. Avoiding the permanent PIN-vs-TAG asymmetry is decisive.

### Owner-only registration
Considered. Rejected as violating EFS's permissionless ethos. Future schemas need to register callbacks without central permission.

### Open registration (anyone can register)
Considered. Rejected — opens DoS via squatting (register a malicious veto callback for someone else's schema). Registration must be trust-anchored.

### `msg.sender == schema deployer`
Considered. Rejected — EAS doesn't preserve the schema-registration `msg.sender`; can't be verified on-chain.

### `msg.sender == schema's EAS resolver`
**Selected.** The schema's resolver is already trusted by EAS (its address is baked into the schema UID). Permissionless registration (anyone can deploy a schema with a resolver that registers a callback). Trust-anchored (only that resolver can install the callback).

### Pure `return bool` failure semantics (EAS-style)
Considered. Rejected because EAS's bool-return pattern swallows custom error reasons — when a resolver returns false, EAS reverts with a generic message. EFS callbacks want rich custom errors (`DuplicateListEntry(target)`, `BoundedListFull(max)`) visible in tx traces.

### Bare external call (no try/catch, no gas limit)
Considered. Rejected — a buggy or adversarial callback could OOG every legitimate write under that parent schema. Bounded gas is necessary for kernel safety.

### `try/catch` with bounded gas but generic error message
Considered. Rejected — swallows custom errors that callback authors invest in. The selected hybrid (try/catch + re-revert via assembly preserving inner reason bytes) gives both bounded gas and error fidelity.

### Failsafe-closed on selfdestructed callback (revert)
Considered. Rejected — if a callback contract is selfdestructed (deliberately or accidentally), every legitimate write under that schema would revert forever. Failsafe-open (silent no-op) matches "kernel keeps working when an overlay misbehaves."

## Notes for implementers

- The `getParent` call in dispatch should be factored from EdgeResolver's existing call at L250 (the `_childrenWithEdge` build path). Don't double-fetch.
- The `_eas.getAttestation(parentUID)` call in dispatch is necessary to get the parent's schema. Caching at the resolver level is not worth it; the call is cheap when warm.
- Address-target PINs (recipient ≠ 0, refUID = 0) STILL have a definition, which may have a parent. The dispatch fires based on `definition.parent.schema`, not the target. Document this clearly.
- Transient-storage reentrancy guard requires Solidity 0.8.24+ (EIP-1153). Current project uses 0.8.26.
- ERC-165 check at registration prevents installing wrong-interface contracts as callbacks.

## Open questions for cross-AI review

1. Is `int256 weight` in the interface signature correct for both PIN (where it's 0/ignored) and TAG (where it's load-bearing)? Or should `weight` be PIN-omitted via a split interface?
2. Should the dispatch fire BEFORE state commit (so the callback sees pre-write state and can inspect what's about to change) or AFTER (so the callback sees the committed state and validates the result)? Currently designed AFTER per Agent 1's reasoning. Trade-off worth surfacing.
3. Is the 100,000 gas budget right? Too low for callbacks that need to read multiple EAS attestations? Too high (encourages bloat)?
4. The dispatch fires per-edge-write. For batch attestations (`multiAttest`), is dispatch per-attestation or batched? Currently per-attestation. Confirm this is right.
5. Failsafe-open on selfdestruct: is this the right trade-off, or should we revert (failsafe-closed)?

## Provenance

Designed via 3 parallel subagent passes (interface variants, dispatch mechanism, generalization scope) followed by synthesis. Building on rounds 11-16 of the EFS Lists design work, where the need for this mechanism crystallized through repeated reviewer findings on `allowsDuplicates` enforcement and the broader pattern of cross-attestation invariants. See `docs/process/design-lessons.md` for the design-process retrospective.
