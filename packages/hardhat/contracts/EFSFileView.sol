// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

interface ITagResolverForFileView {
    function isActivelyTagged(bytes32 targetID, bytes32 definition) external view returns (bool);
    function isActivelyTaggedByAny(bytes32 targetID, bytes32 definition, address[] calldata attesters) external view returns (bool);
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
     *           1. On page 1 (startingCursor == 0): qualifying generic folders (tagged with
     *              anchorSchema or containing children of anchorSchema) are prepended.
     *           2. Child anchors with `anchorSchema == requestedSchema` (matching attesters),
     *              paginated via the _childrenBySchema index (O(pageSize), not O(totalChildren)).
     *
     *         Cursor tracks position in _childrenBySchema[parentAnchor][anchorSchema].
     *         Tagged folders appear only on the first page and do not affect the cursor.
     *
     * @param parentAnchor   Directory Anchor UID.
     * @param anchorSchema   Schema to filter on. Generic folders containing this schema are
     *                       also included (schema-aware folder inclusion).
     * @param attesters      Edition addresses to filter by. An anchor qualifies if ANY attester
     *                       contributed (checked via containsAttestations). Also scopes tag
     *                       visibility via isActivelyTaggedByAny.
     * @param startingCursor Index into _childrenBySchema to resume from (0 = first page).
     * @param pageSize       Max content items per page (folders are additional on page 1).
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

        // 1. Content items — paginated via _childrenBySchema index (O(pageSize))
        (bytes32[] memory contentUIDs, uint256 contentCursor) = indexer.getAnchorsBySchemaAndAddressList(
            parentAnchor,
            anchorSchema,
            attesters,
            startingCursor,
            pageSize,
            true,   // reverseOrder (newest first)
            false   // showRevoked
        );

        // 2. Tagged folders — first page only (typically a small set)
        bytes32[] memory folderUIDs;
        uint256 folderCount = 0;
        if (startingCursor == 0) {
            folderUIDs = _getQualifyingTaggedFolders(parentAnchor, anchorSchema, attesters);
            folderCount = folderUIDs.length;
        }

        // 3. Merge: folders at top of page 1, content items paginate normally
        bytes32[] memory merged = new bytes32[](folderCount + contentUIDs.length);
        for (uint256 i = 0; i < folderCount; i++) {
            merged[i] = folderUIDs[i];
        }
        for (uint256 i = 0; i < contentUIDs.length; i++) {
            merged[folderCount + i] = contentUIDs[i];
        }

        items = _buildFileSystemItems(merged, parentAnchor, indexer.DATA_SCHEMA_UID(), indexer.PROPERTY_SCHEMA_UID());
        return (items, contentCursor);
    }

    /**
     * @dev Fetch generic folders (anchorSchema == 0) under parentAnchor that qualify for
     *      schema-aware inclusion: either they contain children of the target schema OR
     *      they've been tagged with it by a trusted attester (empty folder visibility).
     *      Bounded by TagResolver's _childrenTaggedWith + Indexer's _childrenBySchema.
     */
    function _getQualifyingTaggedFolders(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] memory attesters
    ) internal view returns (bytes32[] memory) {
        // Two sources of qualifying folders:
        // A) Generic folders that have children of anchorSchema
        //    → _childrenBySchema[parent][bytes32(0)] filtered by getChildCountBySchema > 0
        // B) Generic folders tagged with anchorSchema by a trusted attester
        //    → tagResolver._childrenTaggedWith[parent][anchorSchema]
        //
        // Source B is always small (few tagged folders) and is the primary path.
        // Source A folders also appear in _childrenBySchema[parent][bytes32(0)] but scanning
        // ALL generic folders would be O(N). Instead, we rely on the tag index:
        // - Non-empty folders with children of anchorSchema are discovered naturally when
        //   the user navigates into them. They also appear if tagged.
        // - The UI auto-tags folders on creation with their intended schema, so tagged
        //   folders cover both empty and non-empty cases.
        //
        // For completeness, we also scan generic folders (capped) to catch untagged folders
        // that organically acquired children of the target schema.

        // Collect from tag index (source B) — always small
        uint256 taggedCount = tagResolver.getChildrenTaggedWithCount(parentAnchor, anchorSchema);
        // Cap to prevent gas abuse from griefed tag indices
        uint256 maxTagged = taggedCount > 200 ? 200 : taggedCount;
        bytes32[] memory taggedCandidates = tagResolver.getChildrenTaggedWith(parentAnchor, anchorSchema, 0, maxTagged);

        // Also scan generic folders (source A) — capped scan of _childrenBySchema[parent][0]
        uint256 genericCount = indexer.getChildCountBySchema(parentAnchor, bytes32(0));
        uint256 maxGeneric = genericCount > 200 ? 200 : genericCount;
        bytes32[] memory genericFolders;
        if (maxGeneric > 0) {
            (genericFolders, ) = indexer.getAnchorsBySchemaAndAddressList(
                parentAnchor, bytes32(0), attesters, 0, maxGeneric, true, false
            );
        } else {
            genericFolders = new bytes32[](0);
        }

        // Merge both sources, dedup, and filter
        bytes32[] memory temp = new bytes32[](taggedCandidates.length + genericFolders.length);
        uint256 count = 0;

        // Process tagged candidates
        for (uint256 i = 0; i < taggedCandidates.length; i++) {
            bytes32 uid = taggedCandidates[i];
            if (indexer.isRevoked(uid)) continue;

            // Editions-aware: only include if a trusted attester applied the tag
            if (!tagResolver.isActivelyTaggedByAny(uid, anchorSchema, attesters)) continue;

            // Attester contribution check
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

        // Process generic folders that have children of anchorSchema (untagged discovery)
        for (uint256 i = 0; i < genericFolders.length; i++) {
            bytes32 uid = genericFolders[i];

            // Skip if already added via tag path
            bool alreadyAdded = false;
            for (uint256 k = 0; k < count; k++) {
                if (temp[k] == uid) { alreadyAdded = true; break; }
            }
            if (alreadyAdded) continue;

            // Include only if folder has children of the target schema
            if (indexer.getChildCountBySchema(uid, anchorSchema) == 0) continue;

            temp[count++] = uid;
        }

        // Trim to actual size
        assembly {
            mstore(temp, count)
        }
        return temp;
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
