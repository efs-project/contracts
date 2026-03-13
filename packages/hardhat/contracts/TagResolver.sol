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

    // Singleton map: keccak256(attester, targetID, definition) => active attestation UID
    mapping(bytes32 => bytes32) private _activeTag;

    // Discovery: which definitions have ever been applied to a target
    mapping(bytes32 => bytes32[]) private _tagDefinitions;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasDefinition;

    // Discovery: which targets have ever been tagged with a definition
    mapping(bytes32 => bytes32[]) private _taggedTargets;
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasTarget;

    constructor(IEAS eas) SchemaResolver(eas) {}

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        (bytes32 definition, bool applies) = abi.decode(attestation.data, (bytes32, bool));

        bytes32 targetID = _resolveTargetID(attestation.refUID, attestation.recipient);

        bytes32 compositeHash = keccak256(abi.encodePacked(attestation.attester, targetID, definition));

        // Logical superseding: overwrite the active UID (old attestation stays on-chain but is ignored)
        _activeTag[compositeHash] = attestation.uid;

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
            delete _activeTag[compositeHash];
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

    /// @notice Get paginated list of targets ever tagged with a specific definition
    function getTaggedTargets(
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_taggedTargets[definition], start, length);
    }

    /// @notice Get count of targets ever tagged with a specific definition
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
