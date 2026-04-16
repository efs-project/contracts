// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

interface ITagResolverForFileView {
    function isActivelyTagged(bytes32 targetID, bytes32 definition) external view returns (bool);
    function isActivelyTaggedByAny(
        bytes32 targetID,
        bytes32 definition,
        address[] calldata attesters
    ) external view returns (bool);
    function getChildrenTaggedWith(
        bytes32 parentUID,
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory);
    function getChildrenTaggedWithCount(bytes32 parentUID, bytes32 definition) external view returns (uint256);
    function getActiveTargetsByAttesterAndSchema(
        bytes32 definition,
        address attester,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory);
    function getActiveTargetsByAttesterAndSchemaCount(
        bytes32 definition,
        address attester,
        bytes32 schema
    ) external view returns (uint256);
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
    function getQualifyingFolders(
        bytes32 parentUID,
        bytes32 contentSchema,
        address attester,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory);
    function getQualifyingFolderCount(
        bytes32 parentUID,
        bytes32 contentSchema,
        address attester
    ) external view returns (uint256);
    function getReferencingAttestationCount(bytes32 targetUID, bytes32 schemaUID) external view returns (uint256);
    function containsAttestations(bytes32 targetUID, address attester) external view returns (bool);
    function isRevoked(bytes32 uid) external view returns (bool);
    function getEAS() external view returns (IEAS);
    function DATA_SCHEMA_UID() external view returns (bytes32);
    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
    function MIRROR_SCHEMA_UID() external view returns (bytes32);
    function ANCHOR_SCHEMA_UID() external view returns (bytes32);
    function dataByContentKey(bytes32 contentHash) external view returns (bytes32);
    function getReferencingAttestations(
        bytes32 targetUID,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory);
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
        bytes32 contentHash; // For DATA attestations
    }

    struct MirrorItem {
        bytes32 uid;
        bytes32 transportDefinition;
        string uri;
        address attester;
        uint64 timestamp;
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
            true, // reverseOrder (newest first)
            false // showRevoked
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
        // Two sources of qualifying generic subfolders:
        //
        // A) Write-time index — EFSIndexer._qualifyingFolders[parent][schema][attester].
        //    Populated at O(1) amortised cost when a file anchor (anchorSchema != 0) is first
        //    placed inside a generic folder by a given attester. Read is O(m_qualifying) with
        //    no scan of non-qualifying folders — scales to any directory size.
        //
        // B) Explicit tag index — tagResolver._childrenTaggedWith[parent][schema].
        //    Covers empty folders the attester created but has not yet uploaded content into.
        //    Populated when a TAG(definition=anchorSchema, refUID=folder) is attested.

        // Upper bound on result size: sum of qualifying counts across all attesters for both sources.
        uint256 maxSize = 0;
        for (uint256 a = 0; a < attesters.length; a++) {
            maxSize += indexer.getQualifyingFolderCount(parentAnchor, anchorSchema, attesters[a]);
        }
        maxSize += tagResolver.getChildrenTaggedWithCount(parentAnchor, anchorSchema);

        if (maxSize == 0) return new bytes32[](0);

        bytes32[] memory temp = new bytes32[](maxSize);
        uint256 count = 0;

        // Source A: qualifying folders from the write-time index, one attester at a time.
        for (uint256 a = 0; a < attesters.length; a++) {
            uint256 n = indexer.getQualifyingFolderCount(parentAnchor, anchorSchema, attesters[a]);
            if (n == 0) continue;
            bytes32[] memory folders = indexer.getQualifyingFolders(parentAnchor, anchorSchema, attesters[a], 0, n);
            for (uint256 i = 0; i < folders.length; i++) {
                bytes32 uid = folders[i];
                if (indexer.isRevoked(uid)) continue;
                // Dedup across attesters (inner loop — typically n_attesters is small)
                bool seen = false;
                for (uint256 k = 0; k < count; k++) {
                    if (temp[k] == uid) { seen = true; break; }
                }
                if (!seen) temp[count++] = uid;
            }
        }

        // Source B: explicitly tagged folders (empty-folder visibility).
        uint256 taggedCount = tagResolver.getChildrenTaggedWithCount(parentAnchor, anchorSchema);
        if (taggedCount > 0) {
            bytes32[] memory tagged = tagResolver.getChildrenTaggedWith(parentAnchor, anchorSchema, 0, taggedCount);
            for (uint256 i = 0; i < tagged.length; i++) {
                bytes32 uid = tagged[i];
                if (indexer.isRevoked(uid)) continue;
                if (!tagResolver.isActivelyTaggedByAny(uid, anchorSchema, attesters)) continue;
                bool qualifies = false;
                for (uint256 j = 0; j < attesters.length; j++) {
                    if (indexer.containsAttestations(uid, attesters[j])) { qualifies = true; break; }
                }
                if (!qualifies) continue;
                // Dedup against source A
                bool seen = false;
                for (uint256 k = 0; k < count; k++) {
                    if (temp[k] == uid) { seen = true; break; }
                }
                if (!seen) temp[count++] = uid;
            }
        }

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
                schema: anchorType,
                contentHash: bytes32(0)
            });
        }

        return result;
    }

    /**
     * @notice Tag-based file listing: get DATAs placed at an anchor by specific attesters.
     *         Uses TagResolver's _activeByAttesterAndSchema compact index.
     * @param anchorUID  The path anchor (e.g. /memes/)
     * @param attesters  Edition addresses to query
     * @param schema     Target schema to filter (DATA_SCHEMA_UID for files, ANCHOR_SCHEMA_UID for sub-folders)
     * @param start      Pagination offset
     * @param length     Page size
     * @return items     DATA/Anchor attestation details with contentHash populated for DATAs
     */
    function getFilesAtPath(
        bytes32 anchorUID,
        address[] calldata attesters,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (FileSystemItem[] memory items) {
        // Collect from all attesters, dedup by UID
        bytes32[] memory temp = new bytes32[](length * attesters.length);
        uint256 count = 0;

        for (uint256 a = 0; a < attesters.length; a++) {
            bytes32[] memory targets = tagResolver.getActiveTargetsByAttesterAndSchema(
                anchorUID,
                attesters[a],
                schema,
                start,
                length
            );
            for (uint256 i = 0; i < targets.length; i++) {
                // Dedup
                bool exists = false;
                for (uint256 j = 0; j < count; j++) {
                    if (temp[j] == targets[i]) {
                        exists = true;
                        break;
                    }
                }
                if (!exists && count < temp.length) {
                    temp[count++] = targets[i];
                }
            }
        }

        items = new FileSystemItem[](count);
        bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();

        for (uint256 i = 0; i < count; i++) {
            Attestation memory att = eas.getAttestation(temp[i]);

            bytes32 contentHash;
            string memory name = "";

            if (att.schema == dataSchemaUID) {
                // DATA attestation: decode contentHash
                (contentHash, ) = abi.decode(att.data, (bytes32, uint64));
            } else {
                // Anchor: decode name
                bytes32 anchorType;
                (name, anchorType) = abi.decode(att.data, (string, bytes32));
            }

            items[i] = FileSystemItem({
                uid: temp[i],
                name: name,
                parentUID: anchorUID,
                isFolder: att.schema != dataSchemaUID,
                hasData: att.schema == dataSchemaUID,
                childCount: 0,
                propertyCount: 0,
                timestamp: att.time,
                attester: att.attester,
                schema: att.schema,
                contentHash: contentHash
            });
        }
    }

    /**
     * @notice Get mirrors (retrieval methods) for a DATA attestation.
     * @param dataUID  The DATA attestation UID
     * @param start    Pagination offset
     * @param length   Page size
     */
    function getDataMirrors(
        bytes32 dataUID,
        uint256 start,
        uint256 length
    ) external view returns (MirrorItem[] memory) {
        bytes32 mirrorSchemaUID = indexer.MIRROR_SCHEMA_UID();
        bytes32[] memory mirrorUIDs = indexer.getReferencingAttestations(
            dataUID,
            mirrorSchemaUID,
            start,
            length,
            false
        );

        // First pass: count non-revoked mirrors
        uint256 activeCount = 0;
        for (uint256 i = 0; i < mirrorUIDs.length; i++) {
            if (!indexer.isRevoked(mirrorUIDs[i])) activeCount++;
        }

        // Second pass: populate result
        MirrorItem[] memory result = new MirrorItem[](activeCount);
        uint256 idx = 0;
        for (uint256 i = 0; i < mirrorUIDs.length; i++) {
            if (indexer.isRevoked(mirrorUIDs[i])) continue;
            Attestation memory att = eas.getAttestation(mirrorUIDs[i]);
            (bytes32 transportDef, string memory uri) = abi.decode(att.data, (bytes32, string));
            result[idx++] = MirrorItem({
                uid: mirrorUIDs[i],
                transportDefinition: transportDef,
                uri: uri,
                attester: att.attester,
                timestamp: att.time
            });
        }
        return result;
    }

    /**
     * @notice Look up the canonical DATA UID for a content hash.
     */
    function getCanonicalData(bytes32 contentHash) external view returns (bytes32) {
        return indexer.dataByContentKey(contentHash);
    }

    function decodeName(bytes memory data) external pure returns (string memory) {
        (string memory name, ) = abi.decode(data, (string, bytes32));
        return name;
    }
}
