// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ListEntryResolver } from "../ListEntryResolver.sol";

/// @title MockListEntryResolverV2
/// @notice TEST-ONLY V2 implementation of ListEntryResolver for the upgrade-with-state
///         corruption guard (test/UpgradeWithState.test.ts). NOT production.
/// @dev Layout-SAFE additive upgrade: APPENDS a fresh ERC-7201 namespaced struct plus a
///      getter/setter, touching none of the inherited LIST_ENTRY sequential mappings
///      (`_decl`, `_entries`, `_entryCount`, `_entryPosPlusOne`, `_listAttesters`,
///      `_isListAttester`), which keep their exact slots.
contract MockListEntryResolverV2 is ListEntryResolver {
    /// @custom:storage-location erc7201:efs.listentry.v2mock
    struct V2Config {
        uint256 epoch;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.listentry.v2mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_SLOT = 0xcf2b31fbd54aa46b5bf09330e28adbce28ac5bc194820a0be612e5c59639dd00;

    function _v2() private pure returns (V2Config storage $) {
        assembly {
            $.slot := V2_SLOT
        }
    }

    constructor(IEAS eas) ListEntryResolver(eas) {}

    function setEpoch(uint256 v) external {
        _v2().epoch = v;
    }

    function epoch() external view returns (uint256) {
        return _v2().epoch;
    }

    /// @notice Marker so the test can assert it is talking to V2 through the proxy.
    function mockVersion() external pure returns (uint256) {
        return 2;
    }
}
