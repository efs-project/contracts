// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/// @dev Minimal interface for the EFSIndexer functions MirrorResolver needs.
interface IEFSIndexerForMirror {
    function index(bytes32 uid) external returns (bool);
    function indexRevocation(bytes32 uid) external;
    function DATA_SCHEMA_UID() external view returns (bytes32);
    function ANCHOR_SCHEMA_UID() external view returns (bytes32);
}

/**
 * @title MirrorResolver
 * @dev SchemaResolver for the EFS Mirror schema. Validates that:
 *      1. refUID points to a valid DATA attestation
 *      2. transportDefinition points to a valid Anchor (e.g. /transports/ipfs)
 *
 *      Mirror schema: "bytes32 transportDefinition, string uri"
 *        - transportDefinition: Anchor UID for the transport type
 *        - uri: retrieval URI (ipfs://QmXxx, ar://yyy, web3://0xABC, etc.)
 *
 *      No singleton enforcement — multiple mirrors per transport type are allowed.
 */
contract MirrorResolver is SchemaResolver {
    error InvalidData();
    error InvalidTransport();
    error URITooLong();

    /// @notice Maximum allowed byte length for a MIRROR URI.
    uint256 public constant MAX_URI_LENGTH = 8192;

    IEFSIndexerForMirror public immutable indexer;

    constructor(IEAS eas, IEFSIndexerForMirror _indexer) SchemaResolver(eas) {
        indexer = _indexer;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        // MIRROR must reference a DATA attestation
        if (attestation.refUID == EMPTY_UID) return false;

        Attestation memory target = _eas.getAttestation(attestation.refUID);
        if (target.schema != indexer.DATA_SCHEMA_UID()) return false;

        // Validate transportDefinition is a valid Anchor and URI is within length limit
        (bytes32 transportDefinition, string memory uri) = abi.decode(attestation.data, (bytes32, string));
        if (bytes(uri).length > MAX_URI_LENGTH) revert URITooLong();
        if (transportDefinition == EMPTY_UID) revert InvalidTransport();
        Attestation memory transport = _eas.getAttestation(transportDefinition);
        if (transport.schema != indexer.ANCHOR_SCHEMA_UID()) revert InvalidTransport();

        // Register in EFSIndexer for discovery via getReferencingAttestations
        indexer.index(attestation.uid);

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        indexer.indexRevocation(attestation.uid);
        return true;
    }
}
