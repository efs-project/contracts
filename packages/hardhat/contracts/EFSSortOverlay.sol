// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { ISortFunc } from "./interfaces/ISortFunc.sol";
import { EFSIndexer } from "./EFSIndexer.sol";

/**
 * @title EFSSortOverlay
 * @dev SchemaResolver for the EFS SORT_INFO schema. Manages shared sorted doubly linked
 *      lists over EFSIndexer kernel arrays. Each SORT_INFO attestation declares a named sort;
 *      the linked list is keyed by (sortInfoUID, parentAnchor) — shared across all users.
 *      Anyone can call processItems to lazily advance the shared sorted view. Gas is a public good.
 *
 *      SORT_INFO schema: "address sortFunc, bytes32 targetSchema, uint8 sourceType"
 *        - sortFunc:     ISortFunc contract that defines the ordering
 *        - targetSchema: which schema to sort (bytes32(0) = all children for sourceType 0)
 *        - sourceType:   0 = _children, 1 = _childrenBySchema(targetSchema), 2 = reserved
 *        - refUID:       naming Anchor UID — the concept identity (schelling point)
 *        - revocable:    true — revoking signals "no longer maintaining this sort"
 *
 *      Sort overlay storage: per (sortInfoUID, parentAnchor) shared doubly linked list
 *        - sorted via client-supplied position hints validated by ISortFunc.isLessThan
 *        - lazy: processItems advances a shared _lastProcessedIndex
 *        - editions filtering at read time via getSortedChunkByAddressList
 *
 *      Staleness: getSortStaleness(sortInfoUID, parentAnchor) returns unprocessed kernel items.
 */
contract EFSSortOverlay is SchemaResolver {
    error LimitTooLarge();
    error InvalidSortInfo();
    error ArrayLengthMismatch();
    error InvalidPosition();
    error InvalidItem();
    error StaleStartIndex();
    error UnnecessaryReposition();
    error UnsupportedSourceType();

    event ItemSorted(
        bytes32 indexed sortInfoUID,
        bytes32 indexed parentAnchor,
        bytes32 indexed itemUID,
        bytes32 leftNeighbour,
        bytes32 rightNeighbour
    );

    event ItemRepositioned(
        bytes32 indexed sortInfoUID,
        bytes32 indexed parentAnchor,
        bytes32 indexed itemUID,
        bytes32 newLeftNeighbour,
        bytes32 newRightNeighbour
    );

    /// @notice Maximum items returnable in a single getSortedChunk call
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice Default max nodes to walk in getSortedChunkByAddressList (0 = use this default)
    uint256 public constant DEFAULT_MAX_TRAVERSAL = 10_000;

    /// @notice EFS schema UID for SORT_INFO attestations (set at deploy time)
    bytes32 public immutable SORT_INFO_SCHEMA_UID;

    /// @notice EFSIndexer — kernel read source
    EFSIndexer public immutable indexer;

    // ============================================================================================
    // STORAGE: SORT METADATA CACHE (from SORT_INFO attestation data)
    // ============================================================================================

    struct SortConfig {
        address sortFunc;
        bytes32 targetSchema;
        uint8 sourceType;
        // valid/revoked removed — read from indexer.isRevoked(sortInfoUID) instead
        // parentUID removed — callers pass parentAnchor explicitly
    }

    // sortInfoUID => cached SORT_INFO data (populated in onAttest)
    mapping(bytes32 => SortConfig) private _sortConfigs;

    // Track which sortInfoUIDs have been registered (vs uninitialized)
    mapping(bytes32 => bool) private _sortConfigExists;

    // ============================================================================================
    // STORAGE: SHARED SORTED DOUBLY LINKED LIST (per sortInfoUID, per parentAnchor)
    // ============================================================================================

    struct Node {
        bytes32 prev;
        bytes32 next;
    }

    // sortInfoUID => parentAnchor => itemUID => Node{prev, next}
    mapping(bytes32 => mapping(bytes32 => mapping(bytes32 => Node))) private _sortNodes;

    // sortInfoUID => parentAnchor => head itemUID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(bytes32 => bytes32)) private _sortHeads;

    // sortInfoUID => parentAnchor => tail itemUID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(bytes32 => bytes32)) private _sortTails;

    // sortInfoUID => parentAnchor => sorted item count
    mapping(bytes32 => mapping(bytes32 => uint256)) private _sortLengths;

    // ============================================================================================
    // STORAGE: LAZY PROCESSING PROGRESS
    // ============================================================================================

    // sortInfoUID => parentAnchor => count of kernel items acknowledged (inserted or skipped)
    mapping(bytes32 => mapping(bytes32 => uint256)) private _lastProcessedIndex;

    // ============================================================================================
    // CONSTRUCTOR
    // ============================================================================================

    constructor(IEAS eas, bytes32 sortInfoSchemaUID, EFSIndexer _indexer) SchemaResolver(eas) {
        SORT_INFO_SCHEMA_UID = sortInfoSchemaUID;
        indexer = _indexer;
    }

    // ============================================================================================
    // SCHEMA RESOLVER HOOKS
    // ============================================================================================

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        if (attestation.schema != SORT_INFO_SCHEMA_UID) return true;

        // Require a naming Anchor refUID
        if (attestation.refUID == EMPTY_UID) return false;

        (address sortFunc, bytes32 targetSchema, uint8 sourceType) = abi.decode(
            attestation.data,
            (address, bytes32, uint8)
        );

        // sortFunc must be a non-zero address
        if (sortFunc == address(0)) return false;

        // Only sourceTypes 0 and 1 are supported in v1; 2+ are reserved
        if (sourceType > 1) revert UnsupportedSourceType();

        // Validate naming anchor has a parent (it must be a real directory child)
        bytes32 namingAnchorParent = indexer.getParent(attestation.refUID);
        if (namingAnchorParent == bytes32(0)) return false;

        _sortConfigs[attestation.uid] = SortConfig({
            sortFunc: sortFunc,
            targetSchema: targetSchema,
            sourceType: sourceType
        });
        _sortConfigExists[attestation.uid] = true;

        // Register in EFSIndexer so SORT_INFO attestations are discoverable via
        // getReferencingAttestations(namingAnchorUID, SORT_INFO_SCHEMA_UID).
        indexer.index(attestation.uid);

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        if (attestation.schema == SORT_INFO_SCHEMA_UID) {
            // Mirror the revocation into EFSIndexer so isRevoked() returns true for SORT_INFO UIDs.
            indexer.indexRevocation(attestation.uid);
        }
        return true;
    }

    // ============================================================================================
    // SORT PROCESSING
    // ============================================================================================

    /**
     * @notice Advance the shared sorted list for (sortInfoUID, parentAnchor) by processing a
     *         batch of kernel items. Anyone can call this — gas is paid by the caller.
     *
     * @param sortInfoUID        The SORT_INFO attestation UID declaring the sort config.
     * @param parentAnchor       The anchor whose children are being sorted.
     * @param expectedStartIndex Caller's view of _lastProcessedIndex[sortInfoUID][parentAnchor].
     *                           Silent no-op if current >= expectedStartIndex + items.length
     *                           (already processed by another caller). Reverts StaleStartIndex
     *                           if current != expectedStartIndex (partial overlap or race).
     * @param items              Item UIDs from the kernel array, in kernel order, starting at
     *                           expectedStartIndex.
     * @param leftHints          For each item: left neighbour in sorted list (bytes32(0) = head).
     * @param rightHints         For each item: right neighbour in sorted list (bytes32(0) = tail).
     */
    function processItems(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        uint256 expectedStartIndex,
        bytes32[] calldata items,
        bytes32[] calldata leftHints,
        bytes32[] calldata rightHints
    ) external {
        if (items.length == 0) return;
        if (items.length != leftHints.length || items.length != rightHints.length) revert ArrayLengthMismatch();

        SortConfig storage config = _sortConfigs[sortInfoUID];
        if (!_sortConfigExists[sortInfoUID]) revert InvalidSortInfo();
        if (indexer.isRevoked(sortInfoUID)) revert InvalidSortInfo();

        ISortFunc sortFunc = ISortFunc(config.sortFunc);
        uint256 currentIndex = _lastProcessedIndex[sortInfoUID][parentAnchor];

        // Concurrency: if already processed this entire batch, silent no-op
        if (currentIndex >= expectedStartIndex + items.length) return;

        // Concurrency: if partial overlap or stale, revert for caller to refresh
        if (currentIndex != expectedStartIndex) revert StaleStartIndex();

        for (uint256 i = 0; i < items.length; i++) {
            bytes32 item = items[i];
            bytes32 left = leftHints[i];
            bytes32 right = rightHints[i];

            // Validate item is the expected kernel element at this position.
            bytes32 expected = _getKernelItemAt(config, parentAnchor, currentIndex);
            if (item != expected) revert InvalidItem();
            currentIndex++;

            // Always insert revoked items — keeps list consistent with kernel.
            // Read functions skip revoked by default (showRevoked=false).

            // Skip ineligible items (sort key is empty — item doesn't belong in this sort)
            bytes memory key = sortFunc.getSortKey(item, sortInfoUID);
            if (key.length == 0) {
                continue;
            }

            // Validate position: left ≤ item ≤ right
            if (left != bytes32(0) && sortFunc.isLessThan(item, left, sortInfoUID)) revert InvalidPosition();
            if (right != bytes32(0) && sortFunc.isLessThan(right, item, sortInfoUID)) revert InvalidPosition();

            _insertBetween(sortInfoUID, parentAnchor, item, left, right);

            emit ItemSorted(sortInfoUID, parentAnchor, item, left, right);
        }

        _lastProcessedIndex[sortInfoUID][parentAnchor] = currentIndex;
    }

    /**
     * @notice Reposition an already-sorted item to a new position in the shared list.
     *         Used when sort keys may change (e.g. mutable metadata in future ISortFunc impls).
     *
     * @param sortInfoUID   The SORT_INFO attestation UID.
     * @param parentAnchor  The anchor whose sorted list to update.
     * @param itemUID       The item to reposition.
     * @param newLeftHint   New left neighbour (bytes32(0) = move to head).
     * @param newRightHint  New right neighbour (bytes32(0) = move to tail).
     *
     * @dev Reverts UnnecessaryReposition if item already satisfies the sorted invariant
     *      relative to its current neighbours. This prevents griefing via no-op calls.
     */
    function repositionItem(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32 itemUID,
        bytes32 newLeftHint,
        bytes32 newRightHint
    ) external {
        if (!_sortConfigExists[sortInfoUID]) revert InvalidSortInfo();
        if (indexer.isRevoked(sortInfoUID)) revert InvalidSortInfo();

        SortConfig storage config = _sortConfigs[sortInfoUID];
        ISortFunc sortFunc = ISortFunc(config.sortFunc);

        Node storage node = _sortNodes[sortInfoUID][parentAnchor][itemUID];

        // Idempotency check: if item already satisfies sorted invariant vs current neighbours,
        // the reposition is unnecessary. Revert to prevent gas-wasting no-op calls.
        bytes32 curPrev = node.prev;
        bytes32 curNext = node.next;
        bool alreadyCorrect = true;
        if (curPrev != bytes32(0) && sortFunc.isLessThan(itemUID, curPrev, sortInfoUID)) alreadyCorrect = false;
        if (curNext != bytes32(0) && sortFunc.isLessThan(curNext, itemUID, sortInfoUID)) alreadyCorrect = false;
        if (alreadyCorrect) revert UnnecessaryReposition();

        // Unlink item from its current position
        _unlink(sortInfoUID, parentAnchor, itemUID);

        // Validate and insert at new position
        if (newLeftHint != bytes32(0) && sortFunc.isLessThan(itemUID, newLeftHint, sortInfoUID))
            revert InvalidPosition();
        if (newRightHint != bytes32(0) && sortFunc.isLessThan(newRightHint, itemUID, sortInfoUID))
            revert InvalidPosition();

        _insertBetween(sortInfoUID, parentAnchor, itemUID, newLeftHint, newRightHint);

        emit ItemRepositioned(sortInfoUID, parentAnchor, itemUID, newLeftHint, newRightHint);
    }

    // ============================================================================================
    // CLIENT HINT COMPUTATION (VIEW — free to call, no gas cost)
    // ============================================================================================

    /**
     * @notice Compute the leftHint / rightHint arrays needed to call processItems.
     *         Call off-chain (eth_call) to avoid implementing binary-search in the client.
     *         For large lists (>1000 items), prefer the client-side computeHintsLocally utility.
     *
     * @param sortInfoUID  The SORT_INFO attestation UID.
     * @param parentAnchor The anchor whose shared sorted list to compute against.
     * @param newItems     Item UIDs in kernel order, starting from getLastProcessedIndex().
     * @return leftHints   Left neighbour for each item (bytes32(0) = head / ineligible).
     * @return rightHints  Right neighbour for each item (bytes32(0) = tail / ineligible).
     */
    function computeHints(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32[] calldata newItems
    ) external view returns (bytes32[] memory leftHints, bytes32[] memory rightHints) {
        if (!_sortConfigExists[sortInfoUID]) revert InvalidSortInfo();

        SortConfig storage config = _sortConfigs[sortInfoUID];
        ISortFunc sortFunc = ISortFunc(config.sortFunc);
        uint256 n = newItems.length;
        leftHints = new bytes32[](n);
        rightHints = new bytes32[](n);

        if (n == 0) return (leftHints, rightHints);

        // Load current shared sorted list into a mutable simulation array.
        uint256 existingLen = _sortLengths[sortInfoUID][parentAnchor];
        bytes32[] memory sim = new bytes32[](existingLen + n);
        uint256 simLen = 0;

        bytes32 cur = _sortHeads[sortInfoUID][parentAnchor];
        while (cur != bytes32(0)) {
            sim[simLen++] = cur;
            cur = _sortNodes[sortInfoUID][parentAnchor][cur].next;
        }

        for (uint256 i = 0; i < n; i++) {
            bytes32 item = newItems[i];

            bytes memory key = sortFunc.getSortKey(item, sortInfoUID);
            if (key.length == 0) continue; // ineligible — skip, leave zero sentinels

            // Binary search: find leftmost position where isLessThan(item, sim[pos]) is true.
            uint256 lo = 0;
            uint256 hi = simLen;
            while (lo < hi) {
                uint256 mid = (lo + hi) >> 1;
                if (sortFunc.isLessThan(item, sim[mid], sortInfoUID)) {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            uint256 pos = lo;

            leftHints[i] = pos == 0 ? bytes32(0) : sim[pos - 1];
            rightHints[i] = pos == simLen ? bytes32(0) : sim[pos];

            // Shift right to insert item into simulation for subsequent items
            for (uint256 j = simLen; j > pos; j--) {
                sim[j] = sim[j - 1];
            }
            sim[pos] = item;
            simLen++;
        }
    }

    // ============================================================================================
    // INTERNAL: KERNEL ACCESS BY SOURCE TYPE
    // ============================================================================================

    function _getKernelItemAt(
        SortConfig storage config,
        bytes32 parentAnchor,
        uint256 idx
    ) private view returns (bytes32) {
        if (config.sourceType == 0) {
            return indexer.getChildAt(parentAnchor, idx);
        } else if (config.sourceType == 1) {
            return indexer.getChildBySchemaAt(parentAnchor, config.targetSchema, idx);
        } else {
            // sourceType 2+ reserved — should never reach here (blocked in onAttest)
            revert UnsupportedSourceType();
        }
    }

    function _getKernelCount(SortConfig storage config, bytes32 parentAnchor) private view returns (uint256) {
        if (config.sourceType == 0) {
            return indexer.getChildrenCount(parentAnchor);
        } else if (config.sourceType == 1) {
            return indexer.getChildCountBySchema(parentAnchor, config.targetSchema);
        } else {
            revert UnsupportedSourceType();
        }
    }

    // ============================================================================================
    // INTERNAL: LINKED LIST OPERATIONS
    // ============================================================================================

    /// @dev Insert `item` between `leftNeighbour` and `rightNeighbour`. O(1).
    ///      leftNeighbour = bytes32(0) → item becomes the new head.
    ///      rightNeighbour = bytes32(0) → item becomes the new tail.
    ///      Reverts InvalidPosition if the two neighbours are not actually adjacent.
    function _insertBetween(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32 item,
        bytes32 leftNeighbour,
        bytes32 rightNeighbour
    ) private {
        bytes32 expectedRight = leftNeighbour == bytes32(0)
            ? _sortHeads[sortInfoUID][parentAnchor]
            : _sortNodes[sortInfoUID][parentAnchor][leftNeighbour].next;
        if (expectedRight != rightNeighbour) revert InvalidPosition();

        _sortNodes[sortInfoUID][parentAnchor][item] = Node({ prev: leftNeighbour, next: rightNeighbour });

        if (leftNeighbour != bytes32(0)) {
            _sortNodes[sortInfoUID][parentAnchor][leftNeighbour].next = item;
        } else {
            _sortHeads[sortInfoUID][parentAnchor] = item;
        }

        if (rightNeighbour != bytes32(0)) {
            _sortNodes[sortInfoUID][parentAnchor][rightNeighbour].prev = item;
        } else {
            _sortTails[sortInfoUID][parentAnchor] = item;
        }

        _sortLengths[sortInfoUID][parentAnchor]++;
    }

    /// @dev Unlink `item` from the list, updating its neighbours and head/tail pointers. O(1).
    function _unlink(bytes32 sortInfoUID, bytes32 parentAnchor, bytes32 itemUID) private {
        Node storage node = _sortNodes[sortInfoUID][parentAnchor][itemUID];
        bytes32 prev = node.prev;
        bytes32 next = node.next;

        if (prev != bytes32(0)) {
            _sortNodes[sortInfoUID][parentAnchor][prev].next = next;
        } else {
            _sortHeads[sortInfoUID][parentAnchor] = next;
        }

        if (next != bytes32(0)) {
            _sortNodes[sortInfoUID][parentAnchor][next].prev = prev;
        } else {
            _sortTails[sortInfoUID][parentAnchor] = prev;
        }

        delete _sortNodes[sortInfoUID][parentAnchor][itemUID];
        _sortLengths[sortInfoUID][parentAnchor]--;
    }

    // ============================================================================================
    // READ FUNCTIONS: SORTED PAGINATION
    // ============================================================================================

    /**
     * @notice Fetch a paginated chunk of the shared sorted list.
     * @param sortInfoUID  The SORT_INFO attestation UID.
     * @param parentAnchor The anchor whose sorted list to paginate.
     * @param startNode    Item UID to begin from. bytes32(0) = start at head.
     * @param limit        Items to return. Must be <= MAX_PAGE_SIZE.
     * @param showRevoked  If false (default), revoked items are skipped.
     * @return items       Array of item UIDs in sorted order.
     * @return nextCursor  UID of the next node for the following page. bytes32(0) = end.
     */
    function getSortedChunk(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32 startNode,
        uint256 limit,
        bool showRevoked
    ) external view returns (bytes32[] memory items, bytes32 nextCursor) {
        if (limit > MAX_PAGE_SIZE) revert LimitTooLarge();
        if (limit == 0) return (new bytes32[](0), bytes32(0));

        bytes32 currentNode = startNode == bytes32(0) ? _sortHeads[sortInfoUID][parentAnchor] : startNode;

        bytes32[] memory result = new bytes32[](limit);
        uint256 count = 0;

        while (currentNode != bytes32(0) && count < limit) {
            if (showRevoked || !indexer.isRevoked(currentNode)) {
                result[count++] = currentNode;
            }
            currentNode = _sortNodes[sortInfoUID][parentAnchor][currentNode].next;
        }

        assembly {
            mstore(result, count)
        }

        return (result, currentNode);
    }

    /**
     * @notice Edition-filtered sorted pagination. Returns only items where any of the given
     *         attesters contributed (using indexer.containsAttestations).
     *
     * @param sortInfoUID   The SORT_INFO attestation UID.
     * @param parentAnchor  The anchor whose sorted list to paginate.
     * @param startNode     Item UID to begin from. bytes32(0) = start at head.
     * @param limit         Max items to RETURN.
     * @param maxTraversal  Max nodes to WALK (0 = DEFAULT_MAX_TRAVERSAL).
     *                      Prevents RPC timeouts for sparse edition filters on large lists.
     *                      Caller keeps paginating until nextCursor = bytes32(0).
     * @param attesters     Edition list. Item qualifies if ANY attester contributed to it.
     * @param showRevoked   If false (default), revoked items are skipped.
     * @return items        Qualifying item UIDs in sorted order.
     * @return nextCursor   Resume cursor. bytes32(0) = end of list.
     */
    function getSortedChunkByAddressList(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32 startNode,
        uint256 limit,
        uint256 maxTraversal,
        address[] calldata attesters,
        bool showRevoked
    ) external view returns (bytes32[] memory items, bytes32 nextCursor) {
        if (limit > MAX_PAGE_SIZE) revert LimitTooLarge();
        if (limit == 0) return (new bytes32[](0), bytes32(0));
        if (attesters.length == 0) return (new bytes32[](0), bytes32(0));

        uint256 traversalLimit = maxTraversal == 0 ? DEFAULT_MAX_TRAVERSAL : maxTraversal;
        bytes32 currentNode = startNode == bytes32(0) ? _sortHeads[sortInfoUID][parentAnchor] : startNode;

        bytes32[] memory result = new bytes32[](limit);
        uint256 count = 0;
        uint256 traversed = 0;

        while (currentNode != bytes32(0) && count < limit && traversed < traversalLimit) {
            traversed++;
            bytes32 nodeToCheck = currentNode;
            currentNode = _sortNodes[sortInfoUID][parentAnchor][currentNode].next;

            if (!showRevoked && indexer.isRevoked(nodeToCheck)) continue;

            bool qualifies = false;
            for (uint256 j = 0; j < attesters.length; j++) {
                if (indexer.containsAttestations(nodeToCheck, attesters[j])) {
                    qualifies = true;
                    break;
                }
            }
            if (!qualifies) continue;

            result[count++] = nodeToCheck;
        }

        assembly {
            mstore(result, count)
        }

        // If traversal limit hit mid-list, currentNode is the resume point.
        // If list is exhausted, currentNode == bytes32(0).
        return (result, currentNode);
    }

    // ============================================================================================
    // READ FUNCTIONS: STALENESS & PROGRESS
    // ============================================================================================

    /**
     * @notice How many kernel items are unprocessed for (sortInfoUID, parentAnchor).
     *         UI can show: "ByName: N items unprocessed".
     * @dev kernelCount is determined by the sort's sourceType.
     *      Returns 0 for unknown or revoked sortInfoUIDs.
     */
    function getSortStaleness(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (uint256) {
        if (!_sortConfigExists[sortInfoUID]) return 0;
        if (indexer.isRevoked(sortInfoUID)) return 0;

        SortConfig storage config = _sortConfigs[sortInfoUID];
        uint256 kernelCount = _getKernelCount(config, parentAnchor);
        uint256 processed = _lastProcessedIndex[sortInfoUID][parentAnchor];

        return kernelCount > processed ? kernelCount - processed : 0;
    }

    /**
     * @notice How many kernel items have been acknowledged (inserted or skipped) so far.
     *         Clients use this as expectedStartIndex when calling processItems.
     */
    function getLastProcessedIndex(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (uint256) {
        return _lastProcessedIndex[sortInfoUID][parentAnchor];
    }

    // ============================================================================================
    // READ FUNCTIONS: LIST METADATA
    // ============================================================================================

    /// @notice Total items in the shared sorted list for (sortInfoUID, parentAnchor).
    function getSortLength(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (uint256) {
        return _sortLengths[sortInfoUID][parentAnchor];
    }

    /// @notice Head (first/smallest) item UID. bytes32(0) = empty list.
    function getSortHead(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (bytes32) {
        return _sortHeads[sortInfoUID][parentAnchor];
    }

    /// @notice Tail (last/largest) item UID. bytes32(0) = empty list.
    function getSortTail(bytes32 sortInfoUID, bytes32 parentAnchor) external view returns (bytes32) {
        return _sortTails[sortInfoUID][parentAnchor];
    }

    /// @notice Prev/next pointers for a specific item in the shared sorted list.
    function getSortNode(
        bytes32 sortInfoUID,
        bytes32 parentAnchor,
        bytes32 itemUID
    ) external view returns (Node memory) {
        return _sortNodes[sortInfoUID][parentAnchor][itemUID];
    }

    /// @notice Cached sort config for a SORT_INFO attestation. Zero-value if not registered.
    function getSortConfig(bytes32 sortInfoUID) external view returns (SortConfig memory) {
        return _sortConfigs[sortInfoUID];
    }

    /// @notice Returns true if a sortInfoUID has been registered via onAttest.
    function isSortRegistered(bytes32 sortInfoUID) external view returns (bool) {
        return _sortConfigExists[sortInfoUID];
    }
}
