// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListResolver
 * @dev Resolver for the EFS LIST schema (ADR-0044). Validates field shape at attest time.
 *      Maintains no state — all enforcement state lives in ListEntryResolver.
 *
 *      LIST schema: "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries"
 *      revocable: false (LIST is permanent — identity of a list, like DATA)
 */
contract ListResolver is SchemaResolver {
    uint256 private constant EXPECTED_LIST_DATA_LEN = 160; // 5 × 32

    event ListAttested(
        bytes32 indexed listUID,
        address indexed attester,
        bool allowsDuplicates,
        bool appendOnly,
        uint8 indexed targetType,
        bytes32 targetSchema,
        uint32 maxEntries
    );

    constructor(IEAS eas) SchemaResolver(eas) {}

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        require(a.data.length == EXPECTED_LIST_DATA_LEN, "bad LIST payload");
        require(!a.revocable, "LIST must be non-revocable");
        require(a.expirationTime == 0, "LIST must not expire");
        require(a.refUID == bytes32(0), "LIST must be free-floating");
        require(a.recipient == address(0), "LIST must not be directed");

        (bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint32 maxEntries) =
            abi.decode(a.data, (bool, bool, uint8, bytes32, uint32));

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

        emit ListAttested(a.uid, a.attester, allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries);
        return true;
    }

    // onRevoke is unreachable — LIST is non-revocable. Implemented to satisfy abstract base.
    function onRevoke(Attestation calldata, uint256) internal override returns (bool) {
        return true;
    }
}
