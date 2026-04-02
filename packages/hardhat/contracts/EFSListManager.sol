// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/**
 * @title EFSListManager
 * @dev SchemaResolver for the EFS LIST_INFO and LIST_ITEM schemas. Manages per-attester
 *      doubly linked lists for each list, enabling O(1) insert, remove, and cursor-based
 *      pagination without off-chain indexers.
 *
 *      LIST_INFO schema: "uint8 listType, bytes32 targetSchemaUID"
 *        - refUID  → parent EFS Anchor UID (pins the list to a filesystem location; the
 *                    Anchor is the shared naming Schelling point — like DATA attestations)
 *        - listType: 0 = Manual (client-side fractional ordering), 1 = Chronological
 *        - targetSchemaUID: if non-zero, restricts LIST_ITEMs to that EAS schema type
 *
 *      LIST_ITEM schema: "bytes32 itemUID, string fractionalIndex, bytes32 tags"
 *        - refUID  → parent LIST_INFO attestation UID
 *        - itemUID: the target data attestation (bytes32(0) for address-based/EFP-style lists)
 *        - fractionalIndex: client-side ordering string (e.g. "a0V")
 *        - tags: optional Anchor UID for semantic categorisation
 *        - recipient: for address-based lists, the target Ethereum address
 *
 *      Editions model: each attester maintains their own independent linked list per LIST_INFO.
 *      The SPA merges multiple attesters' lists client-side via the Four-Tier Resolution Engine.
 *
 *      Discovery:
 *        - getListsByAnchor(anchorUID) — all LIST_INFOs pinned to a given Anchor
 *        - getListAttesters(listInfoUID) — all attesters who have ever added items to a list
 */
contract EFSListManager is SchemaResolver {
    error InvalidListInfo();
    error RevokedListInfo();
    error SchemaTypeMismatch();
    error LimitTooLarge();

    /// @notice Maximum items returnable in a single getSortedChunk call
    uint256 public constant MAX_PAGE_SIZE = 100;

    /// @notice EAS schema UID for LIST_INFO attestations
    bytes32 public immutable LIST_INFO_SCHEMA_UID;

    /// @notice EAS schema UID for LIST_ITEM attestations
    bytes32 public immutable LIST_ITEM_SCHEMA_UID;

    // ============================================================================================
    // STORAGE: DOUBLY LINKED LIST (per listInfoUID, per attester)
    // ============================================================================================

    struct Node {
        bytes32 prev;
        bytes32 next;
    }

    // listInfoUID => attester => itemAttestationUID => Node
    mapping(bytes32 => mapping(address => mapping(bytes32 => Node))) private _listNodes;

    // listInfoUID => attester => head attestation UID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(address => bytes32)) private _listHeads;

    // listInfoUID => attester => tail attestation UID (bytes32(0) = empty list)
    mapping(bytes32 => mapping(address => bytes32)) private _listTails;

    // listInfoUID => attester => item count
    mapping(bytes32 => mapping(address => uint256)) private _listLengths;

    // ============================================================================================
    // STORAGE: LIST METADATA CACHE (from LIST_INFO attestation data)
    // ============================================================================================

    // listInfoUID => listType (0=Manual, 1=Chronological)
    mapping(bytes32 => uint8) private _listTypes;

    // listInfoUID => targetSchemaUID (bytes32(0) = unrestricted)
    mapping(bytes32 => bytes32) private _targetSchemas;

    // Validity flags set on LIST_INFO attest, cleared (revoked) on LIST_INFO revoke.
    // Used to validate LIST_ITEM refUIDs without calling back into EAS from the hook.
    mapping(bytes32 => bool) private _isValidListInfo;
    mapping(bytes32 => bool) private _isRevokedListInfo;

    // ============================================================================================
    // STORAGE: DISCOVERY INDICES (append-only)
    // ============================================================================================

    // anchorUID => ordered list of LIST_INFO UIDs pinned to that Anchor
    mapping(bytes32 => bytes32[]) private _listsByAnchor;
    // anchorUID => listInfoUID => already recorded (dedup guard)
    mapping(bytes32 => mapping(bytes32 => bool)) private _listsByAnchorSeen;

    // listInfoUID => ordered list of unique attesters who have ever added items
    mapping(bytes32 => address[]) private _listAttesters;
    // listInfoUID => attester => already recorded (dedup guard)
    mapping(bytes32 => mapping(address => bool)) private _hasAttested;

    // ============================================================================================
    // CONSTRUCTOR
    // ============================================================================================

    constructor(IEAS eas, bytes32 listInfoSchemaUID, bytes32 listItemSchemaUID) SchemaResolver(eas) {
        LIST_INFO_SCHEMA_UID = listInfoSchemaUID;
        LIST_ITEM_SCHEMA_UID = listItemSchemaUID;
    }

    // ============================================================================================
    // SCHEMA RESOLVER HOOKS
    // ============================================================================================

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        if (attestation.schema == LIST_INFO_SCHEMA_UID) {
            return _handleListInfoAttest(attestation);
        }
        if (attestation.schema == LIST_ITEM_SCHEMA_UID) {
            return _handleListItemAttest(attestation);
        }
        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        if (attestation.schema == LIST_INFO_SCHEMA_UID) {
            _isRevokedListInfo[attestation.uid] = true;
            return true;
        }
        if (attestation.schema == LIST_ITEM_SCHEMA_UID) {
            return _handleListItemRevoke(attestation);
        }
        return true;
    }

    // ============================================================================================
    // INTERNAL: ATTEST HANDLERS
    // ============================================================================================

    function _handleListInfoAttest(Attestation calldata attestation) private returns (bool) {
        (uint8 listType, bytes32 targetSchemaUID) = abi.decode(attestation.data, (uint8, bytes32));
        _isValidListInfo[attestation.uid] = true;
        _listTypes[attestation.uid] = listType;
        _targetSchemas[attestation.uid] = targetSchemaUID;

        // If pinned to an Anchor (refUID != 0), record in the discovery index
        if (attestation.refUID != EMPTY_UID && !_listsByAnchorSeen[attestation.refUID][attestation.uid]) {
            _listsByAnchor[attestation.refUID].push(attestation.uid);
            _listsByAnchorSeen[attestation.refUID][attestation.uid] = true;
        }

        return true;
    }

    function _handleListItemAttest(Attestation calldata attestation) private returns (bool) {
        bytes32 listInfoUID = attestation.refUID;

        // Validate refUID points to a known, non-revoked LIST_INFO.
        // We use our own flags rather than calling back into EAS to avoid reentrancy concerns
        // and to remain consistent with the EFSIndexer pattern (internal state, no EAS callback).
        if (listInfoUID == EMPTY_UID || !_isValidListInfo[listInfoUID]) revert InvalidListInfo();
        if (_isRevokedListInfo[listInfoUID]) revert RevokedListInfo();

        // If the list has a targetSchemaUID constraint, validate the item's schema.
        // Address-based (EFP-style) items set itemUID = bytes32(0) and bypass this check.
        bytes32 targetSchemaUID = _targetSchemas[listInfoUID];
        if (targetSchemaUID != bytes32(0)) {
            (bytes32 itemUID, , ) = abi.decode(attestation.data, (bytes32, string, bytes32));
            if (itemUID != bytes32(0)) {
                Attestation memory item = _eas.getAttestation(itemUID);
                if (item.schema != targetSchemaUID) revert SchemaTypeMismatch();
            }
        }

        // Track unique attesters for this list (append-only discovery index)
        if (!_hasAttested[listInfoUID][attestation.attester]) {
            _listAttesters[listInfoUID].push(attestation.attester);
            _hasAttested[listInfoUID][attestation.attester] = true;
        }

        // Append to this attester's linked list tail for the given listInfoUID
        _appendToList(listInfoUID, attestation.attester, attestation.uid);
        return true;
    }

    // ============================================================================================
    // INTERNAL: REVOKE HANDLER
    // ============================================================================================

    function _handleListItemRevoke(Attestation calldata attestation) private returns (bool) {
        bytes32 listInfoUID = attestation.refUID;
        if (listInfoUID == EMPTY_UID) return true; // Nothing to unlink

        _removeFromList(listInfoUID, attestation.attester, attestation.uid);
        return true;
    }

    // ============================================================================================
    // INTERNAL: LINKED LIST OPERATIONS
    // ============================================================================================

    /// @dev Append a new node to the tail of (listInfoUID, attester)'s linked list. O(1).
    function _appendToList(bytes32 listInfoUID, address attester, bytes32 nodeUID) private {
        bytes32 currentTail = _listTails[listInfoUID][attester];

        _listNodes[listInfoUID][attester][nodeUID] = Node({ prev: currentTail, next: bytes32(0) });

        if (currentTail != bytes32(0)) {
            // Update old tail's next pointer
            _listNodes[listInfoUID][attester][currentTail].next = nodeUID;
        } else {
            // List was empty — this node is also the head
            _listHeads[listInfoUID][attester] = nodeUID;
        }

        _listTails[listInfoUID][attester] = nodeUID;
        _listLengths[listInfoUID][attester]++;
    }

    /// @dev Remove a node from (listInfoUID, attester)'s linked list. O(1).
    function _removeFromList(bytes32 listInfoUID, address attester, bytes32 nodeUID) private {
        Node memory node = _listNodes[listInfoUID][attester][nodeUID];

        // Stale revocation guard: if both pointers are zero and it's neither head nor tail,
        // the node was never inserted into this list (e.g. revoked after a prior revocation).
        if (
            node.prev == bytes32(0) &&
            node.next == bytes32(0) &&
            _listHeads[listInfoUID][attester] != nodeUID
        ) {
            return;
        }

        // Bridge neighbours
        if (node.prev != bytes32(0)) {
            _listNodes[listInfoUID][attester][node.prev].next = node.next;
        } else {
            // This was the head
            _listHeads[listInfoUID][attester] = node.next;
        }

        if (node.next != bytes32(0)) {
            _listNodes[listInfoUID][attester][node.next].prev = node.prev;
        } else {
            // This was the tail
            _listTails[listInfoUID][attester] = node.prev;
        }

        delete _listNodes[listInfoUID][attester][nodeUID];
        _listLengths[listInfoUID][attester]--;
    }

    // ============================================================================================
    // READ FUNCTIONS: PAGINATION
    // ============================================================================================

    /**
     * @notice Fetch a paginated chunk of a single attester's ordered list.
     * @param listInfoUID The UID of the parent LIST_INFO attestation.
     * @param attester    The attester whose edition to paginate.
     * @param startNode   The LIST_ITEM UID to begin from. Pass bytes32(0) to start at the head.
     * @param limit       Items to return. Must be <= MAX_PAGE_SIZE (100).
     * @return items      Array of LIST_ITEM attestation UIDs in linked-list order.
     * @return nextCursor UID of the next node for the following page. bytes32(0) = end of list.
     */
    function getSortedChunk(
        bytes32 listInfoUID,
        address attester,
        bytes32 startNode,
        uint256 limit
    ) external view returns (bytes32[] memory items, bytes32 nextCursor) {
        if (limit > MAX_PAGE_SIZE) revert LimitTooLarge();
        if (limit == 0) return (new bytes32[](0), bytes32(0));

        // Return empty for invalid or revoked lists
        if (!_isValidListInfo[listInfoUID] || _isRevokedListInfo[listInfoUID]) {
            return (new bytes32[](0), bytes32(0));
        }

        // startNode = bytes32(0) → begin at head; otherwise start FROM startNode (inclusive).
        // The nextCursor returned by each call is the first UID of the following page, so
        // passing it directly as startNode on the next call resumes without skipping items.
        bytes32 currentNode = startNode == bytes32(0) ? _listHeads[listInfoUID][attester] : startNode;

        bytes32[] memory result = new bytes32[](limit);
        uint256 count = 0;

        while (currentNode != bytes32(0) && count < limit) {
            result[count] = currentNode;
            currentNode = _listNodes[listInfoUID][attester][currentNode].next;
            count++;
        }

        // Trim array to actual count using assembly
        if (count < limit) {
            assembly {
                mstore(result, count)
            }
        }

        return (result, currentNode);
    }

    /// @notice Total items in an attester's list for a given LIST_INFO.
    function getListLength(bytes32 listInfoUID, address attester) external view returns (uint256) {
        return _listLengths[listInfoUID][attester];
    }

    /// @notice Head (first) LIST_ITEM UID for an attester's list. bytes32(0) = empty.
    function getListHead(bytes32 listInfoUID, address attester) external view returns (bytes32) {
        return _listHeads[listInfoUID][attester];
    }

    /// @notice Tail (last) LIST_ITEM UID for an attester's list. bytes32(0) = empty.
    function getListTail(bytes32 listInfoUID, address attester) external view returns (bytes32) {
        return _listTails[listInfoUID][attester];
    }

    /// @notice Get the prev/next pointers for a specific node in an attester's list.
    function getNode(
        bytes32 listInfoUID,
        address attester,
        bytes32 nodeUID
    ) external view returns (Node memory) {
        return _listNodes[listInfoUID][attester][nodeUID];
    }

    /// @notice Cached listType for a LIST_INFO (0=Manual, 1=Chronological).
    function getListType(bytes32 listInfoUID) external view returns (uint8) {
        return _listTypes[listInfoUID];
    }

    /// @notice Cached targetSchemaUID constraint for a LIST_INFO. bytes32(0) = unrestricted.
    function getTargetSchema(bytes32 listInfoUID) external view returns (bytes32) {
        return _targetSchemas[listInfoUID];
    }

    // ============================================================================================
    // READ FUNCTIONS: DISCOVERY INDICES
    // ============================================================================================

    /**
     * @notice Number of LIST_INFO attestations pinned to a given Anchor UID.
     * @param anchorUID The EFS Anchor UID (the named attachment point, e.g. /memes/top3).
     */
    function getListsByAnchorCount(bytes32 anchorUID) external view returns (uint256) {
        return _listsByAnchor[anchorUID].length;
    }

    /**
     * @notice Paginated list of LIST_INFO UIDs pinned to a given Anchor UID.
     * @param anchorUID The EFS Anchor UID.
     * @param start     Start index (0-based).
     * @param length    Maximum entries to return.
     */
    function getListsByAnchor(
        bytes32 anchorUID,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        bytes32[] storage all = _listsByAnchor[anchorUID];
        uint256 total = all.length;
        if (start >= total) return new bytes32[](0);
        uint256 end = start + length;
        if (end > total) end = total;
        bytes32[] memory result = new bytes32[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = all[i];
        }
        return result;
    }

    /**
     * @notice Number of unique attesters who have ever added items to a list.
     * @param listInfoUID The LIST_INFO UID.
     */
    function getListAttesterCount(bytes32 listInfoUID) external view returns (uint256) {
        return _listAttesters[listInfoUID].length;
    }

    /**
     * @notice Paginated list of unique attester addresses who have ever added items to a list.
     *         Append-only — revoked items do not remove the attester from this list.
     * @param listInfoUID The LIST_INFO UID.
     * @param start       Start index (0-based).
     * @param length      Maximum entries to return.
     */
    function getListAttesters(
        bytes32 listInfoUID,
        uint256 start,
        uint256 length
    ) external view returns (address[] memory) {
        address[] storage all = _listAttesters[listInfoUID];
        uint256 total = all.length;
        if (start >= total) return new address[](0);
        uint256 end = start + length;
        if (end > total) end = total;
        address[] memory result = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            result[i - start] = all[i];
        }
        return result;
    }
}
