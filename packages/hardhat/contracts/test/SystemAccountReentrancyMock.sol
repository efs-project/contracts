// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    MultiAttestationRequest,
    RevocationRequest,
    RevocationRequestData,
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
///         On any of the three relayed entrypoints (`attest` / `multiAttest` / `revoke`) it calls
///         back into a configured target (the attacker), which re-enters SystemAccount. With the
///         guard in place the re-entry reverts with `ReentrancyGuardReentrantCall`, so the outer
///         call reverts — which is exactly what the test asserts.
///
///         When `reentryTarget` is unset (address(0)) the mock just returns success without any
///         callback, so the same mock can also serve the test's positive control (a single,
///         non-reentrant call through SystemAccount succeeds).
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
        if (reentryTarget != address(0)) {
            IReentrantAttacker(reentryTarget).reenter();
        }
        r = new bytes32[](1);
        r[0] = bytes32(uint256(1));
    }

    function revoke(RevocationRequest calldata) external payable {
        if (reentryTarget != address(0)) {
            IReentrantAttacker(reentryTarget).reenter();
        }
    }

    // ── Unused IEAS surface (kept minimal; SystemAccount only calls the three above) ──
    function getSchemaRegistry() external pure returns (ISchemaRegistry) {
        return ISchemaRegistry(address(0));
    }
}

interface IReentrantAttacker {
    function reenter() external;
}

/// @title SystemAccountReentrancyAttacker
/// @notice An authorized "module" that, when called back during a relayed call, re-enters
///         SystemAccount. Used to prove the `nonReentrant` guard reverts the re-entry.
///         The outer call and the re-entry both target the same entrypoint, selected via `mode`
///         (0 = attest, 1 = multiAttest, 2 = revoke), so the guard is exercised on all three.
contract SystemAccountReentrancyAttacker is IReentrantAttacker {
    ISystemAccountRelay public immutable systemAccount;

    /// Which guarded entrypoint to (re-)enter: 0 = attest, 1 = multiAttest, 2 = revoke.
    uint8 public mode;

    constructor(ISystemAccountRelay sa) {
        systemAccount = sa;
    }

    /// Kick off the first call through the relay (as an authorized module), against the entrypoint
    /// selected by `mode_`. The mock EAS then calls back into `reenter`, which re-enters the same
    /// entrypoint — tripping `nonReentrant`.
    function attack(uint8 mode_) external {
        mode = mode_;
        _call();
    }

    /// Called by ReentrantEAS during the first call; re-enters the relay on the same entrypoint.
    function reenter() external override {
        _call();
    }

    function _call() private {
        if (mode == 0) {
            systemAccount.attest(_attestRequest());
        } else if (mode == 1) {
            systemAccount.multiAttest(_multiAttestRequests());
        } else {
            systemAccount.revoke(_revokeRequest());
        }
    }

    function _attestRequest() private pure returns (AttestationRequest memory) {
        return AttestationRequest({ schema: bytes32(0), data: _attestData() });
    }

    function _multiAttestRequests() private pure returns (MultiAttestationRequest[] memory reqs) {
        AttestationRequestData[] memory data = new AttestationRequestData[](1);
        data[0] = _attestData();
        reqs = new MultiAttestationRequest[](1);
        reqs[0] = MultiAttestationRequest({ schema: bytes32(0), data: data });
    }

    function _revokeRequest() private pure returns (RevocationRequest memory) {
        return
            RevocationRequest({ schema: bytes32(0), data: RevocationRequestData({ uid: bytes32(0), value: 0 }) });
    }

    function _attestData() private pure returns (AttestationRequestData memory) {
        return
            AttestationRequestData({
                recipient: address(0),
                expirationTime: 0,
                revocable: false,
                refUID: bytes32(0),
                data: "",
                value: 0
            });
    }
}

interface ISystemAccountRelay {
    function attest(AttestationRequest calldata request) external returns (bytes32);

    function multiAttest(MultiAttestationRequest[] calldata requests) external returns (bytes32[] memory);

    function revoke(RevocationRequest calldata request) external;
}
