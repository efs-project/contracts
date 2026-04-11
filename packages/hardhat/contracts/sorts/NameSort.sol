// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISortFunc } from "../interfaces/ISortFunc.sol";

/// @notice Sorts EFS Anchor attestations by their name field using ASCII byte comparison.
///         Honest name: this is ASCII/UTF-8 byte ordering, not locale-aware alphabetical sorting.
///         The name is decoded from the Anchor's abi-encoded data: (string name, bytes32 anchorSchema).
///
///         Tie-breaking: when two anchors have the same name, the itemUID breaks the tie.
///         Sort key = abi.encodePacked(bytes(name), uid), ensuring globally unique keys and
///         deterministic ordering that matches client-side JS lexicographic comparison.
contract NameSort is ISortFunc {
    IEAS public immutable eas;

    constructor(IEAS _eas) {
        eas = _eas;
    }

    /// @inheritdoc ISortFunc
    /// @dev Returns abi.encodePacked(bytes(name), bytes1(0x00), uid) for deterministic tie-breaking.
    ///      The null byte (0x00) acts as a length terminator between the variable-length name and
    ///      the fixed 32-byte uid. This ensures that raw byte comparison of sort keys is consistent
    ///      with isLessThan name comparison: if name A is a prefix of name B, then
    ///      sortKey(A) < sortKey(B) lexicographically regardless of uid values (since 0x00 <
    ///      any printable ASCII character). Names must not contain null bytes (standard constraint
    ///      for EFS anchor names).
    ///      Empty bytes for non-Anchor UIDs (makes them ineligible for this sort).
    function getSortKey(bytes32 uid, bytes32 /*sortInfoUID*/) external view returns (bytes memory) {
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0)) return bytes("");
        (string memory name, ) = abi.decode(att.data, (string, bytes32));
        if (bytes(name).length == 0) return bytes("");
        return abi.encodePacked(bytes(name), bytes1(0x00), uid);
    }

    /// @inheritdoc ISortFunc
    /// @dev Lexicographic byte comparison with uid tie-breaking.
    ///      Consistent with getSortKey: a < b iff getSortKey(a) < getSortKey(b) lexicographically.
    function isLessThan(bytes32 a, bytes32 b, bytes32 /*sortInfoUID*/) external view returns (bool) {
        Attestation memory attA = eas.getAttestation(a);
        Attestation memory attB = eas.getAttestation(b);

        if (attA.uid == bytes32(0) || attB.uid == bytes32(0)) return false;

        (string memory nameA, ) = abi.decode(attA.data, (string, bytes32));
        (string memory nameB, ) = abi.decode(attB.data, (string, bytes32));

        bytes memory bytesA = bytes(nameA);
        bytes memory bytesB = bytes(nameB);

        uint256 minLen = bytesA.length < bytesB.length ? bytesA.length : bytesB.length;
        for (uint256 i = 0; i < minLen; i++) {
            if (bytesA[i] < bytesB[i]) return true;
            if (bytesA[i] > bytesB[i]) return false;
        }
        if (bytesA.length != bytesB.length) return bytesA.length < bytesB.length;

        // Names are equal — break tie by itemUID (deterministic, globally unique)
        return a < b;
    }
}
