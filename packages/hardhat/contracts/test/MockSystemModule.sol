// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {
    AttestationRequest,
    MultiAttestationRequest,
    RevocationRequest
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/// @notice The minimal slice of SystemAccount's steady-state relay this mock forwards into. Kept as a
///         local interface (not a SystemAccount import) so the mock stays a thin, neutral relay caller.
interface ISystemAccountRelay {
    function attest(AttestationRequest calldata request) external returns (bytes32);

    function multiAttest(MultiAttestationRequest[] calldata requests) external returns (bytes32[] memory);

    function revoke(RevocationRequest calldata request) external;

    function registerAnchor(
        bytes32 parent,
        string calldata name,
        bytes32 anchorSchemaUID,
        bytes32 anchorSchemaToRegister
    ) external returns (bytes32);
}

/// @title MockSystemModule
/// @notice TEST-ONLY authorized "module" for the SystemAccount tests. NOT production.
/// @dev SystemAccount's `setModuleAuthorization` rejects EOAs (`NotAContract`, PR #24 P2) — only a
///      contract may be an authorized writer. The SystemAccount tests therefore can no longer authorize
///      an EOA signer and relay via `connect(eoa)`; they authorize THIS contract's address (a contract →
///      passes the guard) and drive the relay THROUGH it. Each `call*` forwards verbatim, so the EAS
///      attester of everything written stays the SystemAccount address (it CALLs EAS), exactly as a real
///      authorized module would. Holds an immutable reference to the SystemAccount set at construction.
contract MockSystemModule {
    ISystemAccountRelay public immutable systemAccount;

    constructor(ISystemAccountRelay sa) {
        systemAccount = sa;
    }

    function callAttest(AttestationRequest calldata req) external returns (bytes32) {
        return systemAccount.attest(req);
    }

    function callMultiAttest(MultiAttestationRequest[] calldata reqs) external returns (bytes32[] memory) {
        return systemAccount.multiAttest(reqs);
    }

    function callRevoke(RevocationRequest calldata req) external {
        systemAccount.revoke(req);
    }

    function callRegisterAnchor(
        bytes32 parent,
        string calldata name,
        bytes32 anchorSchemaUID,
        bytes32 anchorSchemaToRegister
    ) external returns (bytes32) {
        return systemAccount.registerAnchor(parent, name, anchorSchemaUID, anchorSchemaToRegister);
    }
}
