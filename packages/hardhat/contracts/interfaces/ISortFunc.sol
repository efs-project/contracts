// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface ISortFunc {
    /// @notice Returns true if attestation `a` should sort before attestation `b`.
    /// @param sortInfoUID Passed through from the sort overlay — lets one contract
    ///                    handle multiple sort configs. Simple sorts can ignore it.
    function isLessThan(bytes32 a, bytes32 b, bytes32 sortInfoUID) external view returns (bool);

    /// @notice Extract the sort key for a single item.
    /// @param sortInfoUID Same as above — enables config-dependent keys.
    /// @dev The client calls this once per item (N calls), sorts locally by the returned bytes,
    ///      then submits the sorted order to processItems. On-chain isLessThan does O(1) per-item
    ///      validation only.
    ///      Returns empty bytes for ineligible items (client/overlay skips them).
    function getSortKey(bytes32 uid, bytes32 sortInfoUID) external view returns (bytes memory);
}
