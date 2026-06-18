// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ICreateX — minimal interface for the canonical CreateX factory.
/// @notice Vendored subset of pcaversaccio/createx (https://github.com/pcaversaccio/createx).
///         CreateX is deployed at the canonical address
///         `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` on every chain it supports (confirmed live
///         on Sepolia + mainnet). EFS uses it for CREATE3-deterministic resolver-proxy addresses so
///         the Sepolia structure IS the mainnet structure (same salt + same deployer EOA ⇒ same
///         proxy address ⇒ same schema UIDs). See docs/DEPLOYMENT.md §1-3, ADR-0048.
///
///         Only the four members EFS calls are declared. We vendor the interface (rather than add a
///         dependency) so the TS deploy lib can encode/decode calldata against a stable ABI and so a
///         resolver/test can reference it directly.
///
/// @dev Salt-guarding (CreateX `_guard`): if the salt's leading 20 bytes equal `msg.sender` and byte
///      20 is `0x00` (no cross-chain redeploy protection — what EFS uses, so the address depends only
///      on (deployer, salt) and is identical Sepolia↔mainnet for the same EOA), the EFFECTIVE
///      ("guarded") salt CreateX derives the address from is
///      `keccak256(abi.encodePacked(bytes32(uint256(uint160(msg.sender))), salt))`. Therefore
///      `computeCreate3Address(guardedSalt)` (the no-deployer overload, which computes the raw CREATE3
///      address from a salt assuming this factory as the deployer) must be passed the GUARDED salt,
///      while `deployCreate3` must be passed the RAW salt. The TS lib computes the guarded salt
///      off-chain to predict, then submits the raw salt to deploy, and asserts realized == predicted.
interface ICreateX {
    struct Values {
        uint256 constructorAmount;
        uint256 initCallAmount;
    }

    /// @notice Deploy `initCode` via CREATE3 at a `salt`-derived address.
    function deployCreate3(bytes32 salt, bytes memory initCode) external payable returns (address newContract);

    /// @notice Deploy `initCode` via CREATE3 then call it with `data` (atomic deploy+init).
    function deployCreate3AndInit(
        bytes32 salt,
        bytes memory initCode,
        bytes memory data,
        Values memory values,
        address refundAddress
    ) external payable returns (address newContract);

    /// @notice Compute the CREATE3 address for a (already-guarded) salt, assuming this factory deploys.
    function computeCreate3Address(bytes32 salt) external view returns (address computedAddress);
}
