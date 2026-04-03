// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { ISortFunc } from "./interfaces/ISortFunc.sol";
import { EFSIndexer } from "./EFSIndexer.sol";

/**
 * @title EFSSortOverlay
 * @dev SchemaResolver for the EFS SORT_INFO schema. Manages per-attester sorted doubly linked
 *      lists over EFSIndexer kernel arrays. Each SORT_INFO attestation declares a named sort
 *      attached to a parent directory. Anyone can call processItems to lazily populate their
 *      own sorted view of the directory's contents.
 *
 *      SORT_INFO schema: "address sortFunc, bytes32 targetSchema"
 *        - sortFunc:      ISortFunc contract that defines the ordering
 *        - targetSchema:  which Anchor schema to sort (bytes32(0) = all children)
 *        - refUID:        naming Anchor UID — the Anchor is a child of the directory being sorted
 *        - revocable:     true — revoking signals "I'm no longer maintaining this sort"
 *
 *      Sort overlay storage: per (sortInfoUID, attester) doubly linked list
 *        - sorted via client-supplied position hints validated by ISortFunc.isLessThan
 *        - lazy: processItems is called off-hook, paid by whoever wants the sort maintained
 *        - independent: each attester has their own sorted view
 *
 *      Staleness: getSortStaleness(sortInfoUID, attester) tells the UI how many kernel items
 *        are unprocessed. The UI can prompt "Alphabetical: 3 items behind".
 */
contract EFSSortOverlay is SchemaResolver {
    error LimitTooLarge();
    error InvalidSortInfo();
    error ArrayLengthMismatch();
    error InvalidPosition();

    event ItemSorted(
        bytes32 indexed sortInfoUID,
        address indexed attester,
        bytes32 indexed itemUID,
        bytes32 leftNeighbour,
        bytes32 rightNeighbour
    );

    /// @notice Maximum items returnable in a single getSortedChunk call
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice EFS schema UID for SORT_INFO attestations (set at deploy time)
    bytes32 public immutable SORT_INFO_SCHEMA_UID;

    /// @notice EFSIndexer — kernel read source (getChildrenByAttesterCount, getParent, isRevoked)
    EFSIndexer public immutable indexer;

    // ============================================================================================
    // STORAGE: SORT METADATA CACHE (from SORT_INFO attestation data)
    // ============================================================================================

    struct SortConfig {
        address sortFunc;
        bytes32 targetSchema;
        bool valid;
        bool revoked;
    }

    // sortInfoUID => cached SORT_INFO data
    mapping(bytes32 => SortConfig) private _sortConfigs;

    // ============================================================================================
    // STORAGE: SORTED DOUBLY LINKED LIST (per sortInfoUID, per attester)
    // ============================================================================================

    struct Node {
        bytes32 prev;
        bytes32 next;
    }

    // sortInfoUID => attester => itemUID => Node
    mapping(bytes32 => mapping(address => mapping(bytes32 => Node))) private _sortNodes;

    // sortInfoUID => attester => head itemUID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(address => bytes32)) private _sortHeads;

    // sortInfoUID => attester => tail itemUID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(address => bytes32)) private _sortTails;

    // sortInfoUID => attester => sorted item count
    mapping(bytes32 => mapping(address => uint256)) private _sortLengths;

    // ============================================================================================
    // STORAGE: LAZY PROCESSING PROGRESS
    // ============================================================================================

    // sortInfoUID => attester => count of kernel items acknowledged (inserted or skipped)
    mapping(bytes32 => mapping(address => uint256)) private _lastProcessedIndex;

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

        (address sortFunc, bytes32 targetSchema) = abi.decode(attestation.data, (address, bytes32));

        // sortFunc must be a non-zero address
        if (sortFunc == address(0)) return false;

        _sortConfigs[attestation.uid] = SortConfig({
            sortFunc: sortFunc,
            targetSchema: targetSchema,
            valid: true,
            revoked: false
        });

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        if (attestation.schema == SORT_INFO_SCHEMA_UID) {
            _sortConfigs[attestation.uid].revoked = true;
        }
        return true;
    }

    // ============================================================================================
    // SORT PROCESSING
    // ============================================================================================

    /**
     * @notice Sort the next batch of unprocessed kernel items into msg.sender's overlay.
     *         Anyone can call this — gas is paid by the caller.
     *
     * @param sortInfoUID  The SORT_INFO attestation UID declaring the sort config.
     * @param items        Item UIDs from the kernel array, in kernel order, starting from
     *                     _lastProcessedIndex[sortInfoUID][msg.sender].
     * @param leftHints    For each item: left neighbour in sorted list (bytes32(0) = insert at head).
     * @param rightHints   For each item: right neighbour in sorted list (bytes32(0) = insert at tail).
     *
     * @dev Items are validated via ISortFunc.isLessThan. Revoked or ineligible items (empty sort key)
     *      are skipped and still advance _lastProcessedIndex.
     *      The leftHint/rightHint for a sentinel (bytes32(0)) is not checked by isLessThan.
     */
    function processItems(
        bytes32 sortInfoUID,
        bytes32[] calldata items,
        bytes32[] calldata leftHints,
        bytes32[] calldata rightHints
    ) external {
        if (items.length == 0) return;
        if (items.length != leftHints.length || items.length != rightHints.length) revert ArrayLengthMismatch();

        SortConfig storage config = _sortConfigs[sortInfoUID];
        if (!config.valid || config.revoked) revert InvalidSortInfo();

        address attester = msg.sender;
        ISortFunc sortFunc = ISortFunc(config.sortFunc);

        for (uint256 i = 0; i < items.length; i++) {
            bytes32 item = items[i];
            bytes32 left = leftHints[i];
            bytes32 right = rightHints[i];

            // Skip revoked kernel items (still advance progress counter)
            if (indexer.isRevoked(item)) {
                _lastProcessedIndex[sortInfoUID][attester]++;
                continue;
            }

            // Skip ineligible items (sort key is empty — item doesn't belong in this sort)
            bytes memory key = sortFunc.getSortKey(item, sortInfoUID);
            if (key.length == 0) {
                _lastProcessedIndex[sortInfoUID][attester]++;
                continue;
            }

            // Validate position: left < item and item < right (sentinels are unchecked)
            if (left != bytes32(0) && !sortFunc.isLessThan(left, item, sortInfoUID)) revert InvalidPosition();
            if (right != bytes32(0) && !sortFunc.isLessThan(item, right, sortInfoUID)) revert InvalidPosition();

            // Insert item between left and right in the sorted linked list
            _insertBetween(sortInfoUID, attester, item, left, right);
            _lastProcessedIndex[sortInfoUID][attester]++;

            emit ItemSorted(sortInfoUID, attester, item, left, right);
        }
    }

    // ============================================================================================
    // INTERNAL: LINKED LIST OPERATIONS
    // ============================================================================================

    /// @dev Insert `item` between `leftNeighbour` and `rightNeighbour`. O(1).
    ///      leftNeighbour = bytes32(0) → item becomes the new head.
    ///      rightNeighbour = bytes32(0) → item becomes the new tail.
    function _insertBetween(
        bytes32 sortInfoUID,
        address attester,
        bytes32 item,
        bytes32 leftNeighbour,
        bytes32 rightNeighbour
    ) private {
        _sortNodes[sortInfoUID][attester][item] = Node({ prev: leftNeighbour, next: rightNeighbour });

        if (leftNeighbour != bytes32(0)) {
            _sortNodes[sortInfoUID][attester][leftNeighbour].next = item;
        } else {
            _sortHeads[sortInfoUID][attester] = item;
        }

        if (rightNeighbour != bytes32(0)) {
            _sortNodes[sortInfoUID][attester][rightNeighbour].prev = item;
        } else {
            _sortTails[sortInfoUID][attester] = item;
        }

        _sortLengths[sortInfoUID][attester]++;
    }

    // ============================================================================================
    // READ FUNCTIONS: SORTED PAGINATION
    // ============================================================================================

    /**
     * @notice Fetch a paginated chunk of an attester's sorted list.
     * @param sortInfoUID The SORT_INFO attestation UID.
     * @param attester    The attester whose sorted view to paginate.
     * @param startNode   Item UID to begin from. Pass bytes32(0) to start at the head.
     * @param limit       Items to return. Must be <= MAX_PAGE_SIZE (100).
     * @return items      Array of item UIDs in sorted order.
     * @return nextCursor UID of the next node for the following page. bytes32(0) = end of list.
     */
    function getSortedChunk(
        bytes32 sortInfoUID,
        address attester,
        bytes32 startNode,
        uint256 limit
    ) external view returns (bytes32[] memory items, bytes32 nextCursor) {
        if (limit > MAX_PAGE_SIZE) revert LimitTooLarge();
        if (limit == 0) return (new bytes32[](0), bytes32(0));

        bytes32 currentNode = startNode == bytes32(0) ? _sortHeads[sortInfoUID][attester] : startNode;

        bytes32[] memory result = new bytes32[](limit);
        uint256 count = 0;

        while (currentNode != bytes32(0) && count < limit) {
            result[count] = currentNode;
            currentNode = _sortNodes[sortInfoUID][attester][currentNode].next;
            count++;
        }

        if (count < limit) {
            assembly {
                mstore(result, count)
            }
        }

        return (result, currentNode);
    }

    // ============================================================================================
    // READ FUNCTIONS: STALENESS & PROGRESS
    // ============================================================================================

    /**
     * @notice How many kernel items are unprocessed for this (sortInfoUID, attester) pair.
     *         UI can show: "Alphabetical: N items behind".
     * @dev Staleness = kernelCount - lastProcessedIndex.
     *      kernelCount reads the physical length of the attester's array under the parent directory.
     *      Returns 0 if the sort is revoked or the parent cannot be resolved.
     */
    function getSortStaleness(bytes32 sortInfoUID, address attester) external view returns (uint256) {
        SortConfig storage config = _sortConfigs[sortInfoUID];
        if (!config.valid || config.revoked) return 0;

        Attestation memory sortInfo = _eas.getAttestation(sortInfoUID);
        if (sortInfo.uid == bytes32(0)) return 0;

        // namingAnchorUID is sortInfo.refUID; its parent is the directory being sorted
        bytes32 parentUID = indexer.getParent(sortInfo.refUID);
        if (parentUID == bytes32(0)) return 0;

        uint256 kernelCount = indexer.getChildrenByAttesterCount(parentUID, attester);
        uint256 processed = _lastProcessedIndex[sortInfoUID][attester];

        return kernelCount > processed ? kernelCount - processed : 0;
    }

    /**
     * @notice How many kernel items have been acknowledged (inserted or skipped) so far.
     *         Clients use this as the starting index when reading the kernel for processItems.
     */
    function getLastProcessedIndex(bytes32 sortInfoUID, address attester) external view returns (uint256) {
        return _lastProcessedIndex[sortInfoUID][attester];
    }

    // ============================================================================================
    // READ FUNCTIONS: LIST METADATA
    // ============================================================================================

    /// @notice Total items in an attester's sorted list for a given sortInfoUID.
    function getSortLength(bytes32 sortInfoUID, address attester) external view returns (uint256) {
        return _sortLengths[sortInfoUID][attester];
    }

    /// @notice Head (first/smallest) item UID. bytes32(0) = empty list.
    function getSortHead(bytes32 sortInfoUID, address attester) external view returns (bytes32) {
        return _sortHeads[sortInfoUID][attester];
    }

    /// @notice Tail (last/largest) item UID. bytes32(0) = empty list.
    function getSortTail(bytes32 sortInfoUID, address attester) external view returns (bytes32) {
        return _sortTails[sortInfoUID][attester];
    }

    /// @notice Prev/next pointers for a specific item in an attester's sorted list.
    function getSortNode(
        bytes32 sortInfoUID,
        address attester,
        bytes32 itemUID
    ) external view returns (Node memory) {
        return _sortNodes[sortInfoUID][attester][itemUID];
    }

    /// @notice Cached sort config for a SORT_INFO attestation.
    function getSortConfig(bytes32 sortInfoUID) external view returns (SortConfig memory) {
        return _sortConfigs[sortInfoUID];
    }
}
