// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListResolver
 * @dev Resolver for the EFS LIST schema (ADR-0044). Validates field shape at attest time.
 *      Stateful: maintains a parent-folder index and name lookup so EFSFileView can surface
 *      lists in directory listings without EFSIndexer involvement.
 *
 *      LIST schema: "string name, bool allowsDuplicates, bool appendOnly, uint8 targetType,
 *                    bytes32 targetSchema, uint32 maxEntries"
 *      revocable: false (LIST is permanent — identity of a list, like DATA)
 *
 *      refUID semantics: if refUID == bytes32(0), the list is free-floating; if refUID != 0,
 *      it is placed under the referenced folder anchor (indexed in _listsByParent).
 */
contract ListResolver is SchemaResolver {
    // abi.encode(string, bool, bool, uint8, bytes32, uint32) minimum length:
    //   head: 6 × 32 = 192 bytes (string pointer + 5 fixed params)
    //   tail: 32 bytes (string length word for empty string)
    //   total min: 224 bytes
    uint256 private constant MIN_LIST_DATA_LEN = 224;

    // ── State ────────────────────────────────────────────────────────────────

    /// @notice Name of each list, stored at attest time.
    mapping(bytes32 => string) private _listNames;

    /// @notice Lists placed under a specific parent anchor: parentUID → listUIDs[].
    ///         Append-only — lists are non-revocable so nothing ever leaves this array.
    mapping(bytes32 => bytes32[]) private _listsByParent;

    /// @notice Free-floating lists (refUID == 0): listUIDs[].
    bytes32[] private _freeLists;

    // ── Events ───────────────────────────────────────────────────────────────

    event ListAttested(
        bytes32 indexed listUID,
        address indexed attester,
        string name,
        bool allowsDuplicates,
        bool appendOnly,
        uint8 indexed targetType,
        bytes32 targetSchema,
        uint32 maxEntries,
        bytes32 parentUID
    );

    constructor(IEAS eas) SchemaResolver(eas) {}

    // ── Resolver hooks ───────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        require(a.data.length >= MIN_LIST_DATA_LEN && a.data.length % 32 == 0, "bad LIST payload");
        require(!a.revocable, "LIST must be non-revocable");
        require(a.expirationTime == 0, "LIST must not expire");
        require(a.recipient == address(0), "LIST must not be directed");

        (string memory name, bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries) =
            abi.decode(a.data, (string, bool, bool, uint8, bytes32, uint32));

        uint256 nameLen = bytes(name).length;
        require(nameLen > 0 && nameLen <= 255, "LIST name must be 1-255 bytes");

        require(targetType <= 2, "invalid targetType");

        if (targetType == 2 /* SCHEMA */) {
            require(targetSchema != bytes32(0), "SCHEMA mode requires targetSchema");
        } else {
            require(targetSchema == bytes32(0), "non-SCHEMA mode must have zero targetSchema");
        }

        // Reject the only unbounded combination: append-only + duplicates-allowed + uncapped
        if (appendOnly && allowsDuplicates) {
            require(maxEntries != 0, "appendOnly+allowsDuplicates requires maxEntries cap");
        }

        // Store name
        _listNames[a.uid] = name;

        // Index by parent (or as free-floating)
        bytes32 parentUID = a.refUID;
        if (parentUID != bytes32(0)) {
            _listsByParent[parentUID].push(a.uid);
        } else {
            _freeLists.push(a.uid);
        }

        emit ListAttested(a.uid, a.attester, name, allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries, parentUID);
        return true;
    }

    // onRevoke is unreachable — LIST is non-revocable. Implemented to satisfy abstract base.
    function onRevoke(Attestation calldata, uint256) internal override returns (bool) {
        return true;
    }

    // ── View functions ───────────────────────────────────────────────────────

    /// @notice Name stored for a list at creation time.
    function getListName(bytes32 listUID) external view returns (string memory) {
        return _listNames[listUID];
    }

    /// @notice All lists placed under a given parent anchor, in attestation order.
    ///         Append-only: the returned array grows but never shrinks.
    function getListsByParent(bytes32 parentUID) external view returns (bytes32[] memory) {
        return _listsByParent[parentUID];
    }

    /// @notice Count of lists under a parent anchor.
    function getListsByParentCount(bytes32 parentUID) external view returns (uint256) {
        return _listsByParent[parentUID].length;
    }

    /// @notice Free-floating lists (created without a parent folder).
    function getFreeLists() external view returns (bytes32[] memory) {
        return _freeLists;
    }
}
