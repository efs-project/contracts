// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, AttestationRequest, AttestationRequestData, MultiAttestationRequest, RevocationRequest } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice The minimal slice of EFSIndexer that `bootstrap` reads for idempotency — the root anchor
///         UID and child path resolution. Kept as a local interface (not an EFSIndexer import) so
///         SystemAccount stays neutral and does not depend on the kernel's full ABI.
interface IEFSAnchorIndex {
    function rootAnchorUID() external view returns (bytes32);

    function resolvePath(bytes32 parentUID, string calldata name) external view returns (bytes32);
}

/**
 * @title SystemAccount
 * @notice The neutral, code-governed system write-identity (ADR-0053). The lens label users
 *         see is `system`. A thin attester *relay*: it forwards `attest` / `multiAttest` /
 *         `revoke` to EAS, so the EAS attester of everything written through it is THIS
 *         contract's address — a deliberate, stable, deterministic author for the canonical
 *         bootstrap structure (root, `/transports/*`) and the tail of the default lens chain.
 *
 * @dev    This is NOT a SchemaResolver. It does not implement `onAttest`/`onRevoke`; it CALLS
 *         `IEAS.attest`/`revoke`. The resolvers still validate every forwarded request — this
 *         contract pins nothing about revocability or payload shape; it forwards whatever it is
 *         handed (ADR-0053: "humans choose programs, never payloads").
 *
 *         Two authorities (ADR-0053):
 *           - Membership authority = WHICH contracts may write through it (`authorizedModule`,
 *             owner-gated via `setModuleAuthorization`).
 *           - Content authority = WHAT each authorized module writes, which lives entirely in
 *             that module's own code. No human can make `SystemAccount` emit a specific payload.
 *
 *         Mirrors the upgradeable pattern used by the resolvers (EFSUpgradeableResolver):
 *         the canonical EAS is a constructor immutable (a per-chain constant; immutables live in
 *         the impl bytecode and resolve correctly under the proxy's delegatecall, and EAS is
 *         called via CALL so the EAS attester is the proxy). `_disableInitializers()` in the
 *         constructor means the implementation itself can never be initialized — only a proxy.
 *         All per-deployment state lives in ERC-7201 namespaced storage set in `initialize()`.
 *
 *         As-if-immutable / burn model: upgradeable pre-burn behind a TransparentUpgradeableProxy
 *         (fix bugs, authorize newly-designed official modules); frozen at burn
 *         (`ProxyAdmin.renounceOwnership`) — the same model as the resolvers (ADR-0030/0048).
 */
contract SystemAccount is Initializable, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    error NotAuthorized();
    error ZeroAddress();

    /// @notice Emitted when a module's authorization is set or cleared.
    event ModuleAuthorizationSet(address indexed module, bool authorized);

    /// @notice The canonical EAS for the target chain. Stays a constructor immutable on purpose:
    ///         EAS is a per-chain constant, immutables live in the implementation bytecode and
    ///         resolve correctly under the proxy's delegatecall, and EAS is invoked via CALL so
    ///         the resulting attester == this proxy. EVERY implementation upgrade MUST be deployed
    ///         with the same EAS address.
    IEAS private immutable _eas;

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    // The authorization mapping lives in its OWN unique namespace so it never collides with
    // Initializable / OwnableUpgradeable / ReentrancyGuardUpgradeable namespaced state.

    /// @custom:storage-location erc7201:efs.systemaccount.config
    struct SystemAccountConfig {
        mapping(address => bool) authorizedModule;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.systemaccount.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SYSTEM_ACCOUNT_CONFIG_SLOT =
        0x078072d5f70991f977efdcbf2ace2d6ea9d920c66e73a9f91ec93f6490635e00;

    function _cfg() private pure returns (SystemAccountConfig storage $) {
        assembly {
            $.slot := SYSTEM_ACCOUNT_CONFIG_SLOT
        }
    }

    /// @dev Owner (the deploy/bootstrap caller; the EFS.eth Safe post-handoff) or any
    ///      authorized module may author through the relay. Owner-may-author lets the deploy
    ///      ceremony write the bootstrap scaffolding through this contract without a separate
    ///      module; modules are authorized peers added later (the extensibility seam).
    modifier onlyAuthorizedModuleOrOwner() {
        if (msg.sender != owner() && !_cfg().authorizedModule[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @param eas the canonical EAS for the target chain.
    constructor(IEAS eas) {
        if (address(eas) == address(0)) revert ZeroAddress();
        _eas = eas;
        _disableInitializers(); // the implementation itself can never be initialized
    }

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Sets the owner (the
    ///      deployer during the ceremony; transferred to the Safe alongside the resolvers).
    /// @param owner_ the address authorized for config + authoring during the ceremony.
    function initialize(address owner_) external initializer {
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
    }

    // ============================================================================================
    // ATTESTER RELAY — forward to EAS so the attester == this contract
    // ============================================================================================

    /// @notice Forward a single attestation to EAS. The EAS attester is this contract.
    function attest(
        AttestationRequest calldata request
    ) external nonReentrant onlyAuthorizedModuleOrOwner returns (bytes32) {
        return _eas.attest(request);
    }

    /// @notice Forward a batch of attestations to EAS. The EAS attester is this contract.
    function multiAttest(
        MultiAttestationRequest[] calldata requests
    ) external nonReentrant onlyAuthorizedModuleOrOwner returns (bytes32[] memory) {
        return _eas.multiAttest(requests);
    }

    /// @notice Forward a revocation to EAS. Only attestations whose attester is this contract
    ///         can be revoked through it (EAS enforces attester == revoker).
    function revoke(RevocationRequest calldata request) external nonReentrant onlyAuthorizedModuleOrOwner {
        _eas.revoke(request);
    }

    // ============================================================================================
    // TYPED SUGAR — only what the bootstrap uses (ADR-0053: don't gold-plate)
    // ============================================================================================

    /// @notice Build the canonical ANCHOR `AttestationRequest` and forward it, so the anchor's
    ///         attester is this contract. Encodes the ANCHOR data exactly as the deploy bootstrap
    ///         does (`abi.encode(string name, bytes32 schemaUID)`), non-revocable, recipient zero,
    ///         refUID = parent. Mirrors orchestrate.ts `ensureAnchor`.
    /// @param parent             the parent anchor UID (ZeroHash for the root anchor).
    /// @param name               the anchor name segment.
    /// @param anchorSchemaUID    the registered ANCHOR schema UID to attest under.
    /// @param anchorSchemaToRegister the ANCHOR `schemaUID` data field (a schema-alias anchor's
    ///        target, or ZeroHash for a plain path anchor) — the second ANCHOR field.
    /// @return the new anchor UID.
    function registerAnchor(
        bytes32 parent,
        string calldata name,
        bytes32 anchorSchemaUID,
        bytes32 anchorSchemaToRegister
    ) external nonReentrant onlyAuthorizedModuleOrOwner returns (bytes32) {
        return
            _eas.attest(
                AttestationRequest({
                    schema: anchorSchemaUID,
                    data: AttestationRequestData({
                        recipient: address(0),
                        expirationTime: 0,
                        revocable: false,
                        refUID: parent,
                        data: abi.encode(name, anchorSchemaToRegister),
                        value: 0
                    })
                })
            );
    }

    // ============================================================================================
    // BOOTSTRAP — author the whole scaffolding tree in ONE call (timestamp-robust)
    // ============================================================================================

    /// @notice One node of the bootstrap scaffolding tree.
    /// @param name               the anchor name segment.
    /// @param parentIndex        index into the SAME specs array of this node's parent; a negative
    ///                           value (sentinel) marks the root (refUID = ZeroHash). A child MUST
    ///                           appear after its parent so the parent's UID is already realized.
    /// @param anchorSchemaToRegister the ANCHOR `schemaUID` data field (a schema-alias anchor's
    ///                           target, or ZeroHash for a plain path anchor) — the second ANCHOR field.
    struct BootstrapAnchor {
        string name;
        int256 parentIndex;
        bytes32 anchorSchemaToRegister;
    }

    /// @notice Author the entire bootstrap scaffolding tree (root → children) in a SINGLE call,
    ///         threading the REAL EAS-returned UIDs in memory: each child's `refUID` is the parent
    ///         UID that the prior `EAS.attest` in this same call returned. This is timestamp-robust
    ///         by construction — EAS folds `block.timestamp` into every UID, but since the parent UID
    ///         is read back from EAS (never predicted off-chain), the child always references the
    ///         parent that actually exists, whatever timestamp the mined block carried. There is no
    ///         off-chain UID precompute to drift against.
    ///
    /// @dev    Idempotent (ADR-0028 retry-safety): before attesting each node it checks the index —
    ///         the root via `indexer.rootAnchorUID()`, children via `indexer.resolvePath(parent, name)`
    ///         — and REUSES an already-created anchor instead of re-attesting (re-attesting root after
    ///         it exists is rejected by EFSIndexer; re-attesting a child would mint a duplicate). So a
    ///         partial-then-retried bootstrap fills only the gaps and a fully-seeded retry is a
    ///         zero-write no-op. Authored THROUGH this contract (attester == SystemAccount).
    ///
    /// @param indexer         the EFS index used only to read existing anchors for idempotency.
    /// @param anchorSchemaUID the registered ANCHOR schema UID to attest under.
    /// @param specs           the scaffolding tree in dependency order (parent before child).
    /// @return createdUIDs    the realized UID of each node, parallel to `specs` (reused or new).
    function bootstrap(
        IEFSAnchorIndex indexer,
        bytes32 anchorSchemaUID,
        BootstrapAnchor[] calldata specs
    ) external nonReentrant onlyAuthorizedModuleOrOwner returns (bytes32[] memory createdUIDs) {
        createdUIDs = new bytes32[](specs.length);
        for (uint256 i = 0; i < specs.length; i++) {
            BootstrapAnchor calldata spec = specs[i];
            bytes32 parent = spec.parentIndex < 0 ? bytes32(0) : createdUIDs[uint256(spec.parentIndex)];

            // Idempotency: reuse an already-created anchor rather than re-attesting (root re-attest is
            // rejected by EFSIndexer; a child re-attest would mint a duplicate name slot).
            bytes32 existing = spec.parentIndex < 0 ? indexer.rootAnchorUID() : indexer.resolvePath(parent, spec.name);
            if (existing != bytes32(0)) {
                createdUIDs[i] = existing;
                continue;
            }

            createdUIDs[i] = _eas.attest(
                AttestationRequest({
                    schema: anchorSchemaUID,
                    data: AttestationRequestData({
                        recipient: address(0),
                        expirationTime: 0,
                        revocable: false,
                        refUID: parent,
                        data: abi.encode(spec.name, spec.anchorSchemaToRegister),
                        value: 0
                    })
                })
            );
        }
    }

    // ============================================================================================
    // CONFIG — owner-gated membership authority (the extensibility seam)
    // ============================================================================================

    /// @notice Authorize or de-authorize a module to write through this relay. Owner-only.
    function setModuleAuthorization(address module, bool ok) external onlyOwner {
        if (module == address(0)) revert ZeroAddress();
        _cfg().authorizedModule[module] = ok;
        emit ModuleAuthorizationSet(module, ok);
    }

    // ============================================================================================
    // VIEWS
    // ============================================================================================

    /// @notice Whether `account` may author through this relay (an authorized module or the owner).
    function isAuthorized(address account) external view returns (bool) {
        return account == owner() || _cfg().authorizedModule[account];
    }

    /// @notice The EAS this SystemAccount was deployed against.
    function getEAS() external view returns (IEAS) {
        return _eas;
    }
}
