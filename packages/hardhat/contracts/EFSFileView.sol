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
    ///         policy (ADR-0054). Used by `getDirectoryPageFiltered` for tag-exclusion.
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
    function getParent(bytes32 anchorUID) external view returns (bytes32);
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
    function getReferencingAttestations(
        bytes32 targetUID,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory);
    function getReferencingBySchemaAndAttester(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory);
}

/// @notice Minimal read view over the WhiteoutResolver (ADR-0055) the directory walk needs. The view
///         binds the whiteout resolver as a constructor immutable (it is stateless/redeployable), so
///         only the O(1) liveness predicate is declared here. `address(0)` ⇒ whiteout disabled (a
///         pre-WHITEOUT view redeploy / a test harness that doesn't wire one) and the predicate is
///         never called — the directory walk degrades to the no-whiteout behavior.
interface IWhiteoutResolverForFileView {
    /// @notice True iff `attester` has an ACTIVE whiteout suppressing `child` under `parent`.
    ///         See `WhiteoutResolver.isWhitedOut`.
    function isWhitedOut(bytes32 parent, address attester, bytes32 child) external view returns (bool);
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

    /// @notice Parallel-array tag-exclusion policy for `getDirectoryPageFiltered` (ADR-0054).
    /// @dev    Bundles the `(excludeTagDefs[k], minWeights[k])` pairs into one memory value so the
    ///         exclusion policy travels as a single stack slot through the phase walkers and into
    ///         `_isItemExcluded` (keeps `viaIR` under the EVM stack limit). `defs.length` must equal
    ///         `minWeights.length`; an empty policy means "exclude nothing".
    struct ExcludeFilter {
        bytes32[] defs;
        int256[] minWeights;
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
    /// @notice The WhiteoutResolver (proxy) for the cross-lens negative mask (ADR-0055). A constructor
    ///         immutable because the view is stateless/redeployable. `address(0)` ⇒ whiteout disabled:
    ///         the directory walk skips the negative-mask predicate entirely (pre-WHITEOUT views and
    ///         harnesses that don't wire one keep their exact prior behavior).
    IWhiteoutResolverForFileView public immutable whiteoutResolver;

    constructor(
        IEFSIndexer _indexer,
        IEdgeResolverForFileView _edgeResolver,
        IWhiteoutResolverForFileView _whiteoutResolver
    ) {
        indexer = _indexer;
        eas = _indexer.getEAS();
        edgeResolver = _edgeResolver;
        whiteoutResolver = _whiteoutResolver;
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
        // Parent-folder terminal (ADR-0055): if the listed folder is itself whited out for this viewer,
        // the page is empty — consistent with the router 404ing a deep link into a whited folder. This
        // schema-agnostic view uses DATA_SCHEMA_UID as the folder visibility-TAG def (standard browsing),
        // matching its per-item filter below.
        if (_isListedFolderWhitedOut(parentAnchor, attesters, indexer.DATA_SCHEMA_UID())) {
            return (new FileSystemItem[](0), 0);
        }

        (bytes32[] memory resolvedUIDs, uint256 nextCur) = indexer.getChildrenByAddressList(
            parentAnchor,
            attesters,
            startingCursor,
            pageSize,
            true,
            false
        );

        // Cross-lens negative mask (ADR-0055) — viewer-sovereignty consistency with the schema-aware
        // listings. This attester-scoped, schema-AGNOSTIC view returns a FIXED indexer page (it does not
        // run the phase walkers), so we filter the page in place: drop any child a lens in the stack
        // whited out and no higher-precedence lens re-asserts. The `nextCursor` is the indexer's OWN
        // source cursor (`nextCur`), independent of how many items we drop from this page — it advances
        // over source positions, not result slots — so trimming whited children leaves pagination correct
        // (no dup/drop across pages; the next call resumes at `nextCur` regardless).
        //
        // This view is schema-agnostic (returns all children), so the predicate's PIN/folder-visibility-TAG
        // positive checks key on DATA_SCHEMA_UID — matching what the schema-aware path passes for standard
        // file/folder browsing (`getDirectoryPageBySchemaAndAddressList` calls the predicate with
        // `anchorSchema`, which IS dataSchemaUID on the standard listing). Zero-cost when whiteout is
        // disabled: `_isItemWhitedOutForListing` short-circuits to false before any read when
        // `whiteoutResolver == address(0)`.
        if (address(whiteoutResolver) != address(0)) {
            bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();
            uint256 kept = 0;
            for (uint256 i = 0; i < resolvedUIDs.length; i++) {
                bytes32 uid = resolvedUIDs[i];
                // Advance the source walker (the loop) but consume no result slot for a whited child —
                // same skip the phase walkers apply. visibilityTagDef == dataSchemaUID (standard browsing).
                if (_isItemWhitedOutForListing(parentAnchor, uid, attesters, dataSchemaUID, dataSchemaUID)) continue;
                resolvedUIDs[kept++] = uid; // compact in place (kept <= i, so this never overwrites unread)
            }
            assembly ("memory-safe") {
                mstore(resolvedUIDs, kept)
            }
        }

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

    /// @dev Maximum exclude-tag predicates per `getDirectoryPageFiltered` call (ADR-0054).
    ///      The per-item exclusion check loops over `excludeTagDefs`, so the per-item file branch
    ///      is O(dataUIDs × lenses × excludeTags); this cap keeps that product bounded alongside
    ///      `MAX_ATTESTERS_PER_QUERY`. 8 comfortably covers the explorer's `system` + `nsfw` policy
    ///      (and headroom for future label policies) without letting a caller blow the per-item gas
    ///      budget. Symmetric in spirit to `MAX_ATTESTERS_PER_QUERY`.
    uint256 private constant MAX_EXCLUDE_TAGS_PER_QUERY = 8;

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

    /// @dev Hard cap on phase-1 entries inspected per call. Symmetric to `_FOLDER_SCAN_BUDGET_PER_CALL`
    ///      (phase 0). Used by BOTH directory views: `getDirectoryPageFiltered` (the exclusion
    ///      predicate can DROP phase-1 items) AND the plain `getDirectoryPageBySchemaAndAddressList`
    ///      (the ADR-0055 whited-out skip likewise drops phase-1 items). In either case a page that is
    ///      ~100% dropped under the lens would otherwise loop the entire phase-1 source in one
    ///      eth_call. This budget bounds per-call work; the opaque cursor (ADR-0036) continues
    ///      progress across calls — same pattern as the phase-0 budget and ADR-0020's mirror-scan cap.
    ///
    ///      Read through `_fileScanBudgetPerCall()` (not the bare constant) so a test-only
    ///      subclass can override it to a small value and exercise the budget guard without
    ///      seeding thousands of items. Production default is unchanged.
    uint256 private constant _FILE_SCAN_BUDGET_PER_CALL = 2048;

    /// @dev Per-call phase-0 (folder) scan budget. `internal view virtual` so a test-only
    ///      subclass can override it to a small value to exercise the budget guard
    ///      (ADR-0054's headline safety mechanism). Returns the production constant by default.
    function _folderScanBudgetPerCall() internal view virtual returns (uint256) {
        return _FOLDER_SCAN_BUDGET_PER_CALL;
    }

    /// @dev Per-call phase-1 (file) scan budget. `internal view virtual` so a test-only
    ///      subclass can override it to a small value to exercise the budget guard
    ///      (ADR-0054's headline safety mechanism). Returns the production constant by default.
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

        // Parent-folder terminal (ADR-0055): if the listed folder is itself whited out for this viewer,
        // the whole page is empty — consistent with the router 404ing a deep link into a whited folder.
        // Pass `anchorSchema` as the folder visibility-TAG def, matching the per-item walker (schema-aware
        // folder re-adds).
        if (_isListedFolderWhitedOut(parentAnchor, attesters, anchorSchema)) {
            page.items = new FileSystemItem[](0);
            page.nextCursor = "";
            return page;
        }

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
                    // Cross-lens negative mask (ADR-0055): a whited-out child advances the walker but
                    // consumes no slot — same skip as revoked / out-of-lens. Unconditional viewer
                    // sovereignty (applies to plain AND filtered listings).
                    if (
                        _isItemWhitedOutForListing(
                            parentAnchor,
                            uid,
                            attesters,
                            indexer.DATA_SCHEMA_UID(),
                            anchorSchema
                        )
                    ) continue;
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
            // Phase-1 scan budget (ADR-0055): the whited-out skip below DROPS items without consuming
            // a result slot, so a directory with many hidden direct files could otherwise loop the
            // entire remaining phase-1 source in one eth_call. Mirror the filtered walker's guard —
            // cap candidates fetched per call to the remaining budget, break at the budget, and return
            // the opaque cursor so the next page resumes mid-source (no dup/drop across pages).
            uint256 fileBudget = _fileScanBudgetPerCall();
            uint256 scanned = 0; // phase-1 entries inspected this call — bounded by budget
            while (count < maxItems && scanned < fileBudget) {
                uint256 remainingBudget = fileBudget - scanned;
                uint256 want = maxItems - count;
                // Fetch at most `remainingBudget` candidates so the per-call inspection count can't
                // exceed the budget regardless of how many get whited out below.
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
                    // Cross-lens negative mask (ADR-0055): drop whited-out files; the walker advances
                    // (and the scan budget) but the slot is not consumed (same as the filtered variant).
                    if (
                        _isItemWhitedOutForListing(
                            parentAnchor,
                            uid,
                            attesters,
                            indexer.DATA_SCHEMA_UID(),
                            anchorSchema
                        )
                    ) continue;
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
        page.items = _buildFileSystemItems(buf, parentAnchor, indexer.DATA_SCHEMA_UID(), indexer.PROPERTY_SCHEMA_UID());

        // Emit cursor: empty iff both sources exhausted, else encoded state.
        if (phase == 1 && fileSourceDone) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(phase, folderIdx, fileIdx);
        }
    }

    /**
     * @notice Tag-exclusion-filtered directory listing (ADR-0054). Identical walk, sources,
     *         budgets, and opaque cursor format (ADR-0036) to
     *         `getDirectoryPageBySchemaAndAddressList`, PLUS a per-item exclusion predicate over
     *         a set of `(excludeTagDefs[k], minWeights[k])` pairs (parallel arrays, ADR-0054):
     *
     *           **Skip an item if, for ANY pair k, ANY attester in `attesters` has an active TAG
     *           `excludeTagDefs[k]` on it with `weight >= minWeights[k]`.**
     *
     *         The exclusion is a UNION across the exclude-tag pairs AND across the viewed lenses —
     *         each pair applies the exact single-tag semantic the v1 form did (the multi-tag form
     *         supersedes the single-tag v1 so the explorer can hide e.g. `system` + `nsfw` in one
     *         call). The comparison is inclusive (`>=`) and lives in the view layer; each
     *         `minWeights[k]` is a caller argument (ADR-0042's `weight >= 0` is just the
     *         conventional `minWeight = 0` a caller passes, not a baked-in rule). The kernel stays
     *         weight-neutral. Empty arrays ⇒ no exclusion (degenerates to the unfiltered page).
     *
     *         **Tag-target asymmetry (load-bearing, ADR-0054).** A descriptive-label TAG targets
     *         different UIDs for folders vs files, and the predicate is a UNION over the viewed
     *         lenses (mirroring the client's `FileBrowser.resolveTagSet`): an item is excluded iff
     *         ANY viewed lens has an active `excludeTagDef` TAG (weight >= minWeight) on ANY DATA
     *         UID resolved at the item across the viewed lenses (files), or on the item's anchor
     *         UID (folders):
     *           - **folder** item (anchorType == bytes32(0)): the TAG targets the item's ANCHOR
     *             UID, bucket `ANCHOR_SCHEMA_UID`. Tested against every lens.
     *           - **file** item: the TAG targets a DATA UID, reached via the placement PIN
     *             `getActivePinTarget(itemAnchor, lens, dataSchemaUID)`, bucket `dataSchemaUID`.
     *             The DATA UIDs of ALL viewed lenses are collected (deduplicated) ONCE per item,
     *             then each is tested against EVERY lens's tags for EVERY exclude pair — so a DATA
     *             one lens pinned and ANOTHER viewed lens tagged is still excluded. Testing an
     *             exclude tag against a file's anchor UID is the wrong target and excludes
     *             nothing — the known footgun.
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
     * @param excludeTagDefs TAG predicates whose presence (with `weight >= minWeights[k]`) excludes.
     *                      Parallel to `minWeights`. Empty ⇒ no exclusion (unfiltered page).
     * @param minWeights    Inclusive weight thresholds, one per `excludeTagDefs[k]`. Caller-chosen
     *                      policy; `minWeights.length` must equal `excludeTagDefs.length`.
     * @param cursor        Opaque token from a prior call (ADR-0036); empty = fresh start.
     * @param maxItems      Target POST-filter result size. Must be > 0.
     * @return page         `items` (excluded items omitted) + `nextCursor`. `nextCursor.length == 0`
     *                      iff both phases are fully walked.
     */
    function getDirectoryPageFiltered(
        bytes32 parentAnchor,
        bytes32 anchorSchema,
        address[] memory attesters,
        bytes32[] memory excludeTagDefs,
        int256[] memory minWeights,
        bytes memory cursor,
        uint256 maxItems
    ) external view returns (DirectoryPage memory page) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        require(attesters.length <= MAX_ATTESTERS_PER_QUERY, "Too many attesters");
        require(excludeTagDefs.length == minWeights.length, "excludeTagDefs/minWeights length mismatch");
        require(excludeTagDefs.length <= MAX_EXCLUDE_TAGS_PER_QUERY, "Too many exclude tags");
        require(maxItems > 0, "maxItems must be > 0");

        // Parent-folder terminal (ADR-0055): a whited-out listed folder yields an empty page (router
        // parity). `anchorSchema` is the folder visibility-TAG def, matching the per-item walker.
        if (_isListedFolderWhitedOut(parentAnchor, attesters, anchorSchema)) {
            page.items = new FileSystemItem[](0);
            page.nextCursor = "";
            return page;
        }

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

        // Bundle the per-call inputs + mutable walker state into one memory struct. Passing the
        // walk state by reference into the per-phase helpers keeps each phase's inner locals out
        // of this function's frame, holding `viaIR` under the EVM stack limit (the phases are
        // otherwise byte-identical to `getDirectoryPageBySchemaAndAddressList`). `_walkPhase0`
        // and `_walkPhase1` mutate `w` in place.
        _FilteredWalk memory w = _FilteredWalk({
            parentAnchor: parentAnchor,
            anchorSchema: anchorSchema,
            attesters: attesters,
            filter: ExcludeFilter({ defs: excludeTagDefs, minWeights: minWeights }),
            dataSchemaUID: indexer.DATA_SCHEMA_UID(),
            anchorSchemaUID: indexer.ANCHOR_SCHEMA_UID(),
            maxItems: maxItems,
            phase: phase,
            folderIdx: folderIdx,
            fileIdx: fileIdx,
            buf: new bytes32[](maxItems),
            count: 0,
            fileSourceDone: false
        });

        // ───── Phase 0: qualifying tagged folders ─────
        if (w.phase == 0) _walkPhase0(w);

        // ───── Phase 1: direct children by schema ─────
        if (w.phase == 1) _walkPhase1(w);

        // Trim buffer to actual count
        bytes32[] memory buf = w.buf;
        uint256 finalCount = w.count;
        assembly ("memory-safe") {
            mstore(buf, finalCount)
        }
        page.items = _buildFileSystemItems(buf, parentAnchor, w.dataSchemaUID, indexer.PROPERTY_SCHEMA_UID());

        // Emit cursor: empty iff phase 1 fully exhausted, else encoded state.
        if (w.phase == 1 && w.fileSourceDone) {
            page.nextCursor = "";
        } else {
            page.nextCursor = abi.encode(w.phase, w.folderIdx, w.fileIdx);
        }
    }

    /// @dev Per-call inputs + mutable walker state for `getDirectoryPageFiltered`, threaded through
    ///      the per-phase helpers by reference. Splitting the phases into helpers (each taking only
    ///      this struct) keeps their inner-loop locals out of the entry function's stack frame so
    ///      `viaIR` stays under the EVM stack limit; the walk semantics are unchanged.
    struct _FilteredWalk {
        // inputs (read-only within the helpers)
        bytes32 parentAnchor;
        bytes32 anchorSchema;
        address[] attesters;
        ExcludeFilter filter;
        bytes32 dataSchemaUID;
        bytes32 anchorSchemaUID;
        uint256 maxItems;
        // walker state (mutated in place)
        uint8 phase;
        uint256 folderIdx;
        uint256 fileIdx;
        bytes32[] buf;
        uint256 count;
        bool fileSourceDone;
    }

    /// @dev Phase 0 of `getDirectoryPageFiltered`: qualifying tagged folders. Mutates `w` (advances
    ///      `folderIdx`/`count`, may set `phase = 1` when the folder source is exhausted). Logic is
    ///      identical to the sibling `getDirectoryPageBySchemaAndAddressList` phase 0 plus the
    ///      per-item exclusion predicate.
    function _walkPhase0(_FilteredWalk memory w) internal view {
        uint256 folderBudget = _folderScanBudgetPerCall();
        uint256 taggedTotal = edgeResolver.getChildrenWithEdgeCount(w.parentAnchor, w.anchorSchema);
        uint256 scanned = 0; // entries inspected this call — bounded by budget
        while (w.count < w.maxItems && w.folderIdx < taggedTotal && scanned < folderBudget) {
            uint256 remainingSource = taggedTotal - w.folderIdx;
            uint256 remainingBudget = folderBudget - scanned;
            uint256 chunk = remainingSource < _FOLDER_SCAN_CHUNK ? remainingSource : _FOLDER_SCAN_CHUNK;
            if (chunk > remainingBudget) chunk = remainingBudget;
            bytes32[] memory batch = edgeResolver.getChildrenWithEdge(
                w.parentAnchor,
                w.anchorSchema,
                w.folderIdx,
                chunk
            );
            for (uint256 k = 0; k < batch.length; k++) {
                w.folderIdx++; // advance walker for every inspected entry
                scanned++;
                bytes32 uid = batch[k];
                if (indexer.isRevoked(uid)) continue;
                if (!edgeResolver.hasActiveTagFromAny(uid, w.anchorSchema, w.attesters)) continue;
                // Cross-lens negative mask (ADR-0055): whited-out items advance the walker but consume
                // no slot. Checked alongside the tag-exclusion predicate (all are post-filter skips).
                if (
                    _isItemWhitedOutForListing(
                        w.parentAnchor,
                        uid,
                        w.attesters,
                        w.dataSchemaUID,
                        w.anchorSchema // visibility-TAG definition for this page (NOT ANCHOR schema UID)
                    )
                ) continue;
                // Exclusion predicate (post-filter slot accounting): excluded items advance
                // the walker but consume no slot, identical to a revoked/out-of-lens skip.
                if (_isItemExcluded(uid, w.attesters, w.filter, w.dataSchemaUID, w.anchorSchemaUID)) continue;
                w.buf[w.count++] = uid;
                if (w.count == w.maxItems) break;
            }
            if (batch.length < chunk) break; // defensive: resolver returned short batch
        }
        if (w.folderIdx >= taggedTotal) {
            w.phase = 1;
        }
    }

    /// @dev Phase 1 of `getDirectoryPageFiltered`: direct children by schema. Mutates `w` (advances
    ///      `fileIdx`/`count`, sets `fileSourceDone` when the file source is exhausted). Logic is
    ///      identical to the sibling `getDirectoryPageBySchemaAndAddressList` phase 1 plus the
    ///      per-item exclusion predicate and the phase-1 scan budget.
    function _walkPhase1(_FilteredWalk memory w) internal view {
        uint256 fileBudget = _fileScanBudgetPerCall();
        uint256 scanned = 0; // phase-1 entries inspected this call — bounded by budget
        while (w.count < w.maxItems && scanned < fileBudget) {
            uint256 remainingBudget = fileBudget - scanned;
            uint256 want = w.maxItems - w.count;
            // Fetch at most `remainingBudget` candidates so the per-call inspection count
            // can't exceed the budget regardless of how many get excluded below.
            if (want > remainingBudget) want = remainingBudget;
            (bytes32[] memory batch, uint256 nextFileCur) = indexer.getAnchorsBySchemaAndAddressList(
                w.parentAnchor,
                w.anchorSchema,
                w.attesters,
                w.fileIdx,
                want,
                true, // reverseOrder (newest first)
                false // showRevoked
            );
            for (uint256 k = 0; k < batch.length; k++) {
                scanned++;
                bytes32 uid = batch[k];
                // Cross-lens negative mask (ADR-0055): whited-out items advance the walker (and the scan
                // budget) but consume no slot — same post-filter accounting as the exclusion skip.
                if (
                    _isItemWhitedOutForListing(
                        w.parentAnchor,
                        uid,
                        w.attesters,
                        w.dataSchemaUID,
                        w.anchorSchema // visibility-TAG definition for this page (NOT ANCHOR schema UID)
                    )
                ) continue;
                if (_isItemExcluded(uid, w.attesters, w.filter, w.dataSchemaUID, w.anchorSchemaUID)) continue;
                w.buf[w.count++] = uid;
                if (w.count == w.maxItems) break;
            }
            w.fileIdx = nextFileCur;
            if (nextFileCur == 0) {
                w.fileSourceDone = true;
                break;
            }
            if (batch.length == 0) {
                // defensive: indexer returned no items but nonzero cursor — avoid infinite loop
                break;
            }
        }
    }

    /// @dev Per-item tag-exclusion predicate for `getDirectoryPageFiltered`. Decodes the item's
    ///      anchor once to determine folder-vs-file (anchorType == bytes32(0) ⇒ folder, the same
    ///      rule `_buildFileSystemItems` uses) and resolves the correct tag target(s) per the
    ///      ADR-0054 asymmetry. The exclusion is a UNION across the exclude-tag pairs
    ///      (`excludeTagDefs[k]`, `minWeights[k]`) AND over the viewed lenses on both the
    ///      target-resolution side and the tag-attester side — each pair applies the EXACT
    ///      single-tag semantic, matching the client's `FileBrowser.resolveTagSet` (union of
    ///      viewed attesters' tags) × `matchesUID` (item's resolved DATA UIDs) model:
    ///        - folder ⇒ for each pair k, test `excludeTagDefs[k]` on the ANCHOR UID, bucket
    ///                   ANCHOR_SCHEMA_UID, against every lens (a single target, union over lens
    ///                   tag-attesters);
    ///        - file   ⇒ first resolve the DEDUPLICATED set of DATA UIDs that ANY lens placed at
    ///                   this item via the placement PIN
    ///                   (`getActivePinTarget(anchor, lens, dataSchemaUID)`, dropping zeros) ONCE,
    ///                   then for each pair k test `excludeTagDefs[k]` on each such DATA UID
    ///                   (bucket dataSchemaUID) against every lens. The DATA-set collection happens
    ///                   ONCE per item (not once per exclude tag); this catches the cross-lens case
    ///                   where one lens pins a DATA that ANOTHER viewed lens has tagged — the viewer
    ///                   trusts the tagging lens.
    ///      Returns true iff, for ANY pair k, ANY lens has an active `excludeTagDefs[k]` TAG on ANY
    ///      resolved target with `weight >= minWeights[k]` (inclusive). Empty arrays ⇒ false (no
    ///      exclusion). All per-item reads are O(1); the file branch is O(lenses) PIN reads +
    ///      O(dataUIDs × lenses × excludeTags) tag reads, bounded by the MAX_ATTESTERS_PER_QUERY
    ///      (<= 20) and MAX_EXCLUDE_TAGS_PER_QUERY (<= 8) caps (no storage list scans).
    function _isItemExcluded(
        bytes32 itemAnchorUID,
        address[] memory attesters,
        ExcludeFilter memory filter,
        bytes32 dataSchemaUID,
        bytes32 anchorSchemaUID
    ) internal view returns (bool) {
        // Empty exclude set ⇒ nothing to exclude. Skip the anchor decode entirely.
        if (filter.defs.length == 0) return false;

        // Decode the anchor to classify folder vs file (anchorType == 0 ⇒ generic folder).
        Attestation memory att = eas.getAttestation(itemAnchorUID);
        bytes32 anchorType = bytes32(0);
        if (att.data.length > 0) {
            (, anchorType) = abi.decode(att.data, (string, bytes32));
        }

        if (anchorType == bytes32(0)) {
            // Folder: the descriptive-label TAG targets the ANCHOR UID, bucket ANCHOR_SCHEMA_UID.
            // Union across exclude pairs × lenses.
            for (uint256 t = 0; t < filter.defs.length; t++) {
                for (uint256 i = 0; i < attesters.length; i++) {
                    (bool exists, int256 weight) = edgeResolver.getActiveTagWeight(
                        attesters[i],
                        itemAnchorUID,
                        filter.defs[t],
                        anchorSchemaUID
                    );
                    if (exists && weight >= filter.minWeights[t]) return true;
                }
            }
            return false;
        }

        // File: the TAG targets the DATA UID, reached via the placement PIN. The exclusion is a
        // UNION over the viewed lenses on both sides (mirrors the client's
        // `dataUIDMap` × `resolveTagSet` model): exclude the item if, for ANY exclude pair, ANY
        // lens has an active TAG (weight >= that pair's minWeight) on ANY DATA UID that ANY lens
        // placed here. A per-lens-own-DATA loop would miss the cross-lens case — e.g. Alice pins
        // DATA_A and Bob (also a viewed lens) tags DATA_A as nsfw; the viewer trusts Bob's
        // judgment, so the item must be excluded even though Bob never pinned DATA_A himself.
        //
        // Step 1: collect the deduplicated set of non-zero DATA UIDs any lens placed at this item.
        // Done ONCE per item (NOT once per exclude tag) — bounded by attesters.length
        // (<= MAX_ATTESTERS_PER_QUERY), so a fixed-size memory array with linear dedup is
        // O(1)-class per read (no storage list scans).
        //
        // Note (ADR-0054): this branch is reached by any non-folder anchor, including LIST
        // anchors (anchorType == LIST_SCHEMA_UID, non-zero). A LIST has no placement PIN under
        // `dataSchemaUID`, so no lens resolves any DATA, the set below stays empty, and a LIST is
        // never excluded — non-folder/non-file anchors pass through unfiltered. Intentional for v1
        // (file/folder labels only); a three-way classifier that also filters LIST items is
        // deferred to a redeployable later version of this view.
        bytes32[] memory dataUIDs = new bytes32[](attesters.length);
        uint256 dataCount = 0;
        for (uint256 i = 0; i < attesters.length; i++) {
            bytes32 dataUID = edgeResolver.getActivePinTarget(itemAnchorUID, attesters[i], dataSchemaUID);
            if (dataUID == bytes32(0)) continue;
            bool seen = false;
            for (uint256 j = 0; j < dataCount; j++) {
                if (dataUIDs[j] == dataUID) {
                    seen = true;
                    break;
                }
            }
            if (!seen) dataUIDs[dataCount++] = dataUID;
        }

        // Step 2: exclude if, for ANY exclude pair, ANY lens has an active TAG
        // (weight >= that pair's minWeight) on ANY of the resolved DATA UIDs. This is the
        // cross-lens × multi-tag union the client applies.
        for (uint256 d = 0; d < dataCount; d++) {
            for (uint256 t = 0; t < filter.defs.length; t++) {
                for (uint256 i = 0; i < attesters.length; i++) {
                    (bool exists, int256 weight) = edgeResolver.getActiveTagWeight(
                        attesters[i],
                        dataUIDs[d],
                        filter.defs[t],
                        dataSchemaUID
                    );
                    if (exists && weight >= filter.minWeights[t]) return true;
                }
            }
        }
        return false;
    }

    /// @dev Per-item cross-lens negative-mask predicate (ADR-0055). Returns true iff the directory
    ///      entry `childAnchor` (a child of `parentAnchor`) must be rendered EMPTY for the viewer —
    ///      i.e. a lens in the stack whited it out and no higher-precedence lens re-asserts it with
    ///      its own placement. Same topology + budget gate as `_isItemExcluded` (O(1)-class per item,
    ///      one read per lens, bounded by MAX_ATTESTERS_PER_QUERY ≤ 20). Skip = advance the walker,
    ///      consume no result slot — identical to a revoked / tag-excluded skip.
    ///
    ///      Walk the lenses in PRECEDENCE order. Within each lens (ADR-0055 same-lens-override +
    ///      first-lens-wins; start/index-order-independent because the winner is re-derived per item):
    ///        - if that lens has an ACTIVE positive placement PIN at this child
    ///          (`getActivePinTarget(child, lens, dataSchemaUID) != 0`) ⇒ the lens substitutes its own
    ///          content here ⇒ VISIBLE, terminate (return false). A newer same-lens positive PIN thus
    ///          beats that lens's own earlier whiteout (positive-before-whiteout within a lens).
    ///        - else if that lens has an ACTIVE whiteout on this child ⇒ NEGATIVE terminal: the lens
    ///          masks the entry and stops fall-through to lower lenses ⇒ DROP, terminate (return true).
    ///        - else continue to the next (lower) lens — the whiteout/PIN of a higher lens already
    ///          terminated, so a lower lens's whiteout is transparent to a higher lens that asserts.
    ///      After the loop (no lens asserted either) ⇒ transparent ⇒ return false.
    ///
    ///      `whiteoutResolver == address(0)` (disabled) short-circuits to false before any read — a
    ///      pre-WHITEOUT view redeploy keeps its exact prior listing behavior.
    /// @dev Single-element-array wrapper for `edgeResolver.hasActiveTagFromAny` (which takes an
    ///      `address[] calldata`). The folder-fix listing predicate needs a TAG check scoped to ONE
    ///      lens at a time (precedence-ordered same-lens override), but EdgeResolver only exposes the
    ///      lens-aware ANY-of-many form — and it is FROZEN-by-UID (its address is hashed into the PIN/
    ///      TAG schema UIDs), so we cannot add a single-lens getter there. Wrapping the lens in a
    ///      1-element memory array reuses the frozen reader without touching it (ADR-0055 folder-fix).
    function _one(address lens) private pure returns (address[] memory arr) {
        arr = new address[](1);
        arr[0] = lens;
    }

    /// @dev The per-item LISTING-side negative-mask predicate (ADR-0055). The RESOLUTION-side terminal
    ///      (PIN-only positive; same-lens positive-before-whiteout; a whiteout suppresses strictly-lower
    ///      lenses) is applied inline in `getFilesAtPath`'s cursor walk and the router's `_findDataAtPath`,
    ///      NOT here. This listing predicate differs: its positive terminal is a file PIN OR — for GENERIC FOLDER
    ///      anchors only — a folder visibility TAG (the FOLDER RE-ADD FIX, via the `_one(lens)` wrapper
    ///      around `hasActiveTagFromAny`), so a lens that whites out a folder then re-asserts it with its
    ///      OWN visibility TAG is un-hidden in listings. `visibilityTagDef` is the listing's `anchorSchema`
    ///      param (the visibility TAG's definition — `dataSchemaUID` in the standard file/folder listing,
    ///      NOT the ANCHOR schema UID).
    ///
    ///      The TAG branch is gated to generic folder anchors (`forSchema == 0`, the same discriminator
    ///      `_buildFileSystemItems` uses for `isFolder`). A FILE anchor's only positive re-assertion is its
    ///      placement PIN — matching the PIN-gated resolution path (`getFilesAtPath`'s cursor walk and the
    ///      router's `_findDataAtPath`). Without this gate a same-lens TAG (`definition = dataSchemaUID`) on a
    ///      whited-out FILE anchor would un-hide it in directory listings while resolution still returns it
    ///      as deleted — a listing/resolution inconsistency (PR #37 review).
    ///
    ///      Walk the lenses in precedence order:
    ///        - the FIRST lens that asserts a positive (file PIN, or folder visibility TAG when the child is
    ///          a generic folder) is the item's contributing lens ⇒ VISIBLE (return false), terminate. A
    ///          newer same-lens positive thus beats that lens's own earlier whiteout (positive-before-
    ///          whiteout within a lens).
    ///        - else if that lens has an ACTIVE whiteout on this child ⇒ NEGATIVE terminal: the lens
    ///          masks the entry and stops fall-through to lower lenses ⇒ DROP (return true), terminate.
    ///        - else continue to the next (lower) lens.
    ///      `whiteoutResolver == address(0)` (disabled) short-circuits to false — a pre-WHITEOUT view
    ///      redeploy keeps its exact prior listing behavior.
    function _isItemWhitedOutForListing(
        bytes32 parentAnchor,
        bytes32 childAnchor,
        address[] memory attesters,
        bytes32 dataSchemaUID,
        bytes32 visibilityTagDef
    ) internal view returns (bool) {
        IWhiteoutResolverForFileView wr = whiteoutResolver;
        if (address(wr) == address(0)) return false;

        // Read-cost guard (specs/02 WHITEOUT invariant — whiteout must NOT double per-item EAS reads).
        // The ONLY way this predicate drops an item is an active whiteout on it; positives merely
        // OVERRIDE a whiteout. So scan the lens stack for ANY whiteout FIRST — O(1)-class WhiteoutResolver
        // mapping reads, NO `eas.getAttestation`. If none, the item is never dropped → return false
        // WITHOUT the folder-classification decode below. Ordinary pages (no active whiteouts) thus pay
        // ZERO extra EAS reads — only the per-item batched index reads they already did; the second
        // `getAttestation` happens once, in `_buildFileSystemItems`, for kept items. Only an item that
        // actually carries a whiteout pays the one decode needed to evaluate the folder re-add override.
        bool anyWhiteout = false;
        for (uint256 i = 0; i < attesters.length; i++) {
            if (wr.isWhitedOut(parentAnchor, attesters[i], childAnchor)) {
                anyWhiteout = true;
                break;
            }
        }
        if (!anyWhiteout) return false;

        // A whiteout exists in the stack — run the full precedence walk (positive-before-whiteout), which
        // needs the folder-vs-file classification for the folder-TAG re-add positive. Classify once: a
        // generic folder anchor has `forSchema == 0` (a file anchor has `forSchema == DATA_SCHEMA_UID`, a
        // typed/alias anchor a schema UID). Only a generic folder may be re-asserted by a visibility TAG;
        // everything else is PIN-positive only (resolution parity).
        bool childIsGenericFolder;
        {
            Attestation memory ca = eas.getAttestation(childAnchor);
            if (ca.data.length > 0) {
                (, bytes32 childForSchema) = abi.decode(ca.data, (string, bytes32));
                childIsGenericFolder = (childForSchema == bytes32(0));
            }
        }
        for (uint256 i = 0; i < attesters.length; i++) {
            address lens = attesters[i];
            // Positive terminal: file placement PIN (Shape A) OR — folders only — folder visibility TAG
            // (Shape B, the folder re-add fix) → visible, stop.
            if (
                edgeResolver.getActivePinTarget(childAnchor, lens, dataSchemaUID) != bytes32(0) ||
                (childIsGenericFolder && edgeResolver.hasActiveTagFromAny(childAnchor, visibilityTagDef, _one(lens)))
            ) {
                return false;
            }
            // Negative terminal: this lens whites the entry out → drop, stop (no fall-through).
            if (wr.isWhitedOut(parentAnchor, lens, childAnchor)) return true;
        }
        return false; // no lens asserted a positive or a whiteout → transparent.
    }

    /// @dev Listing-side PARENT-folder terminal (ADR-0055). The per-item filters above suppress whited
    ///      CHILDREN, but if the FOLDER BEING LISTED is itself whited out by a lens under ITS OWN parent
    ///      (and not re-added), the whole page must be suppressed for that viewer — otherwise listing the
    ///      known `/dir` anchor would still return lower-lens children while the router 404s `/dir/child`
    ///      (the per-segment terminal in EFSRouter). This is the listing analogue of that router terminal:
    ///      it evaluates the same `_isItemWhitedOutForListing` predicate (PIN OR folder visibility-TAG
    ///      re-add positive) with (grandparent, folderAnchor). Cheap + short-circuits when whiteout is
    ///      disabled; root / address-root (no parent) can't be whited (OrphanAnchor guard) → false.
    /// @param visibilityTagDef The listing's `anchorSchema` (the folder visibility-TAG definition) —
    ///        MUST match what the per-item walker uses, so a folder re-added under a non-DATA schema
    ///        (`TAG(definition=anchorSchema, refUID=folder)`) is recognized as visible by the parent check
    ///        too, not just by the per-item check below it. The PIN-positive arg stays `dataSchemaUID`
    ///        (file placement is always DATA-schema; a folder has no DATA PIN anyway).
    function _isListedFolderWhitedOut(bytes32 folderAnchor, address[] memory attesters, bytes32 visibilityTagDef)
        internal
        view
        returns (bool)
    {
        if (address(whiteoutResolver) == address(0)) return false;
        bytes32 grandparent = indexer.getParent(folderAnchor);
        if (grandparent == bytes32(0)) return false;
        return _isItemWhitedOutForListing(grandparent, folderAnchor, attesters, indexer.DATA_SCHEMA_UID(), visibilityTagDef);
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

        // Cross-lens negative mask (ADR-0055) — view/router consistency. This single-anchor file
        // reader resolves DATA AT `anchorUID` across the lens stack, the SAME shape as the router's
        // `_findDataAtPath` negative terminal (the resolved anchor here plays the router's
        // `targetAnchor` role). Apply the identical terminal so a whited-out anchor never serves DATA
        // through the view that the router would 404: precedence-ordered scan, positive placement PIN
        // FIRST then whiteout (same-lens positive-before-whiteout override, higher-lens transparency).
        // `_isItemWhitedOut` re-derives the winner per-item and short-circuits when the resolver is
        // disabled (`address(0)`), so a pre-WHITEOUT view keeps its exact prior behavior. The whiteout
        // key is (parent, lens, anchor) with parent = `indexer.getParent(anchorUID)`, exactly as the
        // router computes it; the positive-PIN override bucket is `schema` (the slot being read). The
        // `getParent` SLOAD is guarded on the resolver being wired — disabled views read nothing extra,
        // mirroring the router's `_findDataAtPath` guard.
        // Cross-lens negative mask (ADR-0055) is applied PER-LENS INSIDE the cursor walk below, NOT as a
        // whole-anchor pre-gate: a lens's whiteout suppresses lenses STRICTLY BELOW it even when a HIGHER
        // lens stays visible, so a higher positive PIN must not mask a lower-lens whiteout (the pre-gate
        // bug). PIN-only positive terminal (a direct file lookup is PIN-gated — a folder visibility TAG
        // must NOT un-gate a DATA read), mirroring the router's `_findDataAtPath`. The `getParent` SLOAD
        // is guarded on the resolver being wired — a disabled view reads nothing extra.
        IWhiteoutResolverForFileView wr = whiteoutResolver;
        bytes32 parentAnchor = address(wr) == address(0) ? bytes32(0) : indexer.getParent(anchorUID);

        // Decode cursor — empty OR malformed = fresh start at attesterIdx=0.
        // Same defensive pattern as `getDirectoryPageBySchemaAndAddressList`: length-check
        // protects against `abi.decode` Panics on arbitrary caller-supplied bytes.
        uint256 attesterIdx = 0;
        if (cursor.length == 32) {
            attesterIdx = abi.decode(cursor, (uint256));
        }

        // Cursor-bypass guard (ADR-0055 / specs/04): the per-lens whiteout terminal in the walk below only
        // fires for lenses at index >= attesterIdx. A caller-supplied opaque cursor could resume PAST a
        // whiteout-terminal lens (a stale or hand-crafted `abi.encode(k)`), skipping the terminal and
        // serving a lower lens's DATA — while the router's cursorless `_findDataAtPath` would 404. So
        // re-evaluate the SKIPPED prefix [0, attesterIdx): if any skipped lens whites out this anchor with
        // NO own positive PIN (it would have been a negative terminal), everything strictly below it is
        // suppressed → return the terminal empty page. A legitimate forward cursor never points past a
        // whiteout terminal (the walk sets `attesterIdx = attesters.length` on the first one), so this
        // only trips on a fabricated cursor. Bounded by MAX_ATTESTERS_PER_QUERY; zero when disabled.
        if (address(wr) != address(0)) {
            uint256 skipEnd = attesterIdx < attesters.length ? attesterIdx : attesters.length;
            for (uint256 j = 0; j < skipEnd; j++) {
                if (
                    edgeResolver.getActivePinTarget(anchorUID, attesters[j], schema) == bytes32(0) &&
                    wr.isWhitedOut(parentAnchor, attesters[j], anchorUID)
                ) {
                    page.items = new FileSystemItem[](0);
                    page.nextCursor = "";
                    return page;
                }
            }
        }

        bytes32[] memory buf = new bytes32[](maxItems);
        // Winning placement (lens) attester for each buffered target, kept in lockstep with
        // `buf`. The item's `attester` must be the attester whose active PIN won the walk —
        // NOT the DATA attestation author. With hardlinks/dedup the two differ (Alice can
        // place Bob's DATA in her lens), and clients scope follow-up PROPERTY/MIRROR reads
        // to the winning lens (ADR-0013, ADR-0014). This matches EFSRouter._findDataAtPath,
        // which returns the placement attester, not the DATA author.
        address[] memory bufAttesters = new address[](maxItems);
        uint256 count = 0;

        while (attesterIdx < attesters.length && count < maxItems) {
            address currentAttester = attesters[attesterIdx];
            attesterIdx++;

            // O(1) PIN read — per-attester slot holds 0 or 1 target.
            bytes32 target = edgeResolver.getActivePinTarget(anchorUID, currentAttester, schema);
            if (target == bytes32(0)) {
                // No positive placement by this lens. If it whites out this anchor, it is a NEGATIVE
                // TERMINAL (ADR-0055): suppress all strictly-lower lenses — keep the higher positives
                // already buffered, then STOP and force the cursor terminal so a later page can't resume
                // past the whiteout into the lower lenses. (A lens's own positive PIN above is emitted via
                // the `target != 0` branch, so same-lens positive-before-whiteout still holds.)
                if (address(wr) != address(0) && wr.isWhitedOut(parentAnchor, currentAttester, anchorUID)) {
                    attesterIdx = attesters.length; // cursor terminal — never resume past the whiteout
                    break;
                }
                continue;
            }

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

            bufAttesters[count] = currentAttester;
            buf[count++] = target;
        }

        // Trim buffers, build items. `buf` and `bufAttesters` advanced in lockstep, so the
        // same `count` trims both.
        assembly ("memory-safe") {
            mstore(buf, count)
            mstore(bufAttesters, count)
        }

        bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();
        FileSystemItem[] memory items = new FileSystemItem[](count);
        for (uint256 i = 0; i < count; i++) {
            Attestation memory att = eas.getAttestation(buf[i]);

            string memory name = "";

            if (att.schema != dataSchemaUID) {
                // Anchor: decode name. DATA carries no inline fields (ADR-0049), so there is
                // nothing to decode in the DATA branch. Guard on non-empty data — matching the two other
                // anchor-decode sites in this contract — because EAS permits a zero-length `data` field
                // on any schema, and an unguarded abi.decode of empty bytes panics and would brick the
                // whole listing page for one malformed item.
                bytes32 anchorType;
                if (att.data.length > 0) {
                    (name, anchorType) = abi.decode(att.data, (string, bytes32));
                }
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
                // Placement (lens) attester whose active PIN won the walk — NOT
                // `att.attester` (the DATA author). See `bufAttesters` declaration above.
                attester: bufAttesters[i],
                schema: att.schema,
                // AGENT-NOTE: hash/size now live as PROPERTYs (ADR-0049), not DATA fields.
                // Surfacing them in listings is future on-chain property-index work.
                contentHash: bytes32(0)
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
     * @notice Get a lens's mirrors (retrieval methods) for a DATA attestation. **Lens-scoped** (ADR-0013).
     * @dev The default mirror read: returns only `attester`'s active mirrors on `dataUID`, matching the
     *      router's lens-scoped mirror selection — so a foreign attester's mirror (arbitrary-scheme bytes
     *      since ADR-0056) can never surface to a viewer who didn't opt into that attester. Reads ARE
     *      lens-scoped (overview.md load-bearing invariants), so the lens `attester` is a REQUIRED
     *      parameter. For the rare cross-attester discovery case (debug/indexing) use
     *      `getDataMirrorsAllAttesters`, which is explicitly NOT lens-scoped.
     * @param dataUID   The DATA attestation UID
     * @param attester  The lens attester to scope to (required)
     * @param start     Pagination offset
     * @param length    Page size
     */
    function getDataMirrors(
        bytes32 dataUID,
        address attester,
        uint256 start,
        uint256 length
    ) external view returns (MirrorItem[] memory) {
        bytes32 mirrorSchemaUID = indexer.MIRROR_SCHEMA_UID();
        bytes32[] memory mirrorUIDs = indexer.getReferencingBySchemaAndAttester(
            dataUID,
            mirrorSchemaUID,
            attester,
            start,
            length,
            false, // reverseOrder
            false // showRevoked — serves active mirrors (re-checked below)
        );
        return _collectActiveMirrors(mirrorUIDs);
    }

    /**
     * @notice Get mirrors for a DATA across **ALL** attesters — NOT lens-scoped. Debug / discovery only.
     * @dev Returns every attester's mirrors, including ones from attesters the viewer never trusted.
     *      Mirror URIs are attester-controlled arbitrary bytes (any scheme, ADR-0056). A consumer of this
     *      MUST NOT render a foreign URI as a live link or auto-fetch it — each `MirrorItem.attester` is
     *      returned so it can be labelled/filtered. Production reads should use the lens-scoped
     *      `getDataMirrors(dataUID, attester, …)`; this exists only for cross-attester inspection.
     * @param dataUID  The DATA attestation UID
     * @param start    Pagination offset
     * @param length   Page size
     */
    function getDataMirrorsAllAttesters(
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
            false, // reverseOrder
            false // showRevoked — serves active mirrors (re-checked below)
        );
        return _collectActiveMirrors(mirrorUIDs);
    }

    /// @dev Shared tail of the mirror reads: drop revoked, decode (transportDefinition, uri), build items.
    function _collectActiveMirrors(bytes32[] memory mirrorUIDs) private view returns (MirrorItem[] memory) {
        uint256 activeCount = 0;
        for (uint256 i = 0; i < mirrorUIDs.length; i++) {
            if (!indexer.isRevoked(mirrorUIDs[i])) activeCount++;
        }
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
     * @notice Deprecated content-hash → canonical DATA reverse lookup. Always returns bytes32(0).
     * @dev AGENT-NOTE: hash/size now live as PROPERTYs (ADR-0049); reverse-lookup is future
     *      on-chain property-index work. DATA is empty/pure-identity, so there is no longer an
     *      intrinsic content-hash index; `dataByContentKey` is no longer written. Canonical/dedup
     *      resolution moves to the REDIRECT primitive (ADR-0050) + the property index. The method
     *      is retained as a no-op so the view ABI stays stable for callers during the transition.
     */
    function getCanonicalData(bytes32 /* contentHash */) external pure returns (bytes32) {
        return bytes32(0);
    }

    function decodeName(bytes memory data) external pure returns (string memory) {
        (string memory name, ) = abi.decode(data, (string, bytes32));
        return name;
    }
}
