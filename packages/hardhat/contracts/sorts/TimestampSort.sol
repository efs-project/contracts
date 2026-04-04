// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISortFunc } from "../interfaces/ISortFunc.sol";

/// @notice Sorts attestations by their attestation timestamp, oldest first.
///         Works with any attestation type — the sort key is the uint64 time field.
contract TimestampSort is ISortFunc {
    IEAS public immutable eas;

    constructor(IEAS _eas) {
        eas = _eas;
    }

    /// @inheritdoc ISortFunc
    /// @dev Returns abi.encode(attestation.time) — big-endian uint64, lexicographically comparable.
    function getSortKey(bytes32 uid, bytes32 /*sortInfoUID*/) external view returns (bytes memory) {
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0)) return bytes("");
        return abi.encode(att.time);
    }

    /// @inheritdoc ISortFunc
    /// @dev a < b iff a was attested before b (lower timestamp).
    function isLessThan(bytes32 a, bytes32 b, bytes32 /*sortInfoUID*/) external view returns (bool) {
        Attestation memory attA = eas.getAttestation(a);
        Attestation memory attB = eas.getAttestation(b);
        if (attA.uid == bytes32(0) || attB.uid == bytes32(0)) return false;
        return attA.time < attB.time;
    }
}
