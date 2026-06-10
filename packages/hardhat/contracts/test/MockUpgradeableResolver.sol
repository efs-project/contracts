// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EFSUpgradeableResolver } from "../base/EFSUpgradeableResolver.sol";

/// @title MockUpgradeableResolver
/// @notice TEST-ONLY minimal subclass of EFSUpgradeableResolver. Not production.
/// @dev Exercises the base's `_disableInitializers()` lock and a guarded `initialize()`.
///      Carries one simple storage slot to prove proxy init writes through and the impl
///      can never be initialized. Real resolvers use ERC-7201 namespaced storage; this
///      mock stays deliberately trivial.
contract MockUpgradeableResolver is EFSUpgradeableResolver {
    uint256 private _value;

    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    function initialize(uint256 v) external initializer {
        _value = v;
    }

    function value() external view returns (uint256) {
        return _value;
    }

    function onAttest(Attestation calldata, uint256) internal pure override returns (bool) {
        return true;
    }

    function onRevoke(Attestation calldata, uint256) internal pure override returns (bool) {
        return true;
    }
}
