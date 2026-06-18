// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, AttestationRequest, AttestationRequestData, MultiAttestationRequest, RevocationRequest } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
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
 *         Owner write authority is confined to the ONE-TIME bootstrap ceremony (ADR-0053, PR
 *         #24 P1 fix). The owner's only powers are:
 *           (a) membership — `setModuleAuthorization` (the pre-burn extensibility seam), and
 *           (b) the one-time `bootstrap(...)` deploy ceremony, gated `onlyOwner` + `whenNotSealed`
 *               and permanently locked by `seal()` at the end of the deploy.
 *         The steady-state general relay (`attest` / `multiAttest` / `revoke` / `registerAnchor`)
 *         is `onlyAuthorizedModule` — NOT owner. After `seal()` the owner (the EFS.eth Safe, a
 *         human multisig) can NOT emit or revoke arbitrary payloads as the permanent `system`
 *         attester. Content authority lives only in authorized module code — humans choose
 *         programs, never payloads.
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
    error BootstrapSealed();

    /// @notice Module-authorization membership has been permanently sealed (PR #24 P1 fix). Thrown by
    ///         `setModuleAuthorization` once `sealModules()` has latched membership closed forever.
    error ModulesSealed();

    /// @notice A reused (idempotent-path) anchor failed shape validation (PR #24 P2 fix): it was not
    ///         authored by THIS contract, or its schema / parent / revocability / expiration / payload
    ///         did not match the canonical ANCHOR this bootstrap would have minted. Rather than seal
    ///         polluted scaffolding, `bootstrap` reverts so a foreign or wrong-shaped anchor is rejected.
    error PollutedAnchor();

    /// @notice Emitted when a module's authorization is set or cleared.
    event ModuleAuthorizationSet(address indexed module, bool authorized);

    /// @notice Emitted once, when the owner permanently seals the bootstrap ceremony. One-way:
    ///         after this, `bootstrap` reverts forever and the owner holds no write authority.
    event BootstrapSealedEvent();

    /// @notice Emitted once, when the owner permanently seals module-authorization membership (PR #24
    ///         P1 fix). One-way: after this, `setModuleAuthorization` reverts forever, so the set of
    ///         contracts that may write through `system` can never change again — making ADR-0053's
    ///         "membership authority is pre-burn only" a contract-enforced fact the burn ceremony
    ///         asserts, not just a documented intent. (Named distinctly from the `ModulesSealed` error,
    ///         which an event of the same name would illegally redeclare.)
    event ModuleAuthorizationSealed();

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
        // One-way bootstrap seal (PR #24 P1 fix). Defaults false; set true once by `seal()` and
        // never reset. After seal, `bootstrap` reverts forever — the owner's one-time deploy-
        // ceremony write authority is permanently locked. Appended after `authorizedModule` so
        // the namespaced storage layout stays backward-compatible (additive, upgrade-safe).
        bool bootstrapSealed;
        // One-way module-authorization seal (PR #24 P1 fix). Defaults false; set true once by
        // `sealModules()` and never reset. After this, `setModuleAuthorization` reverts forever, so
        // membership (which contracts may write as `system`) is frozen — the burn ceremony asserts
        // this to make ADR-0053's "membership authority is pre-burn only" contract-enforced, not just
        // documented. Appended AFTER `bootstrapSealed` (END of the struct) so the namespaced storage
        // layout stays backward-compatible (additive, upgrade-safe — never reorder/insert).
        bool _modulesSealed;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.systemaccount.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SYSTEM_ACCOUNT_CONFIG_SLOT =
        0x078072d5f70991f977efdcbf2ace2d6ea9d920c66e73a9f91ec93f6490635e00;

    function _cfg() private pure returns (SystemAccountConfig storage $) {
        assembly {
            $.slot := SYSTEM_ACCOUNT_CONFIG_SLOT
        }
    }

    /// @dev Steady-state relay gate (PR #24 P1 fix): ONLY an authorized module may author through
    ///      the general relay (`attest` / `multiAttest` / `revoke` / `registerAnchor`). The owner is
    ///      deliberately NOT a writer here — content authority lives only in authorized module code,
    ///      so the owner (the EFS.eth Safe) can never emit or revoke arbitrary payloads as the
    ///      permanent `system` attester (ADR-0053: "humans choose programs, never payloads").
    modifier onlyAuthorizedModule() {
        if (!_cfg().authorizedModule[msg.sender]) revert NotAuthorized();
        _;
    }

    /// @dev Bootstrap-ceremony gate (PR #24 P1 fix): the owner lays the technically-necessary
    ///      scaffolding ONCE, before `seal()`. After seal, this reverts forever — the owner's
    ///      write authority is confined to the one-time deploy ceremony and then permanently locked.
    modifier whenNotSealed() {
        if (_cfg().bootstrapSealed) revert BootstrapSealed();
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

    /// @notice Forward a single attestation to EAS. The EAS attester is this contract. Module-only:
    ///         the owner is not a writer here (PR #24 P1 fix) — content authority is module code.
    function attest(
        AttestationRequest calldata request
    ) external nonReentrant onlyAuthorizedModule returns (bytes32) {
        return _eas.attest(request);
    }

    /// @notice Forward a batch of attestations to EAS. The EAS attester is this contract. Module-only.
    function multiAttest(
        MultiAttestationRequest[] calldata requests
    ) external nonReentrant onlyAuthorizedModule returns (bytes32[] memory) {
        return _eas.multiAttest(requests);
    }

    /// @notice Forward a revocation to EAS. Only attestations whose attester is this contract
    ///         can be revoked through it (EAS enforces attester == revoker). Module-only.
    function revoke(RevocationRequest calldata request) external nonReentrant onlyAuthorizedModule {
        _eas.revoke(request);
    }

    // ============================================================================================
    // TYPED SUGAR — only what the bootstrap uses (ADR-0053: don't gold-plate)
    // ============================================================================================

    /// @notice Build the canonical ANCHOR `AttestationRequest` and forward it, so the anchor's
    ///         attester is this contract. Encodes the ANCHOR data exactly as the deploy bootstrap
    ///         does (`abi.encode(string name, bytes32 forSchema)`), non-revocable, recipient zero,
    ///         refUID = parent. Mirrors orchestrate.ts `ensureAnchor`.
    /// @param parent             the parent anchor UID (ZeroHash for the root anchor).
    /// @param name               the anchor name segment.
    /// @param anchorSchemaUID    the registered ANCHOR schema UID to attest under.
    /// @param anchorSchemaToRegister the ANCHOR `forSchema` data field (a schema-alias anchor's
    ///        target, or ZeroHash for a plain path anchor) — the second ANCHOR field.
    /// @return the new anchor UID.
    function registerAnchor(
        bytes32 parent,
        string calldata name,
        bytes32 anchorSchemaUID,
        bytes32 anchorSchemaToRegister
    ) external nonReentrant onlyAuthorizedModule returns (bytes32) {
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
    /// @param anchorSchemaToRegister the ANCHOR `forSchema` data field (a schema-alias anchor's
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
    ///         Owner-gated + `whenNotSealed` (PR #24 P1 fix): this is the one-time deploy ceremony
    ///         where the owner lays the technically-necessary scaffolding. After `seal()` it reverts
    ///         forever; the steady-state relay is module-only and the owner can never author payloads.
    ///
    /// @param indexer         the EFS index used only to read existing anchors for idempotency.
    /// @param anchorSchemaUID the registered ANCHOR schema UID to attest under.
    /// @param specs           the scaffolding tree in dependency order (parent before child).
    /// @return createdUIDs    the realized UID of each node, parallel to `specs` (reused or new).
    function bootstrap(
        IEFSAnchorIndex indexer,
        bytes32 anchorSchemaUID,
        BootstrapAnchor[] calldata specs
    ) external nonReentrant onlyOwner whenNotSealed returns (bytes32[] memory createdUIDs) {
        createdUIDs = new bytes32[](specs.length);
        for (uint256 i = 0; i < specs.length; i++) {
            BootstrapAnchor calldata spec = specs[i];
            bytes32 parent = spec.parentIndex < 0 ? bytes32(0) : createdUIDs[uint256(spec.parentIndex)];

            // Idempotency: reuse an already-created anchor rather than re-attesting (root re-attest is
            // rejected by EFSIndexer; a child re-attest would mint a duplicate name slot).
            bytes32 existing = spec.parentIndex < 0 ? indexer.rootAnchorUID() : indexer.resolvePath(parent, spec.name);
            if (existing != bytes32(0)) {
                // PR #24 P2 fix: only adopt an existing anchor we can PROVE this contract authored with
                // the exact canonical shape. On the supported-EOA fallback a third party can create a
                // root/scaffolding anchor between ANCHOR registration and bootstrap, and a retry could
                // otherwise inherit a stale/foreign anchor — sealing polluted scaffolding. Verify the
                // full immutable shape (attester, schema, parent, non-revocable, no expiration, exact
                // payload) before reuse; revert PollutedAnchor instead of adopting anything foreign.
                _requireCanonicalAnchor(existing, anchorSchemaUID, parent, spec.name, spec.anchorSchemaToRegister);
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

    /// @notice Assert that an existing anchor UID is one THIS contract authored with the exact
    ///         canonical ANCHOR shape, before the idempotency path adopts it (PR #24 P2 fix). Fetches
    ///         the live EAS record and requires every immutable property to match what `bootstrap`
    ///         would itself have minted for this node:
    ///           - `attester == address(this)` — authored by THIS SystemAccount, not a third party;
    ///           - `schema   == anchorSchemaUID` — the ANCHOR schema this bootstrap registers under;
    ///           - `refUID   == parent` — the realized parent UID (ZeroHash for root);
    ///           - `revocable == false` — ANCHOR is non-revocable (it must never have been revocable);
    ///           - `expirationTime == 0` — anchors never expire;
    ///           - `data == abi.encode(name, anchorSchemaToRegister)` — the exact ANCHOR payload, so a
    ///             same-named-but-wrong-target alias anchor is also rejected.
    ///         Any mismatch reverts `PollutedAnchor` rather than sealing over foreign/wrong scaffolding.
    /// @dev Mirrors the encoding used by `registerAnchor` / `bootstrap` (`abi.encode(string, bytes32)`).
    function _requireCanonicalAnchor(
        bytes32 existing,
        bytes32 anchorSchemaUID,
        bytes32 parent,
        string calldata name,
        bytes32 anchorSchemaToRegister
    ) private view {
        Attestation memory a = _eas.getAttestation(existing);
        if (
            a.attester != address(this) ||
            a.schema != anchorSchemaUID ||
            a.refUID != parent ||
            a.revocable ||
            a.expirationTime != 0 ||
            keccak256(a.data) != keccak256(abi.encode(name, anchorSchemaToRegister))
        ) {
            revert PollutedAnchor();
        }
    }

    // ============================================================================================
    // CONFIG — owner-gated membership authority (the extensibility seam)
    // ============================================================================================

    /// @notice Authorize or de-authorize a module to write through this relay. Owner-only.
    /// @dev Membership/config authority (ADR-0053) — the pre-burn extensibility seam. This is the
    ///      ADR-0053-acknowledged owner power; it does NOT let the owner emit payloads (the authorized
    ///      contract's own code does that). Reverts once `sealModules()` has latched membership closed
    ///      (PR #24 P1 fix): after the seal, the set of `system` writers can never change again, so the
    ///      Safe cannot authorize a new module to write/revoke/register as the permanent `system`
    ///      attester post-burn — making ADR-0053's "membership authority is pre-burn only" a
    ///      contract-enforced invariant the burn ceremony asserts, not merely documented intent.
    function setModuleAuthorization(address module, bool ok) external onlyOwner {
        if (_cfg()._modulesSealed) revert ModulesSealed();
        if (module == address(0)) revert ZeroAddress();
        _cfg().authorizedModule[module] = ok;
        emit ModuleAuthorizationSet(module, ok);
    }

    /// @notice Permanently seal module-authorization membership (PR #24 P1 fix). Owner-only, ONE-WAY:
    ///         once sealed, `setModuleAuthorization` reverts forever and the authorized-module set can
    ///         never change again. The burn ceremony calls this so that after the resolver/proxy burn
    ///         the Safe cannot authorize a new module to write as the permanent `system` attester —
    ///         making ADR-0053's "membership authority is pre-burn only" claim contract-enforced.
    /// @dev Mirrors `seal()`: idempotent (a second call is a harmless no-op, never a revert that would
    ///      strand a deploy/burn batch), and never resettable. Either way the contract stays sealed.
    function sealModules() external onlyOwner {
        SystemAccountConfig storage $ = _cfg();
        if ($._modulesSealed) return; // already sealed — no-op, stays sealed (never resettable)
        $._modulesSealed = true;
        emit ModuleAuthorizationSealed();
    }

    /// @notice Permanently seal the bootstrap ceremony (PR #24 P1 fix). Owner-only, ONE-WAY: once
    ///         sealed, `bootstrap` reverts forever and can never be re-enabled. The deploy calls this
    ///         after the bootstrap scaffolding and before/at ownership transfer, so the owner's
    ///         one-time deploy-ceremony write authority is locked before the EFS.eth Safe holds it.
    /// @dev Idempotent-safe to leave as a revert on a second call (sealing again is meaningless); we
    ///      simply early-return if already sealed so a defensive double-seal in a batch is a no-op,
    ///      never a revert that would strand a deploy batch. Either way the contract stays sealed.
    function seal() external onlyOwner {
        SystemAccountConfig storage $ = _cfg();
        if ($.bootstrapSealed) return; // already sealed — no-op, stays sealed (never resettable)
        $.bootstrapSealed = true;
        emit BootstrapSealedEvent();
    }

    // ============================================================================================
    // VIEWS
    // ============================================================================================

    /// @notice Whether `account` may author through the steady-state relay — i.e. is an authorized
    ///         module. The owner is NOT a relay writer (PR #24 P1 fix); its only write power is the
    ///         one-time `bootstrap` (until `seal()`), which this view deliberately does not report.
    function isAuthorized(address account) external view returns (bool) {
        return _cfg().authorizedModule[account];
    }

    /// @notice Whether the one-time bootstrap ceremony has been permanently sealed. Once true, the
    ///         owner can never author through this contract again (`bootstrap` reverts forever).
    function bootstrapSealed() external view returns (bool) {
        return _cfg().bootstrapSealed;
    }

    /// @notice Whether module-authorization membership has been permanently sealed (PR #24 P1 fix).
    ///         Once true, `setModuleAuthorization` reverts forever — the set of contracts that may
    ///         write as `system` is frozen, so membership is provably pre-burn only (ADR-0053).
    function modulesSealed() external view returns (bool) {
        return _cfg()._modulesSealed;
    }

    /// @notice The EAS this SystemAccount was deployed against.
    function getEAS() external view returns (IEAS) {
        return _eas;
    }
}
