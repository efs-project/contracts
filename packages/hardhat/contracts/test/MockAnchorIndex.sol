// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title MockAnchorIndex
 * @notice Minimal stand-in for the slice of EFSIndexer that SystemAccount.bootstrap reads for
 *         idempotency (`rootAnchorUID()` + `resolvePath(parent, name)`). Test-only. Lets the
 *         bootstrap unit test exercise the "nothing exists yet → attest all" path and the
 *         "already-created → reuse" path without standing up a full wired EFSIndexer + EAS resolver.
 *
 * @dev    Existence is keyed by `keccak256(parent, name)` for children and a dedicated `_root` slot
 *         for the root. The test seeds entries to simulate a prior (partial) bootstrap.
 */
contract MockAnchorIndex {
    bytes32 private _root;
    mapping(bytes32 => bytes32) private _byPath;

    function setRoot(bytes32 uid) external {
        _root = uid;
    }

    function setPath(bytes32 parent, string calldata name, bytes32 uid) external {
        _byPath[keccak256(abi.encode(parent, name))] = uid;
    }

    function rootAnchorUID() external view returns (bytes32) {
        return _root;
    }

    function resolvePath(bytes32 parentUID, string calldata name) external view returns (bytes32) {
        return _byPath[keccak256(abi.encode(parentUID, name))];
    }
}
