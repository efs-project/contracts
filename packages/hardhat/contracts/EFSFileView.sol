// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

interface IEdgeResolverForFileView {
    /// @notice TAG-specific lens-aware check: true iff any of `attesters` has an active
    ///         TAG on (targetID, definition). Used for phase-0 folder visibility (ADR-0038):
    ///         folder visibility is TAG-only; a PIN with `definition=DATA_SCHEMA_UID` targeting
    ///         a folder must NOT make that folder appear in lens-scoped directory listings.
    ///         One SLOAD per attester.
    function hasActiveTagFromAny(
        bytes32 targetID,
        bytes32 definition,
        address[] calldata attesters
    ) external view returns (bool);

    /// @notice Append-only discovery: child anchors with an active edge (PIN or TAG) under
    ///         `definition`, scoped by `parentUID`. Used by Shape B folder-visibility reads
    ///         (ADR-0038, ADR-0041).
    function getChildrenWithEdge(
        bytes32 parentUID,
        bytes32 definition,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory);
    function getChildrenWithEdgeCount(bytes32 parentUID, bytes32 definition) external view returns (uint256);

    /// @notice O(1) read of the active PIN's target UID for a (definition, attester, schema) slot.
    ///         Primary read for Shape A consumers (file placement, PROPERTY value binding).
    function getActivePinTarget(
        bytes32 definition,
        address attester,
        bytes32 targetSchema
    ) external view returns (bytes32);

    /// @notice PIN-specific single-attester check: true iff `attester` has an active PIN on
    ///         (targetID, definition). One SLOAD.
    ///
    ///         Use this — not `isActiveEdgeAnySchema` — for cross-attester file-placement dedup
    ///         in `getFilesAtPath` (ADR-0041): file placement is PIN-only (Shape A); a TAG from
    ///         an earlier attester must NOT suppress a later attester's valid PIN placement.
    function isActivePinEdge(address attester, bytes32 targetID, bytes32 definition) external view returns (bool);

    /// @notice O(1) read of the raw stored weight of the active TAG `(definition, attester,
    ///         targetSchema)` whose target is `target`, or `(false, 0)` if none. Kernel
    ///         weight-neutral — returns the raw weight; the caller applies any threshold
    ///         policy (ADR-0048). Used by `getDirectoryPageFiltered` for tag-exclusion.
    function getActiveTagWeight(
        address attester,
        bytes32 target,
        bytes32 definition,
        bytes32 targetSchema
    ) external view returns (bool exists, int256 weight);
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
    IEdgeResolverForFileView public immutable edgeResolver;

    constructor(IEFSIndexer _indexer, IEdgeResolverForFileView _edgeResolver) {
        indexer = _indexer;
        eas = _indexer.getEAS();
        edgeResolver = _edgeResolver;
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

    /// @dev Maximum attesters per multi-lens view call.
    ///      Bounds per-call gas on the attester-scoped walkers; does not bound returned items.
    ///      Callers wanting more than this many lenses need a different aggregation model.
    uint256 private constant MAX_ATTESTERS_PER_QUERY = 20;

    /// @dev Internal batch size for `_childrenWithEdge` chunk fetches during the folder
    ///      phase of `getDirectoryPageBySchemaAndAddressList`. Chosen to keep memory use
    ///      bounded while still amortizing external-call overhead.
    uint256 private constant _FOLDER_SCAN_CHUNK = 64;

    /// @dev Hard cap on entries inspected in phase 0 per call. The append-only
    ///      `_childrenWithEdge[parent][schema]` list can grow unboundedly for a hot
    ///      directory, and a page where most entries get filtered out (wrong attester,
    ///      revoked) would otherwise loop `_childrenWithEdge.length` times in a
    ///      single eth_call — causing RPC timeouts or provider out-of-gas. The budget
    ///      bounds per-call work; the opaque cursor continues progress across calls
    ///      (same pattern as ADR-0020's `MAX_PAGES = 10` mirror-scan cap in
    ///      `EFSRouter._getBestMirrorURI`).
    ///
    ///      Read through `_folderScanBudgetPerCall()` (not the bare constant) so a
    ///      test-only subclass can override it to a small value and exercise the budget
    ///      guard without seeding thousands of items. Production default is unchanged.
    uint256 private constant _FOLDER_SCAN_BUDGET_PER_CALL = 2048;

    /// @dev Hard cap on phase-1 entries inspected per call in `getDirectoryPageFiltered`.
    ///      Symmetric to `_FOLDER_SCAN_BUDGET_PER_CALL` (phase 0). The plain
    ///      `getDirectoryPageBySchemaAndAddressList` does not need a phase-1 budget because every
    ///      phase-1 candidate the indexer returns becomes a result item (no per-item drop), so its
    ///      inner loop is naturally bounded by `maxItems`. The filtered variant can DROP phase-1
    ///      items (the exclusion predicate), so a page that is 100%-excluded under the lens would
    ///      otherwise loop the entire phase-1 source in one eth_call. This budget bounds per-call
    ///      work; the opaque cursor (ADR-0036) continues progress across calls — same pattern as
    ///      the phase-0 budget and ADR-0020's mirror-scan cap.
    ///
    ///      Read through `_fileScanBudgetPerCall()` (not the bare constant) so a test-only
    ///      subclass can override it to a small value and exercise the budget guard without
    ///      seeding thousands of items. Production default is unchanged.
    uint256 private constant _FILE_SCAN_BUDGET_PER_CALL = 2048;

    /// @dev Per-call phase-0 (folder) scan budget. `internal view virtual` so a test-only
    ///      subclass can override it to a small value to exercise the budget guard
    ///      (ADR-0048's headline safety mechanism). Returns the production constant by default.
    function _folderScanBudgetPerCall() internal view virtual returns (uint256) {
        return _FOLDER_SCAN_BUDGET_PER_CALL;
    }

    /// @dev Per-call phase-1 (file) scan budget. `internal view virtual` so a test-only
    ///      subclass can override it to a small value to exercise the budget guard
    ///      (ADR-0048's headline safety mechanism). Returns the production constant by default.
    function _fileScanBudgetPerCall() internal view virtual returns (uint256) {
        return _FILE_SCAN_BUDGET_PER_CALL;
    }

    /**
     * @notice Schema-aware directory listing with folder inclusion. Opaque-cursor paginated
     *         (ADR-0036). Walks two underlying sources in order, dedup-free because the
     *         sources are disjoint (tagged folders vs. direct children of `anchorSchema`):
     *
     *           Phase 0: qualifying generic folders — subfolders under `parentAnchor` that
     *                    at least one `attesters[]` entry has an active TAG on with
     *                    `definition = anchorSchema` (ADR-0006 revised, ADR-0038, ADR-0041:
     *                    single-source tag-only folder visibility under the cardinality-N
     *                    TAG schema).
     *           Phase 1: direct child anchors of `anchorSchema` under `parentAnchor`, scoped
     *                    to `attesters[]` via `_childrenBySchema` + `containsAttestations`.
     *
     *         Each call advances internal walkers by whatever it takes to produce up to
     *         `maxItems` items or exhaust both sources. Filtered-out entries (revoked,
     *         lens-out-of-scope) still advance the walker — `maxItems` bounds result
     *         size, not work.
     *
     * @param parentAnchor  Directory Anchor UID.
     * @param anchorSchema  Schema to filter on. Generic folders with an active tag of this
     *                      schema are included in phase 0; direct children of this schema
     *                      are included in phase 1.
     * @param attesters     Lens addresses (ADR-0031). An entry qualifies if ANY listed
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

        // Decode cursor — empty OR malformed = fresh start at (phase=0, folderIdx=0,
        // fileIdx=0). ADR-0036 treats the cursor as opaque caller-supplied bytes, so a
        // buggy or malicious client must not be able to brick the view with an
        // `abi.decode` Panic or a silent no-progress loop.
        //
        // Two guards:
        //   1. Wrong length → fresh walk. Encoded `(uint8, uint256, uint256)` is exactly
        //      3 × 32 = 96 bytes (uint8 is padded). Anything else was not produced by
        //      this contract.
        //   2. Out-of-range `phase` → fresh walk. A decoded `phase > 1` would skip both
        //      phase-0 and phase-1 blocks, return empty items with an unchanged cursor,
        //      and the caller would loop forever with no forward progress.
        //
        // We decode as a uint256 triple (not `(uint8, ...)`) so that non-zero upper
        // bits in the first word don't revert — the range-check below handles validity.
        // The wire format is byte-identical because `abi.encode` pads uint8 to 32 bytes.
        uint8 phase = 0;
        uint256 folderIdx = 0;
        uint256 fileIdx = 0;
        if (cursor.length == 96) {
            (uint256 pRaw, uint256 fRaw, uint256 fiRaw) = abi.decode(cursor, (uint256, uint256, uint256));
            if (pRaw <= 1) {
                phase = uint8(pRaw);
                folderIdx = fRaw;
                fileIdx = fiRaw;
            }
        }

        bytes32[] memory buf = new bytes32[](maxItems);
        uint256 count = 0;

        // ───── Phase 0: qualifying tagged folders ─────
        if (phase == 0) {
            uint256 folderBudget = _folderScanBudgetPerCall();
            uint256 taggedTotal = edgeResolver.getChildrenWithEdgeCount(parentAnchor, anchorSchema);
            uint256 scanned = 0; // entries inspected this call — bounded by budget
            while (count < maxItems && folderIdx < taggedTotal && scanned < folderBudget) {
                uint256 remainingSource = taggedTotal - folderIdx;
                uint256 remainingBudget = folderBudget - scanned;
                uint256 chunk = remainingSource < _FOLDER_SCAN_CHUNK ? remainingSource : _FOLDER_SCAN_CHUNK;
                if (chunk > remainingBudget) chunk = remainingBudget;
                bytes32[] memory batch = edgeResolver.getChildrenWithEdge(parentAnchor, anchorSchema, folderIdx, chunk);
                for (uint256 k = 0; k < batch.length; k++) {
                    folderIdx++; // advance walker for every inspected entry
                    scanned++;
                    bytes32 uid = batch[k];
                    if (indexer.isRevoked(uid)) continue;
                    if (!edgeResolver.hasActiveTagFromAny(uid, anchorSchema, attesters)) continue;
                    buf[count++] = uid;
                    if (count == maxItems) break;
                }
                if (batch.length < chunk) break; // defensive: resolver returned short batch
            }
            if (folderIdx >= taggedTotal) {
                // folder source exhausted — advance to phase 1
                phase = 1;
            }
            // If we hit the scan budget but not maxItems and folders aren't exhausted,
            // we stay in phase=0 with folderIdx advanced — next call resumes mid-folders.
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

    /**
     * @notice Tag-exclusion-filtered directory listing (ADR-0048). Identical walk, sources,
     *         budgets, and opaque cursor format (ADR-0036) to
     *         `getDirectoryPageBySchemaAndAddressList`, PLUS a per-item exclusion predicate:
     *
     *           **Skip an item if ANY attester in `attesters` has an active TAG `excludeTagDef`
     *           on it with `weight >= minWeight`.**
     *
     *         The comparison is inclusive (`>=`) and lives in the view layer; `minWeight` is a
     *         caller argument (ADR-0042's `weight >= 0` is just the conventional `minWeight = 0`
     *         a caller passes, not a baked-in rule). The kernel stays weight-neutral.
     *
     *         **Tag-target asymmetry (load-bearing, ADR-0048).** A descriptive-label TAG targets
     *         different UIDs for folders vs files:
     *           - **folder** item (anchorType == bytes32(0)): the TAG targets the item's ANCHOR
     *             UID, bucket `ANCHOR_SCHEMA_UID`. Tested directly.
     *           - **file** item: the TAG targets the item's DATA UID, reached via the placement
     *             PIN `getActivePinTarget(itemAnchor, lens, dataSchemaUID)`, bucket
     *             `dataSchemaUID`. Testing `excludeTagDef` against a file's anchor UID is the
     *             wrong target and excludes nothing — the known footgun.
     *
     *         `maxItems` counts POST-filter result slots: an excluded item advances the walker
     *         but consumes no slot (same as a revoked / out-of-lens skip). A phase-1 scan budget
     *         (`_FILE_SCAN_BUDGET_PER_CALL`) is added so a 100%-excluded page can't loop the whole
     *         phase-1 source in one call — when the budget is hit before `maxItems` is filled, a
     *         non-empty cursor is returned at the current position.
     *
     *         **Scan-budget scope.** The per-call budget bounds *this view's* phase-1 loop (the
     *         number of candidates inspected here), NOT the work inside a single underlying
     *         `indexer.getAnchorsBySchemaAndAddressList` call. That indexer call can itself scan up
     *         to `total` raw positions internally to fill one page when the array is dense with
     *         revoked / non-lens entries — shared behavior with the sibling
     *         `getDirectoryPageBySchemaAndAddressList`, which relies on the same indexer call.
     *
     * @param parentAnchor  Directory Anchor UID.
     * @param anchorSchema  Schema to filter on (same role as the sibling function).
     * @param attesters     Lens addresses (ADR-0031). Must be non-empty.
     * @param excludeTagDef The TAG predicate whose presence (with `weight >= minWeight`) excludes.
     * @param minWeight     Inclusive weight threshold for exclusion. Caller-chosen policy.
     * @param cursor        Opaque token from a prior call (ADR-0036); empty = fresh start.
     * @param maxItems      Target POST-filter result size. Must be > 0.
     * @return page         `items` (excluded items omitted) + `nextCursor`. `nextCursor.length == 0`
     *                      iff both phases are fully walked.
     */
    function getDirectoryPageFiltered(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] memory attesters,
        bytes32 excludeTagDef,
        int256 minWeight,
        bytes memory cursor,
        uint256 maxItems
    ) external view returns (DirectoryPage memory page) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        require(attesters.length <= MAX_ATTESTERS_PER_QUERY, "Too many attesters");
        require(maxItems > 0, "maxItems must be > 0");

        // Decode cursor — same defensive contract as getDirectoryPageBySchemaAndAddressList:
        // wrong length OR out-of-range phase = fresh walk at (phase=0, folderIdx=0, fileIdx=0).
        uint8 phase = 0;
        uint256 folderIdx = 0;
        uint256 fileIdx = 0;
        if (cursor.length == 96) {
            (uint256 pRaw, uint256 fRaw, uint256 fiRaw) = abi.decode(cursor, (uint256, uint256, uint256));
            if (pRaw <= 1) {
                phase = uint8(pRaw);
                folderIdx = fRaw;
                fileIdx = fiRaw;
            }
        }

        bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();
        bytes32 anchorSchemaUID = indexer.ANCHOR_SCHEMA_UID();

        bytes32[] memory buf = new bytes32[](maxItems);
        uint256 count = 0;

        // ───── Phase 0: qualifying tagged folders ─────
        if (phase == 0) {
            uint256 folderBudget = _folderScanBudgetPerCall();
            uint256 taggedTotal = edgeResolver.getChildrenWithEdgeCount(parentAnchor, anchorSchema);
            uint256 scanned = 0; // entries inspected this call — bounded by budget
            while (count < maxItems && folderIdx < taggedTotal && scanned < folderBudget) {
                uint256 remainingSource = taggedTotal - folderIdx;
                uint256 remainingBudget = folderBudget - scanned;
                uint256 chunk = remainingSource < _FOLDER_SCAN_CHUNK ? remainingSource : _FOLDER_SCAN_CHUNK;
                if (chunk > remainingBudget) chunk = remainingBudget;
                bytes32[] memory batch = edgeResolver.getChildrenWithEdge(parentAnchor, anchorSchema, folderIdx, chunk);
                for (uint256 k = 0; k < batch.length; k++) {
                    folderIdx++; // advance walker for every inspected entry
                    scanned++;
                    bytes32 uid = batch[k];
                    if (indexer.isRevoked(uid)) continue;
                    if (!edgeResolver.hasActiveTagFromAny(uid, anchorSchema, attesters)) continue;
                    // Exclusion predicate (post-filter slot accounting): excluded items advance
                    // the walker but consume no slot, identical to a revoked/out-of-lens skip.
                    if (_isItemExcluded(uid, attesters, excludeTagDef, minWeight, dataSchemaUID, anchorSchemaUID))
                        continue;
                    buf[count++] = uid;
                    if (count == maxItems) break;
                }
                if (batch.length < chunk) break; // defensive: resolver returned short batch
            }
            if (folderIdx >= taggedTotal) {
                phase = 1;
            }
        }

        // ───── Phase 1: direct children by schema ─────
        bool fileSourceDone = false;
        if (phase == 1) {
            uint256 fileBudget = _fileScanBudgetPerCall();
            uint256 scanned = 0; // phase-1 entries inspected this call — bounded by budget
            while (count < maxItems && scanned < fileBudget) {
                uint256 remainingBudget = fileBudget - scanned;
                uint256 want = maxItems - count;
                // Fetch at most `remainingBudget` candidates so the per-call inspection count
                // can't exceed the budget regardless of how many get excluded below.
                if (want > remainingBudget) want = remainingBudget;
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
                    scanned++;
                    bytes32 uid = batch[k];
                    if (_isItemExcluded(uid, attesters, excludeTagDef, minWeight, dataSchemaUID, anchorSchemaUID))
                        continue;
                    buf[count++] = uid;
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
        page.items = _buildFileSystemItems(buf, parentAnchor, dataSchemaUID, indexer.PROPERTY_SCHEMA_UID());

        // Emit cursor: empty iff phase 1 fully exhausted, else encoded state.
        if (phase == 1 && fileSourceDone) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(phase, folderIdx, fileIdx);
        }
    }

    /// @dev Per-item tag-exclusion predicate for `getDirectoryPageFiltered`. Decodes the item's
    ///      anchor once to determine folder-vs-file (anchorType == bytes32(0) ⇒ folder, the same
    ///      rule `_buildFileSystemItems` uses) and resolves the correct tag target per the
    ///      ADR-0048 asymmetry:
    ///        - folder ⇒ test `excludeTagDef` on the ANCHOR UID, bucket ANCHOR_SCHEMA_UID;
    ///        - file   ⇒ for each lens, resolve DATA UID via the placement PIN
    ///                   (`getActivePinTarget(anchor, lens, dataSchemaUID)`); if 0, that lens
    ///                   contributes no tag; else test `excludeTagDef` on the DATA UID, bucket
    ///                   dataSchemaUID.
    ///      Returns true iff ANY lens has an active `excludeTagDef` TAG on the resolved target
    ///      with `weight >= minWeight` (inclusive). All per-item reads are O(1).
    function _isItemExcluded(
        bytes32 itemAnchorUID,
        address[] memory attesters,
        bytes32 excludeTagDef,
        int256 minWeight,
        bytes32 dataSchemaUID,
        bytes32 anchorSchemaUID
    ) internal view returns (bool) {
        // Decode the anchor to classify folder vs file (anchorType == 0 ⇒ generic folder).
        Attestation memory att = eas.getAttestation(itemAnchorUID);
        bytes32 anchorType = bytes32(0);
        if (att.data.length > 0) {
            (, anchorType) = abi.decode(att.data, (string, bytes32));
        }

        if (anchorType == bytes32(0)) {
            // Folder: the descriptive-label TAG targets the ANCHOR UID, bucket ANCHOR_SCHEMA_UID.
            for (uint256 i = 0; i < attesters.length; i++) {
                (bool exists, int256 weight) = edgeResolver.getActiveTagWeight(
                    attesters[i],
                    itemAnchorUID,
                    excludeTagDef,
                    anchorSchemaUID
                );
                if (exists && weight >= minWeight) return true;
            }
            return false;
        }

        // File: the TAG targets the DATA UID, reached per-lens via the placement PIN.
        // Note (ADR-0048): this branch is reached by any non-folder anchor, including LIST
        // anchors (anchorType == LIST_SCHEMA_UID, non-zero). A LIST has no placement PIN under
        // `dataSchemaUID`, so `getActivePinTarget` returns 0 for every lens and a LIST is never
        // excluded — non-folder/non-file anchors resolve no DATA under dataSchemaUID and pass
        // through unfiltered. Intentional for v1 (file/folder labels only); a three-way classifier
        // that also filters LIST items is deferred to a redeployable later version of this view.
        for (uint256 i = 0; i < attesters.length; i++) {
            bytes32 dataUID = edgeResolver.getActivePinTarget(itemAnchorUID, attesters[i], dataSchemaUID);
            if (dataUID == bytes32(0)) continue;
            (bool exists, int256 weight) = edgeResolver.getActiveTagWeight(
                attesters[i],
                dataUID,
                excludeTagDef,
                dataSchemaUID
            );
            if (exists && weight >= minWeight) return true;
        }
        return false;
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
     * @notice PIN-based file listing with cross-attester dedup. Opaque-cursor paginated
     *         (ADR-0036, ADR-0041). For each attester, reads the active PIN target
     *         (cardinality 1) at `_activeBySlot[anchorUID][attester][schema]` — Shape A
     *         file-placement reads.
     *
     *         Earlier attesters win on duplicate targets (ADR-0031 first-attester-wins).
     *         Filtered-out entries (targets claimed by an earlier attester) still advance
     *         the walker; `maxItems` bounds result size, not work.
     *
     * @param anchorUID  The path anchor (e.g. /memes/).
     * @param attesters  Lens addresses to query, in precedence order.
     * @param schema     Target schema to filter. **Must be DATA_SCHEMA_UID or
     *                   ANCHOR_SCHEMA_UID** — those are the only two payload shapes
     *                   the per-item decode below understands. Calling with any other
     *                   schema (e.g. PROPERTY_SCHEMA_UID) will produce decode reverts
     *                   or garbage `name`/`contentHash` fields. A separate, schema-aware
     *                   listing view is the right home for non-file PIN-shaped reads.
     * @param cursor     Opaque token from a prior call. Empty = start from the beginning.
     * @param maxItems   Target result size. Must be > 0.
     * @return page      `items` + `nextCursor`. `nextCursor.length == 0` iff every attester
     *                   has been walked.
     *
     * @dev Note: with PIN cardinality 1 per attester, the per-attester result is at most
     *      one item, so concurrent-mutation caveats from the prior TAG-list pagination no
     *      longer apply.
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

        // Decode cursor — empty OR malformed = fresh start at attesterIdx=0.
        // Same defensive pattern as `getDirectoryPageBySchemaAndAddressList`: length-check
        // protects against `abi.decode` Panics on arbitrary caller-supplied bytes.
        uint256 attesterIdx = 0;
        if (cursor.length == 32) {
            attesterIdx = abi.decode(cursor, (uint256));
        }

        bytes32[] memory buf = new bytes32[](maxItems);
        uint256 count = 0;

        while (attesterIdx < attesters.length && count < maxItems) {
            address currentAttester = attesters[attesterIdx];
            attesterIdx++;

            // O(1) PIN read — per-attester slot holds 0 or 1 target.
            bytes32 target = edgeResolver.getActivePinTarget(anchorUID, currentAttester, schema);
            if (target == bytes32(0)) continue;

            // Cross-attester dedup (ADR-0031 first-attester-wins): if an earlier attester
            // already has an active PIN placing this DATA at this anchor, skip — this lens
            // is already represented. PIN-specific check: file placement is Shape A (PIN only).
            // A TAG from an earlier attester must NOT suppress a later attester's valid PIN.
            bool taken = false;
            for (uint256 prior = 0; prior + 1 < attesterIdx; prior++) {
                if (edgeResolver.isActivePinEdge(attesters[prior], target, anchorUID)) {
                    taken = true;
                    break;
                }
            }
            if (taken) continue;

            buf[count++] = target;
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

        // Cursor: empty iff every attester walked.
        if (attesterIdx >= attesters.length) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(attesterIdx);
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
