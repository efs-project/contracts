// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    MultiAttestationRequest,
    RevocationRequest,
    DelegatedAttestationRequest,
    MultiDelegatedAttestationRequest,
    DelegatedRevocationRequest,
    MultiDelegatedRevocationRequest,
    MultiRevocationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { ISchemaRegistry } from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";
import { Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

/// @title ReentrantEAS
/// @notice A minimal mock EAS used ONLY to prove SystemAccount's `nonReentrant` guard holds.
///         On `attest`, it calls back into a configured target (the attacker), which re-enters
///         `SystemAccount.attest`. With the guard in place the re-entry reverts, so the outer
///         attest reverts — which is exactly what the test asserts.
contract ReentrantEAS {
    address public reentryTarget;

    function setReentryTarget(address t) external {
        reentryTarget = t;
    }

    function attest(AttestationRequest calldata) external payable returns (bytes32) {
        if (reentryTarget != address(0)) {
            // Re-enter SystemAccount through the attacker; this MUST revert under nonReentrant.
            IReentrantAttacker(reentryTarget).reenter();
        }
        return bytes32(uint256(1));
    }

    function multiAttest(MultiAttestationRequest[] calldata) external payable returns (bytes32[] memory r) {
        r = new bytes32[](1);
        r[0] = bytes32(uint256(1));
    }

    function revoke(RevocationRequest calldata) external payable {}

    // ── Unused IEAS surface (kept minimal; SystemAccount only calls the three above) ──
    function getSchemaRegistry() external pure returns (ISchemaRegistry) {
        return ISchemaRegistry(address(0));
    }
}

interface IReentrantAttacker {
    function reenter() external;
}

/// @title SystemAccountReentrancyAttacker
/// @notice An authorized "module" that, when called back during an attest, re-enters
///         `SystemAccount.attest`. Used to prove the `nonReentrant` guard reverts the re-entry.
contract SystemAccountReentrancyAttacker is IReentrantAttacker {
    ISystemAccountAttest public immutable systemAccount;

    constructor(ISystemAccountAttest sa) {
        systemAccount = sa;
    }

    /// Kick off the first attest through the relay (as an authorized module).
    function attack() external returns (bytes32) {
        return systemAccount.attest(_emptyRequest());
    }

    /// Called by ReentrantEAS during the first attest; re-enters the relay.
    function reenter() external override {
        systemAccount.attest(_emptyRequest());
    }

    function _emptyRequest() private pure returns (AttestationRequest memory) {
        return
            AttestationRequest({
                schema: bytes32(0),
                data: AttestationRequestData({
                    recipient: address(0),
                    expirationTime: 0,
                    revocable: false,
                    refUID: bytes32(0),
                    data: "",
                    value: 0
                })
            });
    }
}

interface ISystemAccountAttest {
    function attest(AttestationRequest calldata request) external returns (bytes32);
}
