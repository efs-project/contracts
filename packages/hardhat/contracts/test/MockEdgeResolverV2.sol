// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EdgeResolver } from "../EdgeResolver.sol";

/// @title MockEdgeResolverV2
/// @notice TEST-ONLY V2 implementation of EdgeResolver for the upgrade-with-state corruption
///         guard (test/UpgradeWithState.test.ts). NOT production.
/// @dev Layout-SAFE additive upgrade: APPENDS a fresh ERC-7201 namespaced struct plus a
///      getter/setter, touching none of the inherited PIN/TAG sequential mappings
///      (`_activeBySlot`, `_activeByAAS`, `_activeEdge`, …), which keep their exact slots.
contract MockEdgeResolverV2 is EdgeResolver {
    /// @custom:storage-location erc7201:efs.edge.v2mock
    struct V2Config {
        uint256 epoch;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.edge.v2mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_SLOT = 0xddbdbc10096923d958b0010c3cbb5d0eddc474d7c4e87902a8ed6bd674dff600;

    function _v2() private pure returns (V2Config storage $) {
        assembly {
            $.slot := V2_SLOT
        }
    }

    constructor(IEAS eas) EdgeResolver(eas) {}

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
