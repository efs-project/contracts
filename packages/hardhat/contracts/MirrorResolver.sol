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
    function getParent(bytes32 anchorUID) external view returns (bytes32);
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
    error InvalidURIScheme();

    /// @notice Maximum allowed byte length for a MIRROR URI.
    uint256 public constant MAX_URI_LENGTH = 8192;

    /// @notice Maximum depth when walking ancestors to find /transports/.
    uint256 private constant MAX_TRANSPORT_DEPTH = 8;

    IEFSIndexerForMirror public immutable indexer;
    address private immutable _deployer;

    /// @notice The UID of the /transports/ anchor. Transport definitions must be
    ///         descendants of this anchor (e.g. /transports/ipfs, /transports/ipfs/v2).
    bytes32 public transportsAnchorUID;

    constructor(IEAS eas, IEFSIndexerForMirror _indexer) SchemaResolver(eas) {
        indexer = _indexer;
        _deployer = msg.sender;
    }

    /// @notice Set the /transports/ anchor UID. Can only be called once, by deployer.
    function setTransportsAnchor(bytes32 uid) external {
        require(msg.sender == _deployer, "only deployer");
        require(transportsAnchorUID == EMPTY_UID, "already set");
        require(uid != EMPTY_UID, "zero uid");
        transportsAnchorUID = uid;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        // MIRROR must reference a DATA attestation
        if (attestation.refUID == EMPTY_UID) return false;

        Attestation memory target = _eas.getAttestation(attestation.refUID);
        if (target.schema != indexer.DATA_SCHEMA_UID()) return false;

        // Validate transportDefinition is a valid Anchor and URI passes scheme/length checks
        (bytes32 transportDefinition, string memory uri) = abi.decode(attestation.data, (bytes32, string));
        if (bytes(uri).length > MAX_URI_LENGTH) revert URITooLong();
        if (!_isAllowedScheme(uri)) revert InvalidURIScheme();
        if (transportDefinition == EMPTY_UID) revert InvalidTransport();
        Attestation memory transport = _eas.getAttestation(transportDefinition);
        if (transport.schema != indexer.ANCHOR_SCHEMA_UID()) revert InvalidTransport();

        // Verify the transport anchor is a descendant of /transports/.
        // Allows /transports/ipfs, /transports/ipfs/v2, etc. but rejects
        // arbitrary anchors like /memes/cat.jpg being used as transport labels.
        if (!_isDescendantOfTransports(transportDefinition)) revert InvalidTransport();

        // Register in EFSIndexer for discovery via getReferencingAttestations
        indexer.index(attestation.uid);

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        indexer.indexRevocation(attestation.uid);
        return true;
    }

    /// @dev Walk ancestors of `anchorUID` to check if /transports/ is in the chain.
    function _isDescendantOfTransports(bytes32 anchorUID) private view returns (bool) {
        bytes32 current = anchorUID;
        for (uint256 i = 0; i < MAX_TRANSPORT_DEPTH; i++) {
            bytes32 parent = indexer.getParent(current);
            if (parent == EMPTY_UID) return false;
            if (parent == transportsAnchorUID) return true;
            current = parent;
        }
        return false;
    }

    /// @dev Returns true iff the URI starts with a known-safe scheme.
    /// Rejects javascript:, data:, ftp:, and other schemes that could be
    /// executed or misinterpreted by clients.
    function _isAllowedScheme(string memory uri) private pure returns (bool) {
        bytes memory u = bytes(uri);
        if (_startsWith(u, "web3://"))  return true;
        if (_startsWith(u, "ipfs://"))  return true;
        if (_startsWith(u, "ar://"))    return true;
        if (_startsWith(u, "https://")) return true;
        if (_startsWith(u, "magnet:"))  return true;
        return false;
    }

    function _startsWith(bytes memory str, bytes memory prefix) private pure returns (bool) {
        if (str.length < prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (str[i] != prefix[i]) return false;
        }
        return true;
    }
}
