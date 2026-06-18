// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EFSIndexer } from "../EFSIndexer.sol";

/// @title MockEFSIndexerV2
/// @notice TEST-ONLY V2 implementation of EFSIndexer for the upgrade-with-state corruption
///         guard (test/UpgradeWithState.test.ts). NOT production.
/// @dev Models a realistic, layout-SAFE implementation upgrade: it APPENDS a brand-new
///      ERC-7201 namespaced storage struct (its own unique namespace, far from slot 0 and
///      from every existing namespace) plus a trivial getter/setter. It touches NONE of the
///      inherited consensus-critical sequential mappings (`_children`, `_nameToAnchor`,
///      `_parents`, …) — those keep their exact slots. This proves additive storage is safe
///      and that an impl swap preserves all prior kernel state.
contract MockEFSIndexerV2 is EFSIndexer {
    /// @custom:storage-location erc7201:efs.indexer.v2mock
    struct V2Config {
        uint256 epoch;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.indexer.v2mock")) - 1)) & ~bytes32(uint256(0xff))
    // A fresh namespace that cannot collide with efs.indexer.config or the sequential mapping layout.
    bytes32 private constant V2_SLOT = 0xdc076dae0346aacc73595cc257556e2cb3e10dc12ce486503c5e2857f67eb100;

    function _v2() private pure returns (V2Config storage $) {
        assembly {
            $.slot := V2_SLOT
        }
    }

    constructor(IEAS eas) EFSIndexer(eas) {}

    /// @notice V2-only appended state. Setter + getter prove the new slot is live post-upgrade
    ///         and that it does not disturb any V1 storage.
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
