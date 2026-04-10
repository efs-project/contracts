// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

interface ITagResolverForFileView {
    function isActivelyTagged(bytes32 targetID, bytes32 definition) external view returns (bool);
    function getChildrenTaggedWith(bytes32 parentUID, bytes32 definition, uint256 start, uint256 length) external view returns (bytes32[] memory);
    function getChildrenTaggedWithCount(bytes32 parentUID, bytes32 definition) external view returns (uint256);
}

interface IEFSIndexer {
    function getChildren(
        bytes32 anchorUID,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory);
    function getChildAt(bytes32 parentAnchor, uint256 idx) external view returns (bytes32);
    function getChildrenByAddressList(
        bytes32 parentUID,
        address[] calldata attesters,
        uint256 startCursor,
        uint256 pageSize,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextCursor);
    function getAnchorsBySchemaAndAddressList(
        bytes32 parentUID,
        bytes32 anchorSchema,
        address[] calldata attesters,
        uint256 startCursor,
        uint256 pageSize,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextCursor);
    function getChildrenCount(bytes32 anchorUID) external view returns (uint256);
    function getChildCountBySchema(bytes32 parentAnchor, bytes32 schema) external view returns (uint256);
    function getDataByAddressList(
        bytes32 anchorUID,
        address[] calldata attesters,
        bool showRevoked
    ) external view returns (bytes32);
    function getReferencingAttestationCount(bytes32 targetUID, bytes32 schemaUID) external view returns (uint256);
    function containsAttestations(bytes32 targetUID, address attester) external view returns (bool);
    function isRevoked(bytes32 uid) external view returns (bool);
    function getEAS() external view returns (IEAS);
    function DATA_SCHEMA_UID() external view returns (bytes32);
    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
}

contract EFSFileView {
    struct FileSystemItem {
        bytes32 uid;
        string name;
        bytes32 parentUID;
        bool isFolder;
        bool hasData;
        uint256 childCount;
        uint256 propertyCount;
        uint64 timestamp;
        address attester;
        bytes32 schema; // Anchor Schema Type
    }

    IEFSIndexer public immutable indexer;
    IEAS public immutable eas;
    ITagResolverForFileView public immutable tagResolver;

    constructor(IEFSIndexer _indexer, ITagResolverForFileView _tagResolver) {
        indexer = _indexer;
        eas = _indexer.getEAS();
        tagResolver = _tagResolver;
    }

    function getDirectoryPage(
        bytes32 parentAnchor,
        uint256 start,
        uint256 length,
        bytes32 dataSchemaUID,
        bytes32 propertySchemaUID
    ) external view returns (FileSystemItem[] memory) {
        bytes32[] memory uids = indexer.getChildren(parentAnchor, start, length, true, false);
        return _buildFileSystemItems(uids, parentAnchor, dataSchemaUID, propertySchemaUID);
    }

    function getDirectoryPageByAddressList(
        bytes32 parentAnchor,
        address[] memory attesters,
        uint256 startingCursor,
        uint256 pageSize
    ) external view returns (FileSystemItem[] memory items, uint256 nextCursor) {
        (bytes32[] memory resolvedUIDs, uint256 nextCur) = indexer.getChildrenByAddressList(
            parentAnchor,
            attesters,
            startingCursor,
            pageSize,
            true,
            false
        );

        items = _buildFileSystemItems(
            resolvedUIDs,
            parentAnchor,
            indexer.DATA_SCHEMA_UID(),
            indexer.PROPERTY_SCHEMA_UID()
        );

        return (items, nextCur);
    }

    /**
     * @notice Schema-aware directory listing with folder inclusion.
     *         Returns:
     *           1. Child anchors with `anchorSchema == requestedSchema` (matching attesters)
     *           2. Generic child anchors (anchorSchema == bytes32(0)) that contain at least one
     *              child of `requestedSchema` — enabling "folders of chess games" when browsing
     *              chess-game-schema anchors.
     *
     *         Cursor tracks position in the global _children[parentAnchor] array so both item
     *         types can be mixed in a single paginated scan.
     *
     * @param parentAnchor   Directory Anchor UID.
     * @param anchorSchema   Schema to filter on. Generic folders containing this schema are
     *                       also included (schema-aware folder inclusion).
     * @param attesters      Edition addresses to filter by. An anchor qualifies if ANY attester
     *                       contributed (checked via containsAttestations).
     * @param startingCursor Raw index into _children[parentAnchor] to resume from (0 = start).
     * @param pageSize       Max items per page.
     */
    function getDirectoryPageBySchemaAndAddressList(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] memory attesters,
        uint256 startingCursor,
        uint256 pageSize
    ) external view returns (FileSystemItem[] memory items, uint256 nextCursor) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        require(pageSize > 0, "Page size must be > 0");

        uint256 totalChildren = indexer.getChildrenCount(parentAnchor);

        bytes32[] memory temp = new bytes32[](pageSize);
        uint256 count = 0;
        uint256 i = startingCursor;

        while (count < pageSize && i < totalChildren) {
            // Scan newest-first: reverse the physical index
            uint256 actualIdx = totalChildren - 1 - i;
            bytes32 uid = indexer.getChildAt(parentAnchor, actualIdx);
            i++;

            if (indexer.isRevoked(uid)) continue;

            // Determine anchor schema from EAS attestation data
            Attestation memory att = eas.getAttestation(uid);
            if (att.uid == bytes32(0)) continue;

            bytes32 childAnchorSchema;
            if (att.data.length >= 64) {
                (, childAnchorSchema) = abi.decode(att.data, (string, bytes32));
            }

            bool schemaMatch;
            if (childAnchorSchema == anchorSchema) {
                // Direct match — this is a content item of the requested schema
                schemaMatch = true;
            } else if (childAnchorSchema == bytes32(0)) {
                // Generic folder — include if it contains items of the requested schema
                // OR if it has been tagged with the requested schema (empty folder visibility)
                schemaMatch = indexer.getChildCountBySchema(uid, anchorSchema) > 0
                    || tagResolver.isActivelyTagged(uid, anchorSchema);
            }

            if (!schemaMatch) continue;

            // Check attester contribution
            bool qualifies = false;
            for (uint256 j = 0; j < attesters.length; j++) {
                if (indexer.containsAttestations(uid, attesters[j])) {
                    qualifies = true;
                    break;
                }
            }
            if (!qualifies) continue;

            temp[count++] = uid;
        }

        assembly {
            mstore(temp, count)
        }

        items = _buildFileSystemItems(temp, parentAnchor, indexer.DATA_SCHEMA_UID(), indexer.PROPERTY_SCHEMA_UID());

        return (items, i >= totalChildren ? 0 : i);
    }

    function _buildFileSystemItems(
        bytes32[] memory uids,
        bytes32 parentAnchor,
        bytes32 dataSchemaUID,
        bytes32 propertySchemaUID
    ) internal view returns (FileSystemItem[] memory) {
        FileSystemItem[] memory result = new FileSystemItem[](uids.length);

        for (uint256 i = 0; i < uids.length; i++) {
            bytes32 uid = uids[i];
            Attestation memory att = eas.getAttestation(uid);

            string memory name = "";
            bytes32 anchorType = bytes32(0);
            if (att.data.length > 0) {
                (name, anchorType) = abi.decode(att.data, (string, bytes32));
            }

            uint256 childCount = indexer.getChildrenCount(uid);
            uint256 dataCount = indexer.getReferencingAttestationCount(uid, dataSchemaUID);
            uint256 propertyCount = indexer.getReferencingAttestationCount(uid, propertySchemaUID);

            result[i] = FileSystemItem({
                uid: uid,
                name: name,
                parentUID: parentAnchor,
                isFolder: anchorType == bytes32(0), // generic anchor = folder regardless of children
                hasData: dataCount > 0,
                childCount: childCount,
                propertyCount: propertyCount,
                timestamp: att.time,
                attester: att.attester,
                schema: anchorType
            });
        }

        return result;
    }

    function decodeName(bytes memory data) external pure returns (string memory) {
        (string memory name, ) = abi.decode(data, (string, bytes32));
        return name;
    }
}
