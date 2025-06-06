// SPDX-License-Identifier: MIT

pragma solidity 0.8.28;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { Semver } from "@ethereum-attestation-service/eas-contracts/contracts/Semver.sol";

/// @title Indexer
/// @notice Indexing Service for the Ethereum Attestation Service
contract Indexer is Semver {
    error InvalidEAS();
    error InvalidAttestation();
    error InvalidOffset();

    /// @notice Emitted when an attestation has been indexed.
    /// @param uid The UID the attestation.
    event Indexed(bytes32 indexed uid);

    /// A mapping between an attestation and its referencing attestations.
    mapping(bytes32 attestationUID => mapping(bytes32 schemaUID => bytes32[] uids) referencingAttestations) private _referencingAttestations;

    /// A mapping between an attestation and its referencing attestations indexed by user.
    mapping(bytes32 attestationUID => mapping(bytes32 schemaUID => mapping(address attester => bytes32[] uids)) referencingAttestationsByAddress) private _referencingAttestationsByAddress;

    /// A mapping between an account and its received attestations.
    mapping(address account => mapping(bytes32 schemaUID => bytes32[] uids) receivedAttestations) private _receivedAttestations;

    // A mapping between an account and its sent attestations.
    mapping(address account => mapping(bytes32 schemaUID => bytes32[] uids) sentAttestations) private _sentAttestations;

    // A mapping between a schema, attester, and recipient.
    mapping(bytes32 schemaUID => mapping(address attester => mapping(address recipient => bytes32[] uids)))
        private _schemaAttesterRecipientAttestations;

    // A mapping between a schema and its attestations.
    mapping(bytes32 schemaUID => bytes32[] uids) private _schemaAttestations;

    // The global mapping of attestation indexing status.
    mapping(bytes32 attestationUID => bool status) private _indexedAttestations;

    // The address of the global EAS contract.
    IEAS private immutable _eas;

    // Previously deployed Indexer contract address.
    address private immutable _prevIndexer;

    /// @dev Creates a new Indexer instance.
    /// @param eas The address of the global EAS contract.
    constructor(IEAS eas, address prevIndexer) Semver(2, 0, 0) {
        if (address(eas) == address(0)) {
            revert InvalidEAS();
        }
        if (prevIndexer != address(0)) {
            _prevIndexer = prevIndexer;
        }

        _eas = eas;
    }

    /// @notice Returns the EAS.
    function getEAS() external view returns (IEAS) {
        return _eas;
    }

    /// @notice Returns the previously deployed EAS Indexer.
    function getPrevIndexer() external view returns (address) {
        return _prevIndexer;
    }

    /// @notice Indexes an existing attestation.
    /// @param attestationUID The UID of the attestation to index.
    function indexAttestation(bytes32 attestationUID) external {
        _indexAttestation(attestationUID);
    }

    /// @notice Indexes multiple existing attestations.
    /// @param attestationUIDs The UIDs of the attestations to index.
    function indexAttestations(bytes32[] calldata attestationUIDs) external {
        uint256 length = attestationUIDs.length;
        for (uint256 i = 0; i < length; ++i) {
            _indexAttestation(attestationUIDs[i]);
        }
    }

    /// @notice Returns whether an existing attestation has been already indexed.
    /// @param attestationUID The UID of the attestation to check.
    /// @return Whether an attestation has been already indexed.
    function isAttestationIndexed(bytes32 attestationUID) external view returns (bool) {
        return _indexedAttestations[attestationUID];
    }

    /// @notice Returns the UIDs of attestations referencing a specific attestation.
    /// @param attestionUID The UID of the attestation being referenced.
    /// @param schemaUID The UID of the schema of the referencing attestations.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getReferencingAttestationUIDs(
        bytes32 attestionUID,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingAttestations[attestionUID][schemaUID], start, length, reverseOrder);
    }

    /// @notice Returns the total number of references to a specific attestation.
    /// @param attestionUID The UID of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @return An array of attestation UIDs.
    function getReferencingAttestationUIDCount(bytes32 attestionUID, bytes32 schemaUID) external view returns (uint256) {
        return _referencingAttestations[attestionUID][schemaUID].length;
    }

    /// @notice Returns the UIDs of attestations referencing a specific attestation.
    /// @param attestionUID The UID of the attestation being referenced.
    /// @param schemaUID The UID of the schema of the referencing attestations.
    /// @param attester The attester of the referencing attestations.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getReferencingAttestationUIDsByAddress(
        bytes32 attestionUID,
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingAttestationsByAddress[attestionUID][schemaUID][attester], start, length, reverseOrder);
    }

    /// @notice Returns the total number of references to a specific attestation.
    /// @param attestionUID The UID of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @param attester The attester of the referencing attestations.
    /// @return An array of attestation UIDs.
    function getReferencingAttestationUIDByAddressCount(bytes32 attestionUID, bytes32 schemaUID, address attester) external view returns (uint256) {
        return _referencingAttestationsByAddress[attestionUID][schemaUID][attester].length;
    }

    /// @notice Returns the UIDs of attestations to a specific schema which were attested to/received by a specific
    ///     recipient.
    /// @param recipient The recipient of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getReceivedAttestationUIDs(
        address recipient,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_receivedAttestations[recipient][schemaUID], start, length, reverseOrder);
    }

    /// @notice Returns the total number of attestations to a specific schema which were attested to/received by a
    ///     specific recipient.
    /// @param recipient The recipient of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @return The total number of attestations.
    function getReceivedAttestationUIDCount(address recipient, bytes32 schemaUID) external view returns (uint256) {
        return _receivedAttestations[recipient][schemaUID].length;
    }

    /// @notice Returns the UIDs of attestations to a specific schema which were attested by a specific attester.
    /// @param attester The attester of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getSentAttestationUIDs(
        address attester,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_sentAttestations[attester][schemaUID], start, length, reverseOrder);
    }

    /// @notice Returns the total number of attestations to a specific schema which were attested by a specific
    /// attester.
    /// @param attester The attester of the attestation.
    /// @param schemaUID The UID of the schema.
    /// @return The total number of attestations.
    function getSentAttestationUIDCount(address attester, bytes32 schemaUID) external view returns (uint256) {
        return _sentAttestations[attester][schemaUID].length;
    }

    /// @notice Returns the UIDs of attestations to a specific schema which were attested by a specific attester to a
    ///     specific recipient.
    /// @param schemaUID The UID of the schema.
    /// @param attester The attester of the attestation.
    /// @param recipient The recipient of the attestation.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getSchemaAttesterRecipientAttestationUIDs(
        bytes32 schemaUID,
        address attester,
        address recipient,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return
            _sliceUIDs(
                _schemaAttesterRecipientAttestations[schemaUID][attester][recipient],
                start,
                length,
                reverseOrder
            );
    }

    /// @notice Returns the total number of UIDs of attestations to a specific schema which were attested by a specific
    ///     attester to a specific recipient.
    /// @param schemaUID The UID of the schema.
    /// @param attester The attester of the attestation.
    /// @param recipient The recipient of the attestation.
    /// @return An array of attestation UIDs.
    function getSchemaAttesterRecipientAttestationUIDCount(
        bytes32 schemaUID,
        address attester,
        address recipient
    ) external view returns (uint256) {
        return _schemaAttesterRecipientAttestations[schemaUID][attester][recipient].length;
    }

    /// @notice Returns the UIDs of attestations to a specific schema.
    /// @param schemaUID The UID of the schema.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function getSchemaAttestationUIDs(
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_schemaAttestations[schemaUID], start, length, reverseOrder);
    }

    /// @notice Returns the total number of attestations to a specific schema.
    /// @param schemaUID The UID of the schema.
    /// @return An array of attestation UIDs.
    function getSchemaAttestationUIDCount(bytes32 schemaUID) external view returns (uint256) {
        return _schemaAttestations[schemaUID].length;
    }

    /// @dev Indexes an existing attestation.
    /// @param attestationUID The UID of the attestation to index.
    function _indexAttestation(bytes32 attestationUID) private {
        // Skip already indexed attestations.
        if (_indexedAttestations[attestationUID]) {
            return;
        }

        // Check if the attestation exists.
        Attestation memory attestation = _eas.getAttestation(attestationUID);

        bytes32 uid = attestation.uid;
        if (uid == EMPTY_UID) {
            revert InvalidAttestation();
        }

        // Index the attestation.
        address attester = attestation.attester;
        address recipient = attestation.recipient;
        bytes32 schemaUID = attestation.schema;
        bytes32 refUID = attestation.refUID;

        _indexedAttestations[attestationUID] = true;
        _schemaAttestations[schemaUID].push(attestationUID);
        _receivedAttestations[recipient][schemaUID].push(attestationUID);
        _sentAttestations[attester][schemaUID].push(attestationUID);
        _schemaAttesterRecipientAttestations[schemaUID][attester][recipient].push(attestationUID);

        if (refUID != EMPTY_UID) {
            _referencingAttestations[refUID][schemaUID].push(attestationUID);
            _referencingAttestationsByAddress[refUID][schemaUID][attester].push(attestationUID);

            // Ensure the referenced attestation is also indexed
            _indexAttestation(refUID);
        }

        // Add attestation to old index as well
        if (_prevIndexer != address(0)) {
            Indexer(_prevIndexer).indexAttestation(attestationUID);
        }

        emit Indexed({ uid: uid });
    }

    /// @dev Returns a slice in an array of attestation UIDs.
    /// @param uids The array of attestation UIDs.
    /// @param start The offset to start from.
    /// @param length The number of total members to retrieve.
    /// @param reverseOrder Whether the offset starts from the end and the data is returned in reverse.
    /// @return An array of attestation UIDs.
    function _sliceUIDs(
        bytes32[] memory uids,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) private pure returns (bytes32[] memory) {
        uint256 attestationsLength = uids.length;
        if (attestationsLength == 0) {
            return new bytes32[](0);
        }

        if (start >= attestationsLength) {
            revert InvalidOffset();
        }

        unchecked {
            uint256 len = length;
            if (attestationsLength < start + length) {
                len = attestationsLength - start;
            }

            bytes32[] memory res = new bytes32[](len);

            for (uint256 i = 0; i < len; ++i) {
                res[i] = uids[reverseOrder ? attestationsLength - (start + i + 1) : start + i];
            }

            return res;
        }
    }
}
