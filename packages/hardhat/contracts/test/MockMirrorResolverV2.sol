// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { MirrorResolver } from "../MirrorResolver.sol";

/// @title MockMirrorResolverV2
/// @notice TEST-ONLY V2 implementation of MirrorResolver for the upgrade-with-state corruption
///         guard (test/MirrorResolverUpgrade.test.ts) and the storage-layout gate
///         (test/StorageLayout.gate.test.ts). NOT production.
/// @dev Layout-SAFE additive upgrade: APPENDS a fresh ERC-7201 namespaced struct plus a
///      getter/setter, touching neither the inherited sequential `transportsAnchorUID` (slot 0)
///      nor the `efs.mirror.config` namespaced config — both keep their exact slots.
contract MockMirrorResolverV2 is MirrorResolver {
    /// @custom:storage-location erc7201:efs.mirror.v2mock
    struct V2Config {
        uint256 epoch;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.mirror.v2mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_SLOT = 0x42631bd3084c9094c1218f48908c45e03606ff673f63f27b6d64d85465df3800;

    function _v2() private pure returns (V2Config storage $) {
        assembly {
            $.slot := V2_SLOT
        }
    }

    constructor(IEAS eas) MirrorResolver(eas) {}

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
