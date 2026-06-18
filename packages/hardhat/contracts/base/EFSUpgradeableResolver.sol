// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title EFSUpgradeableResolver
/// @notice Shared base for EFS EAS schema resolvers deployed behind upgradeable proxies.
/// @dev `_eas` stays an EAS-`SchemaResolver` constructor immutable on purpose: EAS is a
///      per-chain constant, immutables live in implementation bytecode and resolve correctly
///      under the proxy's delegatecall, and EAS invokes resolvers via CALL (not delegatecall)
///      so `onlyEAS` (msg.sender == _eas) holds. EVERY implementation upgrade MUST be deployed
///      with the same EAS address — the deploy/verify gate asserts `getEAS() == expectedEAS`.
///      All EFS-specific per-deployment state (schema UIDs, partner refs) belongs in each
///      subclass's ERC-7201 namespaced storage, set in a guarded `initialize()` — NOT here.
abstract contract EFSUpgradeableResolver is SchemaResolver, Initializable {
    /// @param eas the canonical EAS for the target chain.
    constructor(IEAS eas) SchemaResolver(eas) {
        _disableInitializers(); // the implementation itself can never be initialized (Parity/Wormhole class)
    }

    /// @notice The EAS this resolver was deployed against.
    /// @dev EAS's `SchemaResolver` keeps `_eas` `internal immutable` with no public getter; the
    ///      deploy/verify gate needs to read it to assert `getEAS() == expectedEAS` on every
    ///      implementation upgrade (see contract NatSpec). Exposed here on the shared base so all
    ///      resolvers carry it uniformly. It's an immutable read — no proxy storage involved.
    function getEAS() external view returns (IEAS) {
        return _eas;
    }
}
