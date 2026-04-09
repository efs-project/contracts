// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISortFunc } from "../interfaces/ISortFunc.sol";

/// @notice Sorts attestations by their attestation timestamp, oldest first.
///         Works with any attestation type — the sort key is the uint64 time field.
///
///         Tie-breaking: when two attestations have the same timestamp, the itemUID breaks
///         the tie. Sort key = abi.encodePacked(uint256(time), uid) — 64 bytes total.
///         Using uint256 (left-padded to 32 bytes) ensures JS lexicographic string comparison
///         of hex-encoded keys ("0x1a2b...") matches the on-chain byte-by-byte ordering.
contract TimestampSort is ISortFunc {
    IEAS public immutable eas;

    constructor(IEAS _eas) {
        eas = _eas;
    }

    /// @inheritdoc ISortFunc
    /// @dev Returns abi.encodePacked(uint256(att.time), uid) — 64 bytes, deterministic.
    ///      Empty bytes for non-existent UIDs (makes them ineligible for this sort).
    function getSortKey(bytes32 uid, bytes32 /*sortInfoUID*/) external view returns (bytes memory) {
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0)) return bytes("");
        // uint256 left-pads the uint64 timestamp to 32 bytes — JS hex comparison works correctly.
        return abi.encodePacked(uint256(att.time), uid);
    }

    /// @inheritdoc ISortFunc
    /// @dev a < b iff a was attested before b. Equal timestamps break tie by itemUID.
    ///      Consistent with getSortKey lexicographic ordering.
    function isLessThan(bytes32 a, bytes32 b, bytes32 /*sortInfoUID*/) external view returns (bool) {
        Attestation memory attA = eas.getAttestation(a);
        Attestation memory attB = eas.getAttestation(b);
        if (attA.uid == bytes32(0) || attB.uid == bytes32(0)) return false;
        if (attA.time != attB.time) return attA.time < attB.time;
        // Same timestamp — break tie by itemUID (deterministic, globally unique)
        return a < b;
    }
}
