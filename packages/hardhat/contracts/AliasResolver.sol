// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

/**
 * @title AliasResolver
 * @dev Resolver for the EFS REDIRECT schema (ADR-0050). Write-time enforcement engine for the
 *      trust-scoped "this points at that" primitive: canonical/dedup-resolution for duplicate DATA
 *      (`sameAs`), version supersession (`supersededBy`), and path symlinks (`symlink`).
 *
 *      REDIRECT schema: "bytes32 target, uint16 kind"  (FROZEN, ADR-0050)
 *      revocable: true (a redirect can be retracted; onRevoke returns true).
 *
 *      Field semantics:
 *        refUID = the SOURCE (the duplicate DATA for sameAs/supersededBy; the path Anchor for symlink)
 *        target = the destination DATA or Anchor UID
 *        kind   = redirect class discriminator. uint16 (not uint8) per ADR-0050: kind is an
 *                 open-ended relationship vocabulary, not a counter, and widening is free (both pad
 *                 to one ABI word). The frozen field is the only permanent part; the taxonomy below
 *                 is resolver logic + client convention (versioned/upgradeable), NOT part of the UID:
 *                   0 = sameAs       (strong dedup; source+target both DATA)
 *                   1 = supersededBy (version replacement; source+target both DATA)
 *                   2 = symlink      (path→target; source ANCHOR, target ANCHOR or DATA)
 *                   3+ = reserved    (recorded, NOT type-checked here — the read-time resolution
 *                                     spec decides follow rules for these; e.g. relatedVersion is a
 *                                     never-auto-followed discovery hint)
 *
 *      WRITE-TIME GUARDS ONLY. This resolver enforces direct correctness: target != 0,
 *      target != source (no trivial self-loop), and per-kind typing for the enforced kinds.
 *      It does NOT implement read-time multi-hop resolution — cycle handling (lowest-UID-in-SCC),
 *      chain following, depth caps, lens precedence, and kind-following rules all live in the
 *      client/router + a later Durable resolution spec (ADR-0050 §"Write-time guards vs read-time
 *      resolution"), NOT here. The resolver cannot afford to walk the graph on each write.
 *
 *      Reverse fan-in ("what points at me?") is intentionally NOT indexed on-chain.
 *      // AGENT-NOTE: reverse fan-in is off-chain indexer / future on-chain advisory index (ADR-0050 §4).
 *
 *      Upgradeable (ADR-0048): runs behind an ERC1967 proxy whose ADDRESS is the EAS resolver baked
 *      into the REDIRECT schema UID. Per-deployment config (the self-derived REDIRECT schema UID plus
 *      the DATA and ANCHOR schema UIDs used for typing) lives in ERC-7201 namespaced storage
 *      (`efs.alias.config`), set once via initialize().
 *
 *      CRITICAL self-UID fix (same as ListEntryResolver): the REDIRECT schema UID self-derivation
 *      (keccak256(REDIRECT_DEFINITION, address(this), true)) MUST run in initialize(), where the
 *      proxy's delegatecall makes address(this) == the PROXY (the resolver baked into the schema UID
 *      at EAS registration). Deriving it in the constructor would use the IMPLEMENTATION address,
 *      producing a UID that diverges from the registered one — onAttest/onRevoke would then reject
 *      EVERY genuine REDIRECT with WrongSchema. See initialize() and redirectSchemaUID().
 *
 *      AliasResolver has no deployer/owner-gated functions, so it does NOT inherit OwnableUpgradeable.
 */
contract AliasResolver is EFSUpgradeableResolver {
    // ── Errors ──────────────────────────────────────────────────────────────────
    error WrongSchema();
    error BadPayload();
    error ZeroTarget();
    error SelfLoop();
    error SourceNotData();
    error TargetNotData();
    error SourceNotAnchor();
    error TargetNotAnchorOrData();

    // ── Events ──────────────────────────────────────────────────────────────────
    event RedirectAttested(bytes32 indexed source, bytes32 indexed target, uint16 indexed kind, bytes32 redirectUID);
    event RedirectRevoked(bytes32 indexed source, bytes32 indexed target, uint16 indexed kind, bytes32 redirectUID);

    // ── Constants ───────────────────────────────────────────────────────────────
    uint256 private constant EXPECTED_DATA_LEN = 64; // 32 (target) + 32 (kind padded to a word)

    // Frozen kind discriminators (taxonomy is resolver logic, not part of the UID — see contract NatSpec).
    uint16 private constant KIND_SAME_AS = 0;
    uint16 private constant KIND_SUPERSEDED_BY = 1;
    uint16 private constant KIND_SYMLINK = 2;

    // The REDIRECT field string — FROZEN (ADR-0050) and MUST match the deploy registration exactly
    // (it's hashed into the schema UID). Used to self-derive this resolver's own REDIRECT schema UID
    // so onAttest/onRevoke can reject attestations from any OTHER schema an attacker registers
    // pointing at this resolver (which would otherwise bypass write-time enforcement).
    string constant REDIRECT_DEFINITION = "bytes32 target, uint16 kind";

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    /// @custom:storage-location erc7201:efs.alias.config
    struct AliasConfig {
        bytes32 redirectSchemaUID; // self-derived against the PROXY in initialize()
        bytes32 dataSchemaUID; // typing reference for sameAs / supersededBy / symlink targets
        bytes32 anchorSchemaUID; // typing reference for symlink sources
    }

    // keccak256(abi.encode(uint256(keccak256("efs.alias.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ALIAS_CONFIG_SLOT = 0x4bcf57c6e394e40f159c7ca4a3253d68a725061d0cc276f0372280d7db755700;

    function _cfg() private pure returns (AliasConfig storage $) {
        assembly {
            $.slot := ALIAS_CONFIG_SLOT
        }
    }

    // ── Constructor / initializer ─────────────────────────────────────────────────
    /// @param eas The canonical EAS for the target chain (immutable on the base; see
    ///            EFSUpgradeableResolver NatSpec). The base constructor runs `_disableInitializers()`
    ///            so the implementation itself can never be initialized — only a proxy can.
    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Stores the DATA and ANCHOR
    ///      schema UIDs (used for per-kind typing) and self-derives this resolver's own REDIRECT
    ///      schema UID.
    ///
    ///      The self-UID derivation MUST live here, NOT in the constructor: under the proxy's
    ///      delegatecall `address(this)` is the PROXY, which is the resolver address baked into the
    ///      REDIRECT schema UID at EAS registration. Deriving it in the constructor would use the
    ///      IMPLEMENTATION address, producing a UID that diverges from the registered one — and
    ///      onAttest/onRevoke (which compare `a.schema` against the stored UID) would then reject
    ///      EVERY genuine REDIRECT with WrongSchema. (ADR-0048.)
    /// @param dataSchemaUID_   The DATA schema UID (sameAs/supersededBy require source+target DATA).
    /// @param anchorSchemaUID_ The ANCHOR schema UID (symlink requires source ANCHOR).
    function initialize(bytes32 dataSchemaUID_, bytes32 anchorSchemaUID_) external initializer {
        require(dataSchemaUID_ != bytes32(0), "dataSchemaUID is zero");
        require(anchorSchemaUID_ != bytes32(0), "anchorSchemaUID is zero");
        AliasConfig storage $ = _cfg();
        $.dataSchemaUID = dataSchemaUID_;
        $.anchorSchemaUID = anchorSchemaUID_;
        // address(this) == proxy here (delegatecall) — matches the EAS-registered resolver.
        $.redirectSchemaUID = keccak256(abi.encodePacked(REDIRECT_DEFINITION, address(this), true));
    }

    // ── Getters ───────────────────────────────────────────────────────────────────

    /// @notice This resolver's own REDIRECT schema UID, self-derived in initialize() against the
    ///         PROXY address (keccak256(REDIRECT_DEFINITION, address(this), true)).
    /// @dev EAS UID = keccak256(abi.encodePacked(schemaString, resolver, revocable)); resolver (the
    ///      proxy) and revocable (true) are fixed, so the value is deterministic once the proxy
    ///      address is known. onAttest/onRevoke use this to reject foreign schemas pointed here.
    function redirectSchemaUID() external view returns (bytes32) {
        return _cfg().redirectSchemaUID;
    }

    /// @notice The DATA schema UID used to type-check sameAs/supersededBy endpoints and symlink targets.
    function dataSchemaUID() external view returns (bytes32) {
        return _cfg().dataSchemaUID;
    }

    /// @notice The ANCHOR schema UID used to type-check symlink sources (and accept symlink targets).
    function anchorSchemaUID() external view returns (bytes32) {
        return _cfg().anchorSchemaUID;
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        AliasConfig storage $ = _cfg();
        // Only genuine REDIRECT attestations may pass. EAS lets anyone register a new schema
        // pointing at this resolver; without this guard their attests would skip write-time typing.
        if (a.schema != $.redirectSchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_DATA_LEN) revert BadPayload();

        (bytes32 target, uint16 kind) = abi.decode(a.data, (bytes32, uint16));
        bytes32 source = a.refUID;

        if (target == bytes32(0)) revert ZeroTarget();
        if (target == source) revert SelfLoop(); // no trivial direct self-loop

        if (kind == KIND_SAME_AS || kind == KIND_SUPERSEDED_BY) {
            // Both endpoints must be DATA.
            if (_eas.getAttestation(source).schema != $.dataSchemaUID) revert SourceNotData();
            if (_eas.getAttestation(target).schema != $.dataSchemaUID) revert TargetNotData();
        } else if (kind == KIND_SYMLINK) {
            // Source must be an ANCHOR (a path node); target may be ANCHOR or DATA.
            if (_eas.getAttestation(source).schema != $.anchorSchemaUID) revert SourceNotAnchor();
            bytes32 targetSchema = _eas.getAttestation(target).schema;
            if (targetSchema != $.anchorSchemaUID && targetSchema != $.dataSchemaUID) {
                revert TargetNotAnchorOrData();
            }
        }
        // kind >= 3: reserved — recorded but NOT type-checked here (read-time spec decides follow
        // rules). The target != 0 and target != source guards above still apply.

        emit RedirectAttested(source, target, kind, a.uid);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        // revocable == true: a REDIRECT can always be retracted. Guard the schema for symmetry with
        // onAttest (reject foreign-schema revokes), then accept. No state to unwind — reverse
        // fan-in is off-chain (see contract NatSpec).
        if (a.schema != _cfg().redirectSchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_DATA_LEN) revert BadPayload();
        (bytes32 target, uint16 kind) = abi.decode(a.data, (bytes32, uint16));
        emit RedirectRevoked(a.refUID, target, kind, a.uid);
        return true;
    }
}
