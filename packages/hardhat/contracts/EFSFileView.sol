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
    /// @notice O(1) per-attester active-tag lookup. Used for cross-attester dedup in multi-
    ///         edition views: returns nonzero iff `attester` has an active applies=true tag on
    ///         (targetID, definition).
    function getActiveTagUID(address attester, bytes32 targetID, bytes32 definition) external view returns (bytes32);
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

    /// @notice Opaque-cursor page result for multi-source views. See ADR-0036.
    /// @dev    Callers treat `nextCursor` as opaque bytes: pass it back verbatim for the next
    ///         page, or treat `nextCursor.length == 0` as "fully walked, no more pages."
    ///         The internal encoding is documented in ADR-0036 but may change across
    ///         `EFSFileView` deploys; clients must not introspect it. Round-trips only within
    ///         a single deploy are guaranteed.
    struct DirectoryPage {
        FileSystemItem[] items;
        bytes nextCursor;
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

    /// @dev Maximum attesters per multi-edition view call.
    ///      Bounds per-call gas on the attester-scoped walkers; does not bound returned items.
    ///      Callers wanting more than this many editions need a different aggregation model.
    uint256 private constant MAX_ATTESTERS_PER_QUERY = 20;

    /// @dev Internal batch size for `_childrenTaggedWith` chunk fetches during the folder
    ///      phase of `getDirectoryPageBySchemaAndAddressList`. Chosen to keep memory use
    ///      bounded while still amortizing external-call overhead.
    uint256 private constant _FOLDER_SCAN_CHUNK = 64;

    /**
     * @notice Schema-aware directory listing with folder inclusion. Opaque-cursor paginated
     *         (ADR-0036). Walks two underlying sources in order, dedup-free because the
     *         sources are disjoint (tagged folders vs. direct children of `anchorSchema`):
     *
     *           Phase 0: qualifying generic folders — subfolders under `parentAnchor` that
     *                    at least one `attesters[]` entry has an active applies=true TAG on
     *                    with `definition = anchorSchema` (ADR-0006 revised, single-source
     *                    tag-only folder visibility).
     *           Phase 1: direct child anchors of `anchorSchema` under `parentAnchor`, scoped
     *                    to `attesters[]` via `_childrenBySchema` + `containsAttestations`.
     *
     *         Each call advances internal walkers by whatever it takes to produce up to
     *         `maxItems` items or exhaust both sources. Filtered-out entries (revoked,
     *         edition-out-of-scope) still advance the walker — `maxItems` bounds result
     *         size, not work.
     *
     * @param parentAnchor  Directory Anchor UID.
     * @param anchorSchema  Schema to filter on. Generic folders with an active tag of this
     *                      schema are included in phase 0; direct children of this schema
     *                      are included in phase 1.
     * @param attesters     Edition addresses (ADR-0031). An entry qualifies if ANY listed
     *                      attester has contributed it.
     * @param cursor        Opaque token from a prior call. Empty bytes = start from the
     *                      beginning. Never introspected by callers; encoding is an
     *                      implementation detail (see ADR-0036).
     * @param maxItems      Target result size. Must be > 0.
     * @return page         `items` + `nextCursor`. `nextCursor.length == 0` iff both phases
     *                      are fully walked; otherwise pass `nextCursor` back verbatim.
     */
    function getDirectoryPageBySchemaAndAddressList(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] memory attesters,
        bytes memory cursor,
        uint256 maxItems
    ) external view returns (DirectoryPage memory page) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        require(attesters.length <= MAX_ATTESTERS_PER_QUERY, "Too many attesters");
        require(maxItems > 0, "maxItems must be > 0");

        // Decode cursor — empty = fresh start at (phase=0, folderIdx=0, fileIdx=0).
        uint8 phase = 0;
        uint256 folderIdx = 0;
        uint256 fileIdx = 0;
        if (cursor.length > 0) {
            (phase, folderIdx, fileIdx) = abi.decode(cursor, (uint8, uint256, uint256));
        }

        bytes32[] memory buf = new bytes32[](maxItems);
        uint256 count = 0;

        // ───── Phase 0: qualifying tagged folders ─────
        if (phase == 0) {
            uint256 taggedTotal = tagResolver.getChildrenTaggedWithCount(parentAnchor, anchorSchema);
            while (count < maxItems && folderIdx < taggedTotal) {
                uint256 remainingSource = taggedTotal - folderIdx;
                uint256 chunk = remainingSource < _FOLDER_SCAN_CHUNK ? remainingSource : _FOLDER_SCAN_CHUNK;
                bytes32[] memory batch = tagResolver.getChildrenTaggedWith(
                    parentAnchor,
                    anchorSchema,
                    folderIdx,
                    chunk
                );
                for (uint256 k = 0; k < batch.length; k++) {
                    folderIdx++; // advance walker for every inspected entry
                    bytes32 uid = batch[k];
                    if (indexer.isRevoked(uid)) continue;
                    if (!tagResolver.isActivelyTaggedByAny(uid, anchorSchema, attesters)) continue;
                    buf[count++] = uid;
                    if (count == maxItems) break;
                }
                if (batch.length < chunk) break; // defensive: resolver returned short batch
            }
            if (folderIdx >= taggedTotal) {
                // folder source exhausted — advance to phase 1
                phase = 1;
            }
        }

        // ───── Phase 1: direct children by schema ─────
        bool fileSourceDone = false;
        if (phase == 1) {
            while (count < maxItems) {
                uint256 want = maxItems - count;
                (bytes32[] memory batch, uint256 nextFileCur) = indexer.getAnchorsBySchemaAndAddressList(
                    parentAnchor,
                    anchorSchema,
                    attesters,
                    fileIdx,
                    want,
                    true, // reverseOrder (newest first)
                    false // showRevoked
                );
                for (uint256 k = 0; k < batch.length; k++) {
                    buf[count++] = batch[k];
                    if (count == maxItems) break;
                }
                fileIdx = nextFileCur;
                if (nextFileCur == 0) {
                    fileSourceDone = true;
                    break;
                }
                if (batch.length == 0) {
                    // defensive: indexer returned no items but nonzero cursor — avoid infinite loop
                    break;
                }
            }
        }

        // Trim buffer to actual count
        assembly ("memory-safe") {
            mstore(buf, count)
        }
        page.items = _buildFileSystemItems(buf, parentAnchor, indexer.DATA_SCHEMA_UID(), indexer.PROPERTY_SCHEMA_UID());

        // Emit cursor: empty iff both sources exhausted, else encoded state.
        if (phase == 1 && fileSourceDone) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(phase, folderIdx, fileIdx);
        }
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

    /// @dev Internal batch size for per-attester `_activeByAAS` chunk fetches during
    ///      `getFilesAtPath`. Bounds memory per external call; walker advances through all
    ///      attesters regardless.
    uint256 private constant _TARGETS_SCAN_CHUNK = 64;

    /**
     * @notice Tag-based file listing with cross-attester dedup. Opaque-cursor paginated
     *         (ADR-0036). Walks each attester's `_activeByAAS[anchorUID][attester][schema]`
     *         slice in order; earlier attesters win on duplicate targets (ADR-0031
     *         first-attester-wins).
     *
     *         Filtered-out entries (targets claimed by an earlier attester) still advance
     *         the walker; `maxItems` bounds result size, not work.
     *
     * @param anchorUID  The path anchor (e.g. /memes/).
     * @param attesters  Edition addresses to query, in precedence order.
     * @param schema     Target schema to filter (DATA_SCHEMA_UID for files,
     *                   ANCHOR_SCHEMA_UID for sub-folders).
     * @param cursor     Opaque token from a prior call. Empty = start from the beginning.
     * @param maxItems   Target result size. Must be > 0.
     * @return page      `items` + `nextCursor`. `nextCursor.length == 0` iff every
     *                   attester's slice has been walked to completion.
     *
     * @dev Concurrent-mutation caveat: `_activeByAAS` is a swap-and-pop compact index. A
     *      revocation between calls can shift later entries up by one slot, causing the
     *      resumed page to skip or repeat an item. This is a best-effort pagination
     *      guarantee typical of non-snapshotting paginators.
     */
    function getFilesAtPath(
        bytes32 anchorUID,
        address[] calldata attesters,
        bytes32 schema,
        bytes memory cursor,
        uint256 maxItems
    ) external view returns (DirectoryPage memory page) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        require(attesters.length <= MAX_ATTESTERS_PER_QUERY, "Too many attesters");
        require(maxItems > 0, "maxItems must be > 0");

        uint256 attesterIdx = 0;
        uint256 targetIdx = 0;
        if (cursor.length > 0) {
            (attesterIdx, targetIdx) = abi.decode(cursor, (uint256, uint256));
        }

        bytes32[] memory buf = new bytes32[](maxItems);
        uint256 count = 0;

        while (attesterIdx < attesters.length && count < maxItems) {
            address currentAttester = attesters[attesterIdx];
            uint256 totalForAttester = tagResolver.getActiveTargetsByAttesterAndSchemaCount(
                anchorUID,
                currentAttester,
                schema
            );

            while (targetIdx < totalForAttester && count < maxItems) {
                uint256 remainingSource = totalForAttester - targetIdx;
                uint256 chunk = remainingSource < _TARGETS_SCAN_CHUNK ? remainingSource : _TARGETS_SCAN_CHUNK;
                bytes32[] memory batch = tagResolver.getActiveTargetsByAttesterAndSchema(
                    anchorUID,
                    currentAttester,
                    schema,
                    targetIdx,
                    chunk
                );
                for (uint256 k = 0; k < batch.length; k++) {
                    targetIdx++; // advance for every inspected entry
                    bytes32 target = batch[k];
                    // Cross-attester dedup: earlier attester already has an active tag on this target?
                    bool taken = false;
                    for (uint256 prior = 0; prior < attesterIdx; prior++) {
                        if (tagResolver.getActiveTagUID(attesters[prior], target, anchorUID) != bytes32(0)) {
                            taken = true;
                            break;
                        }
                    }
                    if (taken) continue;
                    buf[count++] = target;
                    if (count == maxItems) break;
                }
                if (batch.length < chunk) break; // defensive: resolver returned short batch
            }

            if (targetIdx >= totalForAttester) {
                // Attester exhausted; advance to next attester's slice.
                attesterIdx++;
                targetIdx = 0;
            }
        }

        // Trim buffer, build items.
        assembly ("memory-safe") {
            mstore(buf, count)
        }

        bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();
        FileSystemItem[] memory items = new FileSystemItem[](count);
        for (uint256 i = 0; i < count; i++) {
            Attestation memory att = eas.getAttestation(buf[i]);

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
                uid: buf[i],
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
        page.items = items;

        // Cursor: empty iff every attester's slice has been walked to completion.
        if (attesterIdx >= attesters.length) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(attesterIdx, targetIdx);
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
