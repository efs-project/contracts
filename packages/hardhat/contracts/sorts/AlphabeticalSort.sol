// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISortFunc } from "../interfaces/ISortFunc.sol";

/// @notice Sorts EFS Anchor attestations lexicographically by their name field.
///         The name is decoded from the Anchor's abi-encoded data: (string name, bytes32 anchorSchema).
contract AlphabeticalSort is ISortFunc {
    IEAS public immutable eas;

    constructor(IEAS _eas) {
        eas = _eas;
    }

    /// @inheritdoc ISortFunc
    /// @dev Returns the UTF-8 bytes of the Anchor's name. Empty bytes for non-Anchor UIDs.
    function getSortKey(bytes32 uid, bytes32 /*sortInfoUID*/) external view returns (bytes memory) {
        Attestation memory att = eas.getAttestation(uid);
        if (att.uid == bytes32(0)) return bytes("");
        (string memory name, ) = abi.decode(att.data, (string, bytes32));
        return bytes(name);
    }

    /// @inheritdoc ISortFunc
    /// @dev Lexicographic byte comparison: a < b iff a's name sorts before b's name.
    function isLessThan(bytes32 a, bytes32 b, bytes32 /*sortInfoUID*/) external view returns (bool) {
        Attestation memory attA = eas.getAttestation(a);
        Attestation memory attB = eas.getAttestation(b);

        if (attA.uid == bytes32(0) || attB.uid == bytes32(0)) return false;

        (string memory nameA, ) = abi.decode(attA.data, (string, bytes32));
        (string memory nameB, ) = abi.decode(attB.data, (string, bytes32));

        return _lexLessThan(bytes(nameA), bytes(nameB));
    }

    function _lexLessThan(bytes memory a, bytes memory b) private pure returns (bool) {
        uint256 minLen = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < minLen; i++) {
            if (a[i] < b[i]) return true;
            if (a[i] > b[i]) return false;
        }
        return a.length < b.length;
    }
}
