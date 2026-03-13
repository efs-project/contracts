// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/**
 * @title EFSTagResolver
 * @dev SchemaResolver for the EFS Tag schema. Enforces a singleton tagging pattern:
 *      one active tag per (attester, target, definition) triple. When a user applies
 *      a new tag matching an existing combination, the mapping is overwritten (logical
 *      superseding) so query functions always return the latest state.
 *
 *      Tag schema: "bytes32 definition, bool applies"
 *        - definition: Anchor UID defining the tag label ("Type as Topic" pattern)
 *        - applies: true = tag active, false = tag negated
 *      Targeting uses native EAS fields:
 *        - refUID → target attestation
 *        - recipient → target address
 */
contract TagResolver is SchemaResolver {
    error MustTargetSomething();

    /// @notice The EAS schema UID for the Tag schema registered with this resolver
    bytes32 public immutable TAG_SCHEMA_UID;

    // Singleton map: keccak256(attester, targetID, definition) => active attestation UID
    mapping(bytes32 => bytes32) private _activeTag;

    // Tracks whether the current active tag for each (attester, targetID, definition) triple
    // has applies=true. Used to maintain _activeCount without decoding old attestations.
    mapping(bytes32 => bool) private _isApplied;

    // Count of unique (attester, targetID, definition) triples with an active applies=true tag,
    // keyed by keccak256(targetID, definition). Enables O(1) isActivelyTagged queries.
    mapping(bytes32 => uint256) private _activeCount;

    // Discovery: which definitions have ever been applied to a target
    mapping(bytes32 => bytes32[]) private _tagDefinitions;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasDefinition;

    // Discovery: which targets have ever been tagged with a definition
    mapping(bytes32 => bytes32[]) private _taggedTargets;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasTarget;

    constructor(IEAS eas, bytes32 tagSchemaUID) SchemaResolver(eas) {
        TAG_SCHEMA_UID = tagSchemaUID;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        (bytes32 definition, bool applies) = abi.decode(attestation.data, (bytes32, bool));

        bytes32 targetID = _resolveTargetID(attestation.refUID, attestation.recipient);

        bytes32 compositeHash = keccak256(abi.encodePacked(attestation.attester, targetID, definition));
        bytes32 targetDefHash = keccak256(abi.encodePacked(targetID, definition));

        // Update active count: track transitions between applied and not-applied states.
        // _isApplied defaults false, so a zero _activeTag entry is treated as "not applied".
        bool oldApplied = _isApplied[compositeHash];
        if (applies && !oldApplied) {
            _activeCount[targetDefHash]++;
        } else if (!applies && oldApplied) {
            _activeCount[targetDefHash]--;
        }

        // Logical superseding: overwrite the active UID (old attestation stays on-chain but is ignored)
        _activeTag[compositeHash] = attestation.uid;
        _isApplied[compositeHash] = applies;

        // Track discovery indices (append-only, never removed)
        if (applies) {
            if (!_hasDefinition[targetID][definition]) {
                _tagDefinitions[targetID].push(definition);
                _hasDefinition[targetID][definition] = true;
            }
            if (!_hasTarget[definition][targetID]) {
                _taggedTargets[definition].push(targetID);
                _hasTarget[definition][targetID] = true;
            }
        }

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        (bytes32 definition, ) = abi.decode(attestation.data, (bytes32, bool));

        bytes32 targetID = _resolveTargetID(attestation.refUID, attestation.recipient);

        bytes32 compositeHash = keccak256(abi.encodePacked(attestation.attester, targetID, definition));

        // Only clear if this is still the active UID (could have been superseded already)
        if (_activeTag[compositeHash] == attestation.uid) {
            if (_isApplied[compositeHash]) {
                bytes32 targetDefHash = keccak256(abi.encodePacked(targetID, definition));
                _activeCount[targetDefHash]--;
            }
            delete _activeTag[compositeHash];
            delete _isApplied[compositeHash];
        }

        return true;
    }

    // ============================================================================================
    // READ FUNCTIONS
    // ============================================================================================

    /// @notice Get the active tag attestation UID for a specific (attester, target, definition) triple
    function getActiveTagUID(address attester, bytes32 targetID, bytes32 definition) external view returns (bytes32) {
        bytes32 compositeHash = keccak256(abi.encodePacked(attester, targetID, definition));
        return _activeTag[compositeHash];
    }

    /// @notice Returns true if any attester currently has an active applies=true tag on this
    ///         (targetID, definition) pair. Uses an O(1) counter maintained by onAttest/onRevoke,
    ///         so callers do not need to cross-reference the append-only discovery lists.
    function isActivelyTagged(bytes32 targetID, bytes32 definition) external view returns (bool) {
        bytes32 targetDefHash = keccak256(abi.encodePacked(targetID, definition));
        return _activeCount[targetDefHash] > 0;
    }

    /// @notice Get paginated list of tag definitions ever applied to a target
    function getTagDefinitions(
        bytes32 targetID,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_tagDefinitions[targetID], start, length);
    }

    /// @notice Get count of tag definitions ever applied to a target
    function getTagDefinitionCount(bytes32 targetID) external view returns (uint256) {
        return _tagDefinitions[targetID].length;
    }

    /// @notice Get paginated list of targets ever tagged with a specific definition (append-only)
    function getTaggedTargets(
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_taggedTargets[definition], start, length);
    }

    /// @notice Get count of targets ever tagged with a specific definition (append-only)
    function getTaggedTargetCount(bytes32 definition) external view returns (uint256) {
        return _taggedTargets[definition].length;
    }

    // ============================================================================================
    // INTERNAL HELPERS
    // ============================================================================================

    function _resolveTargetID(bytes32 refUID, address recipient) private pure returns (bytes32) {
        if (refUID != EMPTY_UID) {
            return refUID;
        }
        if (recipient != address(0)) {
            return bytes32(uint256(uint160(recipient)));
        }
        revert MustTargetSomething();
    }

    function _sliceUIDs(
        bytes32[] storage uids,
        uint256 start,
        uint256 length
    ) private view returns (bytes32[] memory) {
        uint256 total = uids.length;
        if (total == 0 || start >= total) {
            return new bytes32[](0);
        }

        uint256 len = length;
        if (total < start + length) {
            len = total - start;
        }

        bytes32[] memory res = new bytes32[](len);
        for (uint256 i = 0; i < len; ++i) {
            res[i] = uids[start + i];
        }
        return res;
    }
}
