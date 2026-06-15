// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISchemaRegistry, SchemaRecord } from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

/// @dev Minimal interface for the EFSIndexer functions EdgeResolver needs.
interface IEFSIndexerForEdges {
    function index(bytes32 uid) external returns (bool);
    function indexRevocation(bytes32 uid) external;
    function getParent(bytes32 anchorUID) external view returns (bytes32);
    function propagateContains(bytes32 anchorUID, address attester) external;
    function clearContains(bytes32 anchorUID, address attester) external;
    function ANCHOR_SCHEMA_UID() external view returns (bytes32);
}

/**
 * @title EFSEdgeResolver
 * @dev SchemaResolver for the EFS PIN and TAG schemas. Both schemas describe an edge from
 *      an attester to a target under a definition (predicate). Cardinality lives in the
 *      schema UID itself:
 *
 *        PIN  — cardinality 1. At most one active PIN per (attester, definition, targetSchema).
 *               A new PIN at the same slot supersedes the prior one in O(1). Revoke clears.
 *               Maps to OWL owl:FunctionalProperty / Datomic :db.cardinality/one.
 *               Schema string: "bytes32 definition"
 *
 *        TAG  — cardinality N. List of active TAGs per (attester, definition, targetSchema),
 *               one entry per distinct (attester, target, definition) edgeHash. Each entry
 *               carries an int256 `weight`: generic per-entry metadata that consumers and
 *               overlays can read (sort key, score, ranking, etc.). Re-attesting the same
 *               edgeHash updates the weight in place; revoke removes the entry.
 *               Maps to a regular OWL property / Datomic :db.cardinality/many.
 *               Schema string: "bytes32 definition, int256 weight"
 *
 *      The two schemas have DIFFERENT on-wire shapes (1 field vs 2), so the EAS UIDs
 *      naturally differ — no field-name juggling needed. The resolver branches on
 *      `attestation.schema` BEFORE decoding to apply the right shape.
 *
 *      The shared bookkeeping (active-edge map, edge counts, discovery indices) is
 *      schema-AWARE — `_edgeHash` includes `attestation.schema` so a PIN and a TAG at the
 *      same (attester, target, definition) triple occupy independent slots and cannot
 *      corrupt each other's state. Aggregate counts (`_activeCount`,
 *      `_activeTotalByDefAndAttester`) stay schema-blind and sum across both schemas
 *      naturally — each schema's `wasActive` check is isolated, so increments and
 *      decrements compose correctly.
 *
 *      There is no "supersede via negative weight" mechanism. Either the edge exists
 *      (active) or it doesn't. Removal is always via EAS revoke; replacement is always
 *      via re-attestation at the same slot (PIN) or edgeHash (TAG).
 *
 *      Targeting uses native EAS fields (refUID → target attestation; recipient → target address).
 *
 *      ADR-0041 supersedes ADR-0035 on the cardinality story.
 *
 *      Upgradeable (ADR-0048): runs behind an ERC1967 proxy whose ADDRESS is the EAS resolver
 *      baked into both the PIN and TAG schema UIDs. The four former constructor immutables
 *      (PIN_SCHEMA_UID, TAG_SCHEMA_UID, indexer, schemaRegistry) moved into ERC-7201 namespaced
 *      storage (`efs.edge.config`) set once via initialize() — immutables live in the impl's
 *      bytecode and would read the impl's construction-time values, not the proxy's, under
 *      delegatecall. The three constructor invariants (pin≠0, tag≠0, pin≠tag) moved into
 *      initialize(). The heavy PIN/TAG state mappings keep their exact sequential slots (0–11):
 *      they are append-only, consensus-critical index state (ADR-0009) and are NOT migrated.
 *      The namespaced config slot lives high (away from the sequential mappings), so it cannot
 *      collide. EdgeResolver has no deployer/owner-gated functions, so it does NOT inherit
 *      OwnableUpgradeable — config is set exactly once in initialize() and never mutated after.
 */
contract EdgeResolver is EFSUpgradeableResolver {
    error MustTargetSomething();
    error InvalidDefinition();
    error InvalidTarget();
    error UnknownEdgeSchema();
    error NotRevocable();
    error HasExpiration();

    // ── Edge events (subgraph indexability, PR #24) ─────────────────────────────────────────────
    // EAS's own `Attested` carries no field data, and the kernel's generic `AttestationIndexed` carries
    // only (uid, schema, attester) — so without these a log-only indexer cannot see the PIN/TAG edge
    // (definition, target, weight) or PIN supersession. Indexed topics are the active-slot key readers
    // use: (definition, attester, targetSchema). `supersededPinUID` makes cardinality-1 PIN replacement
    // observable (bytes32(0) when the slot was empty or the same target was re-attested). A superseded
    // PIN emits NO PinCleared — its retirement is signalled by the next PinSet's `supersededPinUID`;
    // PinCleared fires only on an explicit revoke of the still-active PIN.
    event PinSet(
        bytes32 indexed definition,
        address indexed attester,
        bytes32 indexed targetSchema,
        bytes32 pinUID,
        bytes32 targetID,
        bytes32 supersededPinUID
    );
    event PinCleared(
        bytes32 indexed definition,
        address indexed attester,
        bytes32 indexed targetSchema,
        bytes32 pinUID,
        bytes32 targetID
    );
    event TagSet(
        bytes32 indexed definition,
        address indexed attester,
        bytes32 indexed targetSchema,
        bytes32 tagUID,
        bytes32 targetID,
        int256 weight
    );
    event TagCleared(
        bytes32 indexed definition,
        address indexed attester,
        bytes32 indexed targetSchema,
        bytes32 tagUID,
        bytes32 targetID
    );

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    // The two schema UIDs, the indexer, and the schemaRegistry were constructor immutables when
    // EdgeResolver was deployed directly. Under the upgradeable-proxy pattern (ADR-0048) the
    // implementation runs via the proxy's delegatecall, so immutables (which live in the impl's
    // bytecode) would read the impl's construction-time values, not the proxy's. They therefore
    // move into ERC-7201 namespaced storage written once in initialize(). Its OWN unique namespace
    // (NOT efs.indexer.config / efs.mirror.config). The namespaced slot sits far from slot 0, so it
    // cannot collide with the consensus-critical sequential mapping layout below (ADR-0009).

    /// @custom:storage-location erc7201:efs.edge.config
    struct EdgeConfig {
        bytes32 pinSchemaUID;
        bytes32 tagSchemaUID;
        IEFSIndexerForEdges indexer;
        ISchemaRegistry schemaRegistry;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.edge.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant EDGE_CONFIG_SLOT = 0xa7006bf19fd32b664fa0a26984d3f000dbb27df471e5d0cacd76f128f9d5e600;

    function _cfg() private pure returns (EdgeConfig storage $) {
        assembly {
            $.slot := EDGE_CONFIG_SLOT
        }
    }

    // Public getters preserved by NAME for ABI/consumer compatibility — they now read the ERC-7201
    // config struct instead of construction-time immutables.

    /// @notice The EAS schema UID for the PIN (cardinality 1) schema registered with this resolver.
    function PIN_SCHEMA_UID() public view returns (bytes32) {
        return _cfg().pinSchemaUID;
    }

    /// @notice The EAS schema UID for the TAG (cardinality N) schema registered with this resolver.
    function TAG_SCHEMA_UID() public view returns (bytes32) {
        return _cfg().tagSchemaUID;
    }

    /// @notice EFSIndexer reference — edge attestations are indexed so they are
    ///         discoverable via getReferencingAttestations like any other schema.
    function indexer() public view returns (IEFSIndexerForEdges) {
        return _cfg().indexer;
    }

    /// @notice SchemaRegistry reference — used to validate schema UID definitions.
    function schemaRegistry() public view returns (ISchemaRegistry) {
        return _cfg().schemaRegistry;
    }

    // ============================================================================================
    // STORAGE: SHARED ACTIVE-EDGE TRACKING (PIN and TAG, no cross-schema interference)
    // ============================================================================================

    // Schema-aware singleton: keccak256(attester, targetID, definition, schema) => active UID.
    // PIN and TAG entries occupy independent slots. Set on attestation, updated on
    // re-attestation, deleted on revoke or PIN supersede-by-different-target.
    mapping(bytes32 => bytes32) private _activeEdge;

    // Count of (attester, targetID, definition, schema) entries with a currently-active edge,
    // keyed by keccak256(targetID, definition). PIN and TAG both contribute. Used for
    // O(1) `hasActiveEdge` queries — `> 0` means "anyone is asserting (target, definition)
    // via either PIN or TAG." When the same attester has both PIN and TAG at the same
    // triple, this counter records 2 (one per schema); the boolean read is unaffected.
    mapping(bytes32 => uint256) private _activeCount;

    // Discovery: which definitions have ever been attested against a target (append-only).
    // PIN and TAG both contribute — discovery is cardinality-blind.
    mapping(bytes32 => bytes32[]) private _edgeDefinitions;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasEdgeDef;

    // Discovery: which targets have ever been attested under a definition (append-only).
    mapping(bytes32 => bytes32[]) private _targetsByDef;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasTargetForDef;

    // Discovery: child anchors with an active edge under a definition, scoped by parent
    // anchor (append-only). Both PIN and TAG contribute.
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _childrenWithEdge;
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => bool))) private _isChildWithEdge;

    // Total active edge count per (definition, attester) across both schemas. When this
    // hits zero, the indexer's _containsAttestations flag can be cleared for that folder.
    // Each schema independently increments/decrements its contribution; the unified
    // counter naturally sums them because the per-schema `wasActive` check is isolated.
    mapping(bytes32 => mapping(address => uint256)) private _activeTotalByDefAndAttester;

    // ============================================================================================
    // STORAGE: PIN (cardinality 1, O(1) singleton per slot)
    // ============================================================================================

    struct SlotEntry {
        bytes32 pinUID;
        bytes32 targetID;
    }

    // _activeBySlot[definition][attester][targetSchema] => SlotEntry
    // At most one active PIN per slot. A new PIN replaces any existing entry in O(1).
    mapping(bytes32 => mapping(address => mapping(bytes32 => SlotEntry))) private _activeBySlot;

    // ============================================================================================
    // STORAGE: TAG (cardinality N, append-and-swap-and-pop list per slot)
    // ============================================================================================

    struct TagEntry {
        bytes32 tagUID;
        int256 weight;
    }

    // _activeByAAS[definition][attester][targetSchema] => TagEntry[]
    // Widened from bytes32[] to TagEntry[] so on-chain consumers can read (uid, weight) tuples
    // in one bulk SLOAD per slot, avoiding the N+1 SLOAD pattern that would arise if weight
    // were stored in a side mapping (resolved per ADR-0041 / plan).
    mapping(bytes32 => mapping(address => mapping(bytes32 => TagEntry[]))) private _activeByAAS;

    // Position index for O(1) update / swap-and-pop:
    // _activeByAASIndex[definition][attester][targetSchema][edgeHash] => index+1 (0 = absent)
    // edgeHash here is the schema-aware hash; all entries in this map are TAG-side, so
    // every key carries TAG_SCHEMA_UID baked in.
    mapping(bytes32 => mapping(address => mapping(bytes32 => mapping(bytes32 => uint256)))) private _activeByAASIndex;

    /// @param eas The canonical EAS for the target chain. Stays a constructor immutable on the
    ///            base (EAS is a per-chain constant; see EFSUpgradeableResolver NatSpec). The base
    ///            constructor also runs `_disableInitializers()` so the implementation itself can
    ///            never be initialized — only a proxy can.
    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Sets the two schema UIDs
    ///      and the partner references, and enforces the three cardinality-split invariants that
    ///      were constructor `require`s when EdgeResolver was deployed directly.
    /// @param pinSchemaUID    The EAS schema UID for the PIN (cardinality 1) schema.
    /// @param tagSchemaUID    The EAS schema UID for the TAG (cardinality N) schema.
    /// @param indexer_        The EFSIndexer (proxy) this resolver indexes edges into.
    /// @param schemaRegistry_ The EAS SchemaRegistry, used to validate schema-UID definitions.
    function initialize(
        bytes32 pinSchemaUID,
        bytes32 tagSchemaUID,
        IEFSIndexerForEdges indexer_,
        ISchemaRegistry schemaRegistry_
    ) external initializer {
        require(pinSchemaUID != bytes32(0), "EdgeResolver: pinSchemaUID is zero");
        require(tagSchemaUID != bytes32(0), "EdgeResolver: tagSchemaUID is zero");
        require(pinSchemaUID != tagSchemaUID, "EdgeResolver: PIN and TAG schemas must differ");
        EdgeConfig storage $ = _cfg();
        $.pinSchemaUID = pinSchemaUID;
        $.tagSchemaUID = tagSchemaUID;
        $.indexer = indexer_;
        $.schemaRegistry = schemaRegistry_;
    }

    // ============================================================================================
    // INTERNAL: HASH HELPERS
    // ============================================================================================

    /// @dev Schema-aware edge hash. Including `schema` is the key safety property — it makes
    ///      PIN and TAG entries at the same (attester, target, definition) live in independent
    ///      slots. Without it, mixing PIN and TAG at one triple corrupts the active-edge map.
    function _edgeHash(
        address attester,
        bytes32 targetID,
        bytes32 definition,
        bytes32 schema
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(attester, targetID, definition, schema));
    }

    /// @dev Schema-blind aggregate hash for counts that intentionally sum across schemas.
    function _targetDefHash(bytes32 targetID, bytes32 definition) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(targetID, definition));
    }

    // ============================================================================================
    // RESOLVER HOOKS
    // ============================================================================================

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        EdgeConfig storage $ = _cfg();
        bytes32 pinSchema = $.pinSchemaUID;
        IEFSIndexerForEdges idx = $.indexer;

        // Branch on schema BEFORE decoding — PIN and TAG have different on-wire shapes
        // (PIN = `bytes32 definition`; TAG = `bytes32 definition, int256 weight`).
        bytes32 definition;
        int256 weight;
        bool isPin = attestation.schema == pinSchema;
        if (isPin) {
            definition = abi.decode(attestation.data, (bytes32));
            // weight stays 0 — unused for PIN (cardinality 1 has no per-entry metadata).
        } else if (attestation.schema == $.tagSchemaUID) {
            (definition, weight) = abi.decode(attestation.data, (bytes32, int256));
        } else {
            // Defensive: if the resolver is wired into an unknown schema, fail loudly.
            revert UnknownEdgeSchema();
        }

        // Lifecycle invariants — PIN/TAG edges are "active until explicitly revoked", with no
        // applies=false and no expiry (matches ListEntryResolver). A revocable *schema* only PERMITS
        // revocable attestations; EAS still accepts revocable=false (welds the edge on permanently)
        // and nonzero expirationTime (the edge silently expires but EFS reads filter on revocation,
        // not expiry, so it stays "active" forever). Reject both at write time.
        if (!attestation.revocable) revert NotRevocable();
        if (attestation.expirationTime != 0) revert HasExpiration();

        _validateDefinition(definition);

        bytes32 targetID = _resolveTargetID(attestation.refUID, attestation.recipient);

        // Cache target schema (one SLOAD instead of three downstream)
        bytes32 targetSchema;
        if (attestation.refUID != EMPTY_UID) {
            Attestation memory target = _eas.getAttestation(attestation.refUID);
            if (target.uid == bytes32(0)) revert InvalidTarget();
            targetSchema = target.schema;
        }

        // Schema-aware edge hash isolates PIN and TAG state at the same triple.
        bytes32 edgeHash = _edgeHash(attestation.attester, targetID, definition, attestation.schema);
        bytes32 targetDefHash = _targetDefHash(targetID, definition);

        bool wasActive = _activeEdge[edgeHash] != 0;

        // Maintain shared active count. Each schema independently tracks its own wasActive,
        // so increments compose correctly even when both PIN and TAG exist at the same triple
        // (the counter records 2; `> 0` semantics are preserved).
        if (!wasActive) {
            _activeCount[targetDefHash]++;
        }

        // Set the latest UID for this (attester, target, def, schema) entry.
        _activeEdge[edgeHash] = attestation.uid;

        // Dispatch to the per-schema active-set storage, then emit the indexable edge event.
        if (isPin) {
            bytes32 supersededPinUID = _onAttestPin(
                definition,
                attestation.attester,
                attestation.uid,
                targetID,
                targetSchema,
                wasActive
            );
            emit PinSet(definition, attestation.attester, targetSchema, attestation.uid, targetID, supersededPinUID);
        } else {
            _onAttestTag(definition, attestation.attester, attestation.uid, edgeHash, targetSchema, weight, wasActive);
            emit TagSet(definition, attestation.attester, targetSchema, attestation.uid, targetID, weight);
        }

        // Track discovery indices (append-only, never removed). Common to both schemas.
        if (!_hasEdgeDef[targetID][definition]) {
            _edgeDefinitions[targetID].push(definition);
            _hasEdgeDef[targetID][definition] = true;
        }
        if (!_hasTargetForDef[definition][targetID]) {
            _targetsByDef[definition].push(targetID);
            _hasTargetForDef[definition][targetID] = true;
        }

        // Build children-with-edge index (append-only). Both PIN and TAG contribute.
        if (attestation.refUID != EMPTY_UID) {
            bytes32 parent = idx.getParent(attestation.refUID);
            if (parent != bytes32(0) && !_isChildWithEdge[parent][definition][attestation.refUID]) {
                _childrenWithEdge[parent][definition].push(attestation.refUID);
                _isChildWithEdge[parent][definition][attestation.refUID] = true;
            }
        }

        // Propagate containsAttestations for structural placements (definition is an Anchor).
        // PIN is the typical placement schema, but TAG can also satisfy folder-visibility per ADR-0038.
        // See note on sticky-propagation in EFSIndexer.sol — flags are set on apply but not always
        // cleared, which is acceptable per the design.
        if (attestation.refUID != EMPTY_UID) {
            Attestation memory defAtt = _eas.getAttestation(definition);
            if (defAtt.schema == idx.ANCHOR_SCHEMA_UID()) {
                idx.propagateContains(definition, attestation.attester);
            }
        }

        // Register so this edge is discoverable via the indexer's generic queries.
        idx.index(attestation.uid);

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        EdgeConfig storage $ = _cfg();
        IEFSIndexerForEdges idx = $.indexer;

        // Branch on schema BEFORE decoding (same shape rationale as onAttest).
        bytes32 definition;
        bool isPin = attestation.schema == $.pinSchemaUID;
        if (isPin) {
            definition = abi.decode(attestation.data, (bytes32));
        } else if (attestation.schema == $.tagSchemaUID) {
            (definition, ) = abi.decode(attestation.data, (bytes32, int256));
        } else {
            revert UnknownEdgeSchema();
        }

        bytes32 targetID = _resolveTargetID(attestation.refUID, attestation.recipient);
        bytes32 edgeHash = _edgeHash(attestation.attester, targetID, definition, attestation.schema);

        // Only act if this is still the active UID — could already have been superseded
        // (e.g. a PIN whose slot was overwritten by a later PIN at a different target).
        if (_activeEdge[edgeHash] == attestation.uid) {
            bytes32 targetDefHash = _targetDefHash(targetID, definition);
            _activeCount[targetDefHash]--;

            // Resolve targetSchema symmetrically to onAttest: for a real target attestation,
            // read its schema; for an address target (refUID = 0), the sentinel is bytes32(0).
            // The slot/AAS write path uses the same sentinel, so cleanup must too — otherwise
            // address-target edges would never be removed from `_activeBySlot` / `_activeByAAS`
            // even after a successful revoke (ADR-0041 §2: recipient targeting is first-class).
            bytes32 targetSchema;
            if (attestation.refUID != EMPTY_UID) {
                Attestation memory target = _eas.getAttestation(attestation.refUID);
                targetSchema = target.schema;
            }

            // Slot/AAS cleanup is unconditional — address-target edges live in
            // `_activeBySlot[def][attester][bytes32(0)]` and need their slot cleared too.
            // We're inside `_activeEdge[edgeHash] == attestation.uid`, so this UID is still the active
            // edge (a superseded PIN would have had its _activeEdge entry deleted in _onAttestPin) — the
            // cleared event therefore reflects a real active→inactive transition for the indexer.
            if (isPin) {
                _clearPinSlot(definition, attestation.attester, targetSchema, attestation.uid);
                emit PinCleared(definition, attestation.attester, targetSchema, attestation.uid, targetID);
            } else {
                _swapAndPopTag(definition, attestation.attester, targetSchema, edgeHash);
                emit TagCleared(definition, attestation.attester, targetSchema, attestation.uid, targetID);
            }

            // The contains-flag bookkeeping (`_activeTotalByDefAndAttester` +
            // `indexer.clearContains`) is the SYMMETRIC pair of `propagateContains` in
            // onAttest, which only fires for structural edges (`refUID != EMPTY_UID`).
            // Address-target edges never propagate up the anchor tree, so they must not
            // drive contains state on revoke either — otherwise revoking an attester's
            // address-target edge under an anchor they themselves created would clear
            // their own contains bit (set at anchor creation by EFSIndexer).
            // Increment in `_onAttestPin` / `_onAttestTag` is gated on the same condition
            // (`targetSchema != bytes32(0)`), so increment and decrement compose correctly.
            if (attestation.refUID != EMPTY_UID) {
                if (_activeTotalByDefAndAttester[definition][attestation.attester] > 0) {
                    _activeTotalByDefAndAttester[definition][attestation.attester]--;
                }
                if (_activeTotalByDefAndAttester[definition][attestation.attester] == 0) {
                    Attestation memory defAtt = _eas.getAttestation(definition);
                    if (defAtt.schema == idx.ANCHOR_SCHEMA_UID()) {
                        idx.clearContains(definition, attestation.attester);
                    }
                }
            }

            delete _activeEdge[edgeHash];
        }

        // Mirror revocation into EFSIndexer so isRevoked() stays in sync.
        idx.indexRevocation(attestation.uid);

        return true;
    }

    // ============================================================================================
    // INTERNAL: PER-SCHEMA WRITE PATHS
    // ============================================================================================

    /// @dev Write path for a PIN attestation. Updates _activeBySlot in O(1).
    ///      A new PIN at the same (attester, def, schema) slot but different target supersedes
    ///      the prior one — the prior edgeHash is cleared from _activeEdge so a later
    ///      revoke of the prior PIN is a no-op.
    ///
    ///      `targetSchema = bytes32(0)` is the canonical sentinel for address-target edges
    ///      (refUID = 0, recipient = the target address). ADR-0041 §2 lists the recipient
    ///      route as a first-class targeting mode, so address-target PINs occupy
    ///      `_activeBySlot[def][attester][bytes32(0)]` like any other slot. Reads remain
    ///      O(1) — `getActivePinTarget(def, attester, bytes32(0))` returns the active
    ///      address target (encoded as `bytes32(uint160(addr))` per `_resolveTargetID`).
    function _onAttestPin(
        bytes32 definition,
        address attester,
        bytes32 pinUID,
        bytes32 targetID,
        bytes32 targetSchema,
        bool wasActive
    ) private returns (bytes32 supersededPinUID) {
        SlotEntry storage slot = _activeBySlot[definition][attester][targetSchema];

        // If a different prior PIN occupied this slot, supersede it. Capture the retired UID so onAttest
        // can surface it in PinSet (cardinality-1 replacement is otherwise invisible to a log indexer).
        if (slot.pinUID != bytes32(0) && slot.targetID != targetID) {
            supersededPinUID = slot.pinUID;
            // Schema-aware: the prior edge lived at the PIN slot for the prior targetID.
            bytes32 priorEdgeHash = _edgeHash(attester, slot.targetID, definition, PIN_SCHEMA_UID());
            // Only clean up counts if the prior edge entry hasn't already been cleared
            // (defensive — ordinarily it matches because we wrote it ourselves earlier).
            if (_activeEdge[priorEdgeHash] == slot.pinUID) {
                delete _activeEdge[priorEdgeHash];
                bytes32 priorTargetDefHash = _targetDefHash(slot.targetID, definition);
                if (_activeCount[priorTargetDefHash] > 0) {
                    _activeCount[priorTargetDefHash]--;
                }
                // _activeTotalByDefAndAttester only counts STRUCTURAL edges (paired with
                // propagateContains/clearContains). Address-target PINs (targetSchema == 0)
                // never contributed on attest, so don't decrement on supersede either.
                if (targetSchema != bytes32(0) && _activeTotalByDefAndAttester[definition][attester] > 0) {
                    _activeTotalByDefAndAttester[definition][attester]--;
                }
            }
        }

        slot.pinUID = pinUID;
        slot.targetID = targetID;

        // Structural edges only — see counter-purpose note above and onRevoke comment.
        if (!wasActive && targetSchema != bytes32(0)) {
            _activeTotalByDefAndAttester[definition][attester]++;
        }
    }

    /// @dev Write path for a TAG attestation. Updates _activeByAAS list. New edgeHash
    ///      appends; existing edgeHash updates UID + weight in place.
    ///
    ///      `targetSchema = bytes32(0)` is the canonical sentinel for address-target TAGs
    ///      (refUID = 0, recipient = the target address) — per ADR-0041 §2 the recipient
    ///      route is a first-class targeting mode, so these accumulate at
    ///      `_activeByAAS[def][attester][bytes32(0)]` like any other slot.
    function _onAttestTag(
        bytes32 definition,
        address attester,
        bytes32 tagUID,
        bytes32 edgeHash,
        bytes32 targetSchema,
        int256 weight,
        bool wasActive
    ) private {
        TagEntry[] storage arr = _activeByAAS[definition][attester][targetSchema];
        uint256 indexPlusOne = _activeByAASIndex[definition][attester][targetSchema][edgeHash];

        if (indexPlusOne == 0) {
            // First TAG at this edgeHash — append.
            arr.push(TagEntry({ tagUID: tagUID, weight: weight }));
            _activeByAASIndex[definition][attester][targetSchema][edgeHash] = arr.length;
            // Structural edges only — `_activeTotalByDefAndAttester` is paired with
            // `propagateContains` (gated on `refUID != EMPTY_UID` in onAttest), so
            // address-target TAGs (targetSchema == 0) must not contribute or revoke
            // would over-clear the contains flag (see onRevoke comment).
            //
            // Note: when `definition` is a schema UID (e.g. DATA_SCHEMA_UID for
            // folder-visibility TAGs per ADR-0038), the counter still increments/
            // decrements correctly.  When it reaches zero, `clearContains(definition,
            // attester)` is called in EFSIndexer, but EFSIndexer guards on
            // `eas.getAttestation(anchorUID).schema == ANCHOR_SCHEMA_UID` — schema
            // UIDs are not EAS attestations, so that guard fails and clearContains
            // is effectively a no-op for those definitions.  This is intentional:
            // schema-UID definitions don't carry an EFS `_containsAttestations` flag.
            if (!wasActive && targetSchema != bytes32(0)) {
                _activeTotalByDefAndAttester[definition][attester]++;
            }
        } else {
            // Re-attestation of the same edgeHash — update UID + weight in place.
            uint256 pos = indexPlusOne - 1;
            arr[pos].tagUID = tagUID;
            arr[pos].weight = weight;
            // wasActive is necessarily true here (entry already in arr); no count change.
        }
    }

    /// @dev Clear a PIN slot iff the held entry's UID matches `expectedUID` (revocation path).
    function _clearPinSlot(bytes32 definition, address attester, bytes32 targetSchema, bytes32 expectedUID) private {
        SlotEntry storage slot = _activeBySlot[definition][attester][targetSchema];
        if (slot.pinUID == expectedUID) {
            delete _activeBySlot[definition][attester][targetSchema];
        }
    }

    /// @dev Swap-and-pop a TAG entry from _activeByAAS, given a known edgeHash.
    function _swapAndPopTag(bytes32 definition, address attester, bytes32 targetSchema, bytes32 edgeHash) private {
        TagEntry[] storage arr = _activeByAAS[definition][attester][targetSchema];
        _swapAndPopTagAt(arr, _activeByAASIndex[definition][attester][targetSchema], edgeHash);
    }

    /// @dev Swap-and-pop helper that takes the array and index map by reference.
    ///      We pass a single mapping (edgeHash => index+1) — the inner mapping at the
    ///      [definition][attester][targetSchema] level — so we can reuse logic across paths.
    function _swapAndPopTagAt(
        TagEntry[] storage arr,
        mapping(bytes32 => uint256) storage indexMap,
        bytes32 edgeHash
    ) private {
        uint256 indexPlusOne = indexMap[edgeHash];
        if (indexPlusOne == 0) return;

        uint256 pos = indexPlusOne - 1;
        uint256 lastIdx = arr.length - 1;

        if (pos != lastIdx) {
            TagEntry memory lastEntry = arr[lastIdx];
            arr[pos] = lastEntry;
            // Recompute the moved entry's edgeHash so we can update its index. We don't
            // carry (attester, targetID, definition) here — read the moved tagUID's source
            // attestation and rebuild the hash. This is one extra EAS read but only on actual
            // swap (not on every pop), which is acceptable.
            //
            // Only TAG attestations live in _activeByAAS, so the schema is always
            // TAG_SCHEMA_UID and the decode shape is always TAG's (bytes32, int256).
            Attestation memory moved = _eas.getAttestation(lastEntry.tagUID);
            // Every UID stored in _activeByAAS was placed via onAttest, so it must always
            // resolve. A zero uid here means index corruption — revert rather than silently
            // writing a bad hash into the index map.
            if (moved.uid == bytes32(0)) revert InvalidTarget();
            (bytes32 movedDef, ) = abi.decode(moved.data, (bytes32, int256));
            bytes32 movedTargetID = _resolveTargetID(moved.refUID, moved.recipient);
            bytes32 movedHash = _edgeHash(moved.attester, movedTargetID, movedDef, TAG_SCHEMA_UID());
            indexMap[movedHash] = pos + 1;
        }

        arr.pop();
        delete indexMap[edgeHash];
    }

    // ============================================================================================
    // INTERNAL: VALIDATION & TARGET RESOLUTION
    // ============================================================================================

    function _validateDefinition(bytes32 definition) private view {
        if (definition == bytes32(0)) revert InvalidDefinition();

        // 1. Address? (cheapest — no external call; upper 12 bytes must be zero)
        if (uint256(definition) <= type(uint160).max) return;

        // 2. Registered schema? (fewer schemas than attestations; schemas win on conflict)
        SchemaRecord memory sr = schemaRegistry().getSchema(definition);
        if (sr.uid != bytes32(0)) return;

        // 3. Existing attestation?
        Attestation memory att = _eas.getAttestation(definition);
        if (att.uid != bytes32(0)) return;

        revert InvalidDefinition();
    }

    function _resolveTargetID(bytes32 refUID, address recipient) private pure returns (bytes32) {
        if (refUID != EMPTY_UID) return refUID;
        if (recipient != address(0)) return bytes32(uint256(uint160(recipient)));
        revert MustTargetSomething();
    }

    // ============================================================================================
    // READ FUNCTIONS: SHARED (PIN + TAG)
    // ============================================================================================

    /// @notice Get the currently-active edge UID for (attester, target, definition, schema),
    ///         or 0x0 if none. Schema-aware — caller MUST specify whether they want the PIN
    ///         entry or the TAG entry. (PIN and TAG can coexist at the same triple.)
    function getActiveEdgeUID(
        address attester,
        bytes32 targetID,
        bytes32 definition,
        bytes32 schema
    ) external view returns (bytes32) {
        return _activeEdge[_edgeHash(attester, targetID, definition, schema)];
    }

    /// @notice True iff `attester` currently has an active edge of the given schema on
    ///         (targetID, definition). Schema-aware variant.
    function isActiveEdge(
        address attester,
        bytes32 targetID,
        bytes32 definition,
        bytes32 schema
    ) external view returns (bool) {
        return _activeEdge[_edgeHash(attester, targetID, definition, schema)] != bytes32(0);
    }

    /// @notice True iff `attester` has any active edge (PIN or TAG) on (targetID, definition).
    ///         Schema-blind — checks both schemas in two SLOADs.
    function isActiveEdgeAnySchema(
        address attester,
        bytes32 targetID,
        bytes32 definition
    ) external view returns (bool) {
        return
            _activeEdge[_edgeHash(attester, targetID, definition, PIN_SCHEMA_UID())] != bytes32(0) ||
            _activeEdge[_edgeHash(attester, targetID, definition, TAG_SCHEMA_UID())] != bytes32(0);
    }

    /// @notice True iff anyone currently has an active edge (PIN or TAG) on (targetID, definition).
    ///         O(1) via the shared aggregate counter.
    function hasActiveEdge(bytes32 targetID, bytes32 definition) external view returns (bool) {
        return _activeCount[_targetDefHash(targetID, definition)] > 0;
    }

    /// @notice Lens-aware: true iff ANY of `attesters` has an active edge (PIN or TAG)
    ///         on (targetID, definition). Two SLOADs per attester (PIN and TAG variants).
    ///         Schema-blind — use `hasActiveTagFromAny` for TAG-specific checks (e.g. folder
    ///         visibility per ADR-0038 which is TAG-only, not PIN-or-TAG).
    function hasActiveEdgeFromAny(
        bytes32 targetID,
        bytes32 definition,
        address[] calldata attesters
    ) external view returns (bool) {
        for (uint256 i = 0; i < attesters.length; i++) {
            if (
                _activeEdge[_edgeHash(attesters[i], targetID, definition, PIN_SCHEMA_UID())] != bytes32(0) ||
                _activeEdge[_edgeHash(attesters[i], targetID, definition, TAG_SCHEMA_UID())] != bytes32(0)
            ) return true;
        }
        return false;
    }

    /// @notice Lens-aware, TAG-specific: true iff ANY of `attesters` has an active TAG on
    ///         (targetID, definition). One SLOAD per attester.
    ///
    ///         Use this — not `hasActiveEdgeFromAny` — for folder-visibility checks (ADR-0038):
    ///         folder visibility is TAG-only; a PIN with `definition=DATA_SCHEMA_UID` targeting a
    ///         folder must NOT make that folder appear in lens-scoped directory listings.
    function hasActiveTagFromAny(
        bytes32 targetID,
        bytes32 definition,
        address[] calldata attesters
    ) external view returns (bool) {
        for (uint256 i = 0; i < attesters.length; i++) {
            if (_activeEdge[_edgeHash(attesters[i], targetID, definition, TAG_SCHEMA_UID())] != bytes32(0)) return true;
        }
        return false;
    }

    /// @notice PIN-specific single-attester check: true iff `attester` has an active PIN on
    ///         (targetID, definition). One SLOAD.
    ///
    ///         Use this — not `isActiveEdgeAnySchema` — for cross-attester file-placement dedup
    ///         in `getFilesAtPath` (ADR-0041): file placement is PIN-only (Shape A); a TAG from
    ///         an earlier attester must NOT suppress a later attester's valid PIN placement.
    function isActivePinEdge(address attester, bytes32 targetID, bytes32 definition) external view returns (bool) {
        return _activeEdge[_edgeHash(attester, targetID, definition, PIN_SCHEMA_UID())] != bytes32(0);
    }

    /// @notice Append-only discovery: definitions ever attested against a target (PIN or TAG).
    function getEdgeDefinitions(
        bytes32 targetID,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_edgeDefinitions[targetID], start, length);
    }

    function getEdgeDefinitionCount(bytes32 targetID) external view returns (uint256) {
        return _edgeDefinitions[targetID].length;
    }

    /// @notice Append-only discovery: targets ever attested under a definition (PIN or TAG).
    function getTargetsByDefinition(
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_targetsByDef[definition], start, length);
    }

    function getTargetsByDefinitionCount(bytes32 definition) external view returns (uint256) {
        return _targetsByDef[definition].length;
    }

    /// @notice Append-only discovery: child anchors with an active edge (PIN or TAG) under
    ///         a definition, scoped by parent.
    function getChildrenWithEdge(
        bytes32 parentUID,
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenWithEdge[parentUID][definition], start, length);
    }

    function getChildrenWithEdgeCount(bytes32 parentUID, bytes32 definition) external view returns (uint256) {
        return _childrenWithEdge[parentUID][definition].length;
    }

    // ============================================================================================
    // READ FUNCTIONS: PIN (cardinality 1)
    // ============================================================================================

    /// @notice O(1) read of the active PIN attestation UID for a (definition, attester, schema) slot.
    function getActivePin(bytes32 definition, address attester, bytes32 targetSchema) external view returns (bytes32) {
        return _activeBySlot[definition][attester][targetSchema].pinUID;
    }

    /// @notice O(1) read of the active PIN's target UID. Primary read for Shape A consumers
    ///         (file placement, PROPERTY value binding, contentType, etc.).
    function getActivePinTarget(
        bytes32 definition,
        address attester,
        bytes32 targetSchema
    ) external view returns (bytes32) {
        return _activeBySlot[definition][attester][targetSchema].targetID;
    }

    /// @notice O(1) read of the active PIN as a (pinUID, targetID) tuple.
    function getActivePinSlot(
        bytes32 definition,
        address attester,
        bytes32 targetSchema
    ) external view returns (SlotEntry memory) {
        return _activeBySlot[definition][attester][targetSchema];
    }

    // ============================================================================================
    // READ FUNCTIONS: TAG (cardinality N)
    // ============================================================================================

    /// @notice Get active TAG entries (tagUID + weight) for a (definition, attester, schema) slot.
    ///         Primary list reader: returns tuples in one bulk SLOAD per slot, so on-chain consumers
    ///         can sort by weight without an N+1 SLOAD pattern. ADR-0041.
    function getActiveTagEntries(
        bytes32 definition,
        address attester,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (TagEntry[] memory) {
        return _sliceTagEntries(_activeByAAS[definition][attester][schema], start, length);
    }

    /// @notice Convenience: drop weights and return only the active TAG attestation UIDs.
    function getActiveTags(
        bytes32 definition,
        address attester,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        TagEntry[] storage entries = _activeByAAS[definition][attester][schema];
        uint256 total = entries.length;
        if (total == 0 || start >= total) return new bytes32[](0);
        uint256 len = length;
        if (total < start + length) len = total - start;
        bytes32[] memory res = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) res[i] = entries[start + i].tagUID;
        return res;
    }

    /// @notice Convenience: resolve TAG entries back to their target IDs.
    ///         Mirrors the legacy getActiveTargetsByAttesterAndSchema return shape.
    function getActiveTargetsByAttesterAndSchema(
        bytes32 definition,
        address attester,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        TagEntry[] storage entries = _activeByAAS[definition][attester][schema];
        uint256 total = entries.length;
        if (total == 0 || start >= total) return new bytes32[](0);
        uint256 len = length;
        if (total < start + length) len = total - start;
        bytes32[] memory res = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) {
            // Resolve the stored tagUID back to its target. This is a per-entry EAS read; for
            // a sortable bulk read prefer getActiveTagEntries (which returns weights inline) and
            // resolve targets only as needed.
            Attestation memory att = _eas.getAttestation(entries[start + i].tagUID);
            res[i] = _resolveTargetID(att.refUID, att.recipient);
        }
        return res;
    }

    function getActiveTagsCount(bytes32 definition, address attester, bytes32 schema) external view returns (uint256) {
        return _activeByAAS[definition][attester][schema].length;
    }

    /// @notice O(1) read of the raw stored weight of the active TAG `(definition, attester, targetSchema)`
    ///         whose target is `target`, or `(false, 0)` if no such active TAG exists.
    ///
    ///         Pure read over the existing `_activeByAASIndex` / `_activeByAAS` storage — an index
    ///         lookup followed by the struct read, never a list scan. No new storage, no write-path
    ///         change. The kernel stays weight-neutral (ADR-0041 §4): the raw `int256` weight is
    ///         returned verbatim, with no sign/magnitude interpretation. Callers that want a
    ///         threshold policy (e.g. ADR-0042's `weight >= 0`, or ADR-0048's view-layer exclusion
    ///         filter) apply it themselves.
    ///
    ///         `targetSchema = bytes32(0)` is the canonical sentinel for an address-target TAG
    ///         (refUID = 0, recipient = the target address), matching the write path.
    /// @param attester     The TAG's attester (lens).
    /// @param target       The TAG's target — a target attestation UID, or `bytes32(uint160(addr))`
    ///                     for an address-target TAG.
    /// @param definition   The TAG predicate (e.g. the descriptive-label definition).
    /// @param targetSchema The schema bucket of the target (`bytes32(0)` for address targets).
    /// @return exists      True iff an active (unrevoked) TAG at this edge exists.
    /// @return weight      The raw stored `int256` weight (0 when `exists` is false).
    function getActiveTagWeight(
        address attester,
        bytes32 target,
        bytes32 definition,
        bytes32 targetSchema
    ) external view returns (bool exists, int256 weight) {
        bytes32 edgeHash = _edgeHash(attester, target, definition, TAG_SCHEMA_UID);
        uint256 indexPlusOne = _activeByAASIndex[definition][attester][targetSchema][edgeHash];
        if (indexPlusOne == 0) return (false, 0);
        return (true, _activeByAAS[definition][attester][targetSchema][indexPlusOne - 1].weight);
    }

    /// @notice Legacy alias retained for callers still on the bytes32[]-array name.
    function getActiveTargetsByAttesterAndSchemaCount(
        bytes32 definition,
        address attester,
        bytes32 schema
    ) external view returns (uint256) {
        return _activeByAAS[definition][attester][schema].length;
    }

    // ============================================================================================
    // INTERNAL: SLICING HELPERS
    // ============================================================================================

    function _sliceUIDs(bytes32[] storage uids, uint256 start, uint256 length) private view returns (bytes32[] memory) {
        uint256 total = uids.length;
        if (total == 0 || start >= total) return new bytes32[](0);
        uint256 len = length;
        if (total < start + length) len = total - start;
        bytes32[] memory res = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) res[i] = uids[start + i];
        return res;
    }

    function _sliceTagEntries(
        TagEntry[] storage entries,
        uint256 start,
        uint256 length
    ) private view returns (TagEntry[] memory) {
        uint256 total = entries.length;
        if (total == 0 || start >= total) return new TagEntry[](0);
        uint256 len = length;
        if (total < start + length) len = total - start;
        TagEntry[] memory res = new TagEntry[](len);
        for (uint256 i = 0; i < len; ++i) res[i] = entries[start + i];
        return res;
    }
}
