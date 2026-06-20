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

/// @notice DRAFT (specs/09-redirect-resolution.md, Proposed). Minimal read view over the
///         AliasResolver's additive reverse-by-source index. Only the one getter the symlink
///         follower needs is declared here; `resolveRedirect` takes the resolver address as a
///         parameter (the view's constructor is frozen-additive — see `resolveRedirect`).
interface IAliasResolverForFileView {
    /// @notice The single active REDIRECT `attester` authored on `source`, or `(0, 0, 0)` if none.
    ///         Re-checks revocation live (a revoked redirect returns `(0, 0, 0)`). See
    ///         `AliasResolver.getActiveRedirect`.
    function getActiveRedirect(
        bytes32 source,
        address attester
    ) external view returns (bytes32 redirectUID, bytes32 target, uint16 kind);
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
            bytes32[] memory batch = edgeResolver.getChildrenWithEdge(w.parentAnchor, w.anchorSchema, w.folderIdx, chunk);
            for (uint256 k = 0; k < batch.length; k++) {
                w.folderIdx++; // advance walker for every inspected entry
                scanned++;
                bytes32 uid = batch[k];
                if (indexer.isRevoked(uid)) continue;
                if (!edgeResolver.hasActiveTagFromAny(uid, w.anchorSchema, w.attesters)) continue;
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

    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // DRAFT — REDIRECT/symlink follower (specs/09-redirect-resolution.md, Proposed)
    //
    // NOT TO BE DEPLOYED until specs/09-redirect-resolution.md is RATIFIED. This is an additive,
    // stateless read-time follower for the REDIRECT primitive (ADR-0050) so on-chain clients don't
    // each re-implement graph-walking. It lives here (a redeployable, stateless view — NOT a frozen
    // schema UID, NOT a resolver) so it is safe to draft and revise. Conceptually this WRAPS
    // `EFSRouter._findDataAtPath`'s no-follow path read with a bounded REDIRECT walk.
    // ═══════════════════════════════════════════════════════════════════════════════════════════

    /// @notice DRAFT terminal status of a `resolveRedirect` walk (specs/09-redirect-resolution.md).
    /// @dev    `Suppressed` is RESERVED for the future WHITEOUT negative-terminal schema
    ///         (ADR-0055) and is NOT produced by this version — the WHITEOUT schema does not exist
    ///         yet, so nothing sets it. The slot is reserved so adding WHITEOUT-following later is
    ///         an additive enum extension, not a renumber (clients can switch on it defensively
    ///         today). Enum order is part of the draft ABI; new statuses APPEND only.
    enum RedirectStatus {
        Resolved, // 0: reached a terminal (non-redirected) UID; `resolvedUID` is it
        Dangling, // 1: a redirect pointed at a missing/revoked/wrong-type target — stop, don't revert
        CycleStopped, // 2: revisited a UID already on the walk — stop (no infinite loop)
        DepthExceeded, // 3: hit the hop cap before reaching a terminal
        Suppressed // 4: RESERVED for WHITEOUT (ADR-0055); never returned by this version
    }

    /// @notice DRAFT result of a `resolveRedirect` walk (specs/09-redirect-resolution.md).
    /// @param resolvedUID The terminal UID reached (the last good node). On `Dangling` this is the
    ///                    last VALID node before the broken hop (NOT the missing target), so a
    ///                    caller still has a usable anchor. On `CycleStopped`/`DepthExceeded` it is
    ///                    where the walk stopped.
    /// @param isData      True iff `resolvedUID` is a DATA attestation (else an Anchor). Meaningless
    ///                    when `status == Dangling` and the start itself was already invalid.
    /// @param status      Terminal status (see `RedirectStatus`).
    /// @param hops        Number of redirects FOLLOWED (0 = `sourceUID` was already terminal).
    struct RedirectResolution {
        bytes32 resolvedUID;
        bool isData;
        RedirectStatus status;
        uint256 hops;
    }

    /// @dev DRAFT default hop cap (D_MAX) when caller passes `maxHops == 0`
    ///      (specs/09-redirect-resolution.md). Matches the spec's canonical D_MAX.
    uint16 private constant _REDIRECT_D_MAX = 8;

    /// @dev DRAFT hard ceiling on hops regardless of the caller's `maxHops`
    ///      (specs/09-redirect-resolution.md). Also sizes the in-memory visited-set, so it
    ///      directly bounds the walk's memory + gas. A caller asking for more is clamped to this.
    uint16 private constant _REDIRECT_HOP_CEILING = 32;

    /// @notice DRAFT bounded, lens-scoped REDIRECT/symlink follower
    ///         (specs/09-redirect-resolution.md, Proposed — NOT ratified, NOT for deployment).
    ///
    ///         Walks the REDIRECT graph from `sourceUID`, following at most one redirect per node
    ///         (the active redirect authored by the FIRST lens in `lenses` that has one on that
    ///         node — ADR-0031 first-attester-wins), until it reaches a terminal node, detects a
    ///         cycle, exceeds the hop cap, or hits a dangling target. Never reverts.
    ///
    ///         **Follow rules by kind (specs/09; do not deviate):**
    ///           - `symlink` (2): source Anchor → target (Anchor or DATA). Followed.
    ///           - `supersededBy` (1): DATA → newer DATA. Followed (walk to the newest in the chain).
    ///           - `sameAs` (0): canonicalization hint only — NOT auto-navigated by this follower.
    ///             A node whose only redirect is `sameAs` is treated as terminal here.
    ///           - `3+` (reserved, e.g. relatedVersion): never auto-followed — terminal.
    ///
    ///         **Lens-scoping (ADR-0031).** At each node we read `getActiveRedirect(node, lens)`
    ///         for each `lens` in order and take the FIRST hit (lowest-index lens wins). A redirect
    ///         authored only by an attester OUTSIDE `lenses` is invisible — the node is terminal
    ///         under this lens set. `lenses` is the caller's trust set, same as every other
    ///         lens-scoped read in this view.
    ///
    ///         **Bounded walk, not SCC.** A small in-memory visited-set + a hop cap is sufficient
    ///         and correct for NAVIGATION (we only need to stop, not to compute the lowest-UID SCC
    ///         representative — that canonicalization choice is the writer's / a richer off-chain
    ///         pass). On revisit we STOP with `CycleStopped`; we never loop.
    ///
    ///         **Dangling.** If a node's active redirect targets a UID that is missing, revoked, or
    ///         the wrong type for the kind, we STOP with `Dangling` and return the LAST VALID node
    ///         (so the caller still has a usable anchor), never reverting.
    ///
    /// @param sourceUID The UID to start from (an Anchor for symlink chains, a DATA for version
    ///                  chains). If it has no active in-lens redirect, returns it as `Resolved`,
    ///                  `hops == 0`.
    /// @param lenses    Trust set in precedence order (ADR-0031). Must be non-empty and within the
    ///                  per-query cap. A redirect is followed only if authored by one of these.
    /// @param maxHops   Hop cap. `0` ⇒ default `_REDIRECT_D_MAX` (8). Clamped to the hard ceiling
    ///                  `_REDIRECT_HOP_CEILING` (32). Exceeding the effective cap ⇒ `DepthExceeded`.
    /// @param aliasResolver The AliasResolver (proxy) exposing `getActiveRedirect`. Passed as a
    ///                  parameter because this view's constructor is frozen-additive (we add no
    ///                  immutable). Callers supply the canonical REDIRECT resolver address.
    /// @return res      The terminal UID + whether it is DATA + status + hops followed.
    function resolveRedirect(
        bytes32 sourceUID,
        address[] calldata lenses,
        uint16 maxHops,
        IAliasResolverForFileView aliasResolver
    ) external view returns (RedirectResolution memory res) {
        require(lenses.length > 0, "Lenses list cannot be empty");
        require(lenses.length <= MAX_ATTESTERS_PER_QUERY, "Too many lenses");

        // Effective cap: default to D_MAX when unset, clamp to the hard ceiling.
        uint256 cap = maxHops == 0 ? _REDIRECT_D_MAX : maxHops;
        if (cap > _REDIRECT_HOP_CEILING) cap = _REDIRECT_HOP_CEILING;

        bytes32 dataSchemaUID = indexer.DATA_SCHEMA_UID();
        bytes32 anchorSchemaUID = indexer.ANCHOR_SCHEMA_UID();

        // Visited-set sized to the hard ceiling + 1 (the start node plus up to `cap` hops). A
        // bounded array with linear membership scan is correct and cheap: at most 33 entries,
        // O(hops) per check, no storage. This is the navigation-correct cycle guard
        // (specs/09-redirect-resolution.md) — NOT a full Tarjan/SCC, which is unnecessary on-chain.
        bytes32[] memory visited = new bytes32[](uint256(_REDIRECT_HOP_CEILING) + 1);
        uint256 visitedCount = 0;

        bytes32 current = sourceUID;
        bool currentIsData = _classifyUID(sourceUID, dataSchemaUID, anchorSchemaUID) == _UIDKind.Data;
        res.resolvedUID = current;
        res.isData = currentIsData;
        res.status = RedirectStatus.Resolved;
        res.hops = 0;

        for (uint256 h = 0; ; h++) {
            // Record `current` in the visited-set; bail on revisit (cycle).
            for (uint256 v = 0; v < visitedCount; v++) {
                if (visited[v] == current) {
                    res.status = RedirectStatus.CycleStopped;
                    return res;
                }
            }
            visited[visitedCount++] = current;

            // Find the first in-lens active redirect on `current` (ADR-0031 first-attester-wins).
            (bytes32 redirectUID, bytes32 target, uint16 kind) = _firstInLensRedirect(current, lenses, aliasResolver);
            if (redirectUID == bytes32(0)) {
                // No in-lens redirect — `current` is terminal under this lens set.
                res.status = RedirectStatus.Resolved;
                return res;
            }

            // Decide whether this kind is auto-followed (specs/09): symlink(2) and
            // supersededBy(1) are; sameAs(0) and reserved(3+) are NOT — treat as terminal.
            if (kind != _KIND_SYMLINK && kind != _KIND_SUPERSEDED_BY) {
                res.status = RedirectStatus.Resolved;
                return res;
            }

            // Validate the target for the kind. A missing/revoked/wrong-type target is DANGLING:
            // stop and keep the last VALID node (`current`) as the result.
            _UIDKind targetKind = _classifyUID(target, dataSchemaUID, anchorSchemaUID);
            bool targetOk;
            if (kind == _KIND_SUPERSEDED_BY) {
                // DATA → DATA only.
                targetOk = targetKind == _UIDKind.Data;
            } else {
                // symlink: target may be Anchor OR DATA.
                targetOk = targetKind == _UIDKind.Data || targetKind == _UIDKind.Anchor;
            }
            if (!targetOk) {
                res.status = RedirectStatus.Dangling;
                return res; // res.resolvedUID/isData still reflect the last valid node
            }

            // Would following this hop exceed the cap? If so, stop at `current` (the last node we
            // actually settled on) with DepthExceeded. We check AFTER confirming a valid next hop
            // exists so a chain that ends exactly at the cap reports Resolved, not DepthExceeded.
            if (h + 1 > cap) {
                res.status = RedirectStatus.DepthExceeded;
                return res;
            }

            // Advance.
            current = target;
            res.resolvedUID = target;
            res.isData = targetKind == _UIDKind.Data;
            res.hops = h + 1;
        }
    }

    /// @dev DRAFT kind discriminators mirrored from AliasResolver (specs/09; the taxonomy is
    ///      resolver logic + client convention, ADR-0050, not part of any frozen UID).
    uint16 private constant _KIND_SUPERSEDED_BY = 1;
    uint16 private constant _KIND_SYMLINK = 2;

    /// @dev DRAFT UID classification for the redirect follower.
    enum _UIDKind {
        Unknown, // not found / revoked / neither DATA nor ANCHOR
        Data,
        Anchor
    }

    /// @dev DRAFT: classify `uid` as DATA / Anchor / Unknown, treating revoked or absent as
    ///      Unknown (so a revoked target is Dangling). Uses the indexer's revocation view +
    ///      EAS schema, matching how the rest of this view reasons about node types.
    function _classifyUID(
        bytes32 uid,
        bytes32 dataSchemaUID,
        bytes32 anchorSchemaUID
    ) internal view returns (_UIDKind) {
        if (uid == bytes32(0)) return _UIDKind.Unknown;
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0)) return _UIDKind.Unknown; // never attested
        if (att.revocationTime != 0) return _UIDKind.Unknown; // revoked ⇒ treat as missing
        if (att.schema == dataSchemaUID) return _UIDKind.Data;
        if (att.schema == anchorSchemaUID) return _UIDKind.Anchor;
        return _UIDKind.Unknown;
    }

    /// @dev DRAFT: return the first in-lens active redirect on `node` (ADR-0031 first-attester-wins
    ///      over `lenses` precedence order), or `(0, 0, 0)` if no lens has one. One getter call per
    ///      lens, short-circuiting on the first hit — bounded by MAX_ATTESTERS_PER_QUERY.
    function _firstInLensRedirect(
        bytes32 node,
        address[] calldata lenses,
        IAliasResolverForFileView aliasResolver
    ) internal view returns (bytes32 redirectUID, bytes32 target, uint16 kind) {
        for (uint256 i = 0; i < lenses.length; i++) {
            (bytes32 ruid, bytes32 t, uint16 k) = aliasResolver.getActiveRedirect(node, lenses[i]);
            if (ruid != bytes32(0)) return (ruid, t, k);
        }
        return (bytes32(0), bytes32(0), 0);
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
