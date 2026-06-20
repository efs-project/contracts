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
    error NotRevocable();
    error HasExpiration();

    // ── Events ──────────────────────────────────────────────────────────────────
    // Indexed topics: source, target, redirectUID. `redirectUID` (the attestation's own UID) is the
    // join key for correlating with the native EAS `Attested`/`Revoked` logs and for "was THIS redirect
    // retracted?" lookups, so it earns the 3rd indexed slot. `kind` is a low-cardinality discriminator
    // (0..2 + reserved) that is always co-filtered with source/target, so it is left non-indexed —
    // filtering it off the log data is free for a subgraph. (EVM caps non-anonymous events at 3 topics.)
    event RedirectAttested(bytes32 indexed source, bytes32 indexed target, uint16 kind, bytes32 indexed redirectUID);
    event RedirectRevoked(bytes32 indexed source, bytes32 indexed target, uint16 kind, bytes32 indexed redirectUID);

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
        // ─────────────────────────────────────────────────────────────────────────────────────
        // DRAFT (specs/09-redirect-resolution.md, Proposed — NOT YET RATIFIED). Forward index
        // `source → attester → active redirect UID` backing the additive `getActiveRedirect`
        // reverse-by-source read. Appended to the END of this ERC-7201 namespaced struct ON
        // PURPOSE: under ERC-7201 the whole struct lives at a single hashed base slot isolated
        // from any other layout, and appending a NEW field only consumes previously-unused
        // tail slots in that isolated region — it cannot collide with the three config words
        // above, with the OZ Initializable slot, or with EAS's CALL-invoked storage. This is
        // the canonical upgrade-safe "append-only namespaced storage" pattern (ADR-0048), so it
        // is pre-burn-safe: the PROXY ADDRESS is unchanged and the REDIRECT schema UID
        // (keccak of definition+proxy+revocable) is unchanged — only resolver bytecode + this
        // tail slot change on the implementation upgrade.
        //
        // SPICY: this is NEW STORAGE written on every REDIRECT attest/revoke under a frozen-UID
        // proxy. We store only the redirect's own UID (one word), NOT (target, kind) — EAS stays
        // the source of truth for target/kind/revocation; the read getter re-derives them and
        // re-checks revocation live. "Active" here means "the most recently attested,
        // not-yet-superseded redirect UID for this (source, attester)"; the getter additionally
        // filters revoked at read time so a retracted redirect resolves to empty even before any
        // replacement is written. Last-writer-wins per (source, attester): a newer REDIRECT from
        // the same attester on the same source overwrites the slot (cardinality-1 per attester,
        // mirroring PIN placement, ADR-0031 first-attester-wins is applied by the READER over the
        // lens set, not here).
        mapping(bytes32 source => mapping(address attester => bytes32 redirectUID)) activeRedirectBySource;
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

    // ── DRAFT: reverse-by-source read (specs/09-redirect-resolution.md, Proposed) ──────────────

    /// @notice DRAFT (specs/09-redirect-resolution.md — NOT YET RATIFIED). The single active
    ///         REDIRECT `attester` has authored on `source`, if any. This is the on-chain
    ///         reverse-by-source read that read-time symlink/version followers (e.g.
    ///         `EFSFileView.resolveRedirect`) need: EAS `getAttestation` is keyed by the
    ///         redirect's OWN UID, so without this index there is no way to ask "what does
    ///         attester A's redirect on source X point to?" from on-chain state.
    /// @dev    Lens-scoping (ADR-0031 first-attester-wins) is the READER's job — it calls this
    ///         once per lens attester in precedence order and follows the first hit. This getter
    ///         is single-attester and applies no lens policy.
    ///
    ///         "Active" = the most-recently-attested, not-revoked redirect UID for
    ///         `(source, attester)`. The stored UID is re-checked against EAS live, so a
    ///         retracted (revoked) redirect resolves to `(0, 0, 0)` even before any replacement
    ///         is attested. `target`/`kind` are re-decoded from the live attestation (EAS is the
    ///         source of truth; the index stores only the UID). Returns `(0, 0, 0)` when no
    ///         active redirect exists.
    ///
    ///         Cardinality 1 per `(source, attester)` (last-writer-wins, mirroring PIN
    ///         placement). A walker that wants ALL of an attester's redirects on a source is out
    ///         of scope — the follow rules navigate exactly one redirect per (source, lens) hop.
    /// @param source   The source UID (DATA for sameAs/supersededBy; ANCHOR for symlink).
    /// @param attester The lens attester whose redirect to read.
    /// @return redirectUID The active redirect's own UID, or `bytes32(0)` if none.
    /// @return target      The redirect target, or `bytes32(0)` if none.
    /// @return kind        The redirect kind (0=sameAs, 1=supersededBy, 2=symlink, 3+=reserved),
    ///                     or 0 if none (callers must gate on `redirectUID != 0`, not `kind`).
    function getActiveRedirect(
        bytes32 source,
        address attester
    ) external view returns (bytes32 redirectUID, bytes32 target, uint16 kind) {
        bytes32 uid = _cfg().activeRedirectBySource[source][attester];
        if (uid == bytes32(0)) return (bytes32(0), bytes32(0), 0);
        Attestation memory a = _eas.getAttestation(uid);
        // Re-check live: a revoked redirect (revocationTime != 0) is no longer active, and a
        // slot whose attestation has vanished (defensive) decodes to nothing useful.
        if (a.revocationTime != 0 || a.uid == bytes32(0) || a.data.length != EXPECTED_DATA_LEN) {
            return (bytes32(0), bytes32(0), 0);
        }
        (target, kind) = abi.decode(a.data, (bytes32, uint16));
        return (uid, target, kind);
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        AliasConfig storage $ = _cfg();
        // Only genuine REDIRECT attestations may pass. EAS lets anyone register a new schema
        // pointing at this resolver; without this guard their attests would skip write-time typing.
        if (a.schema != $.redirectSchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_DATA_LEN) revert BadPayload();
        // Lifecycle invariants (ADR-0050) — a REDIRECT is "active until explicitly revoked", with no
        // expiry (matches ListEntryResolver/EdgeResolver/MirrorResolver). A revocable *schema* only
        // PERMITS revocable attestations; EAS still accepts revocable=false (the redirect becomes
        // permanent and uncorrectable) and nonzero expirationTime (it silently expires, but read-time
        // resolution filters on revocation, not expiry, so it stays "active" forever). Reject both.
        if (!a.revocable) revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();

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

        // DRAFT (specs/09-redirect-resolution.md, Proposed): record this as the active redirect for
        // (source, attester). Last-writer-wins per (source, attester) — a newer redirect from the
        // same attester on the same source replaces the slot (cardinality-1, mirrors PIN). The
        // READER applies lens precedence over the set (ADR-0031); this is per-attester only.
        // SPICY: writes namespaced storage under a frozen-UID proxy — see AliasConfig NatSpec.
        $.activeRedirectBySource[source][a.attester] = a.uid;

        emit RedirectAttested(source, target, kind, a.uid);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        // revocable == true: a REDIRECT can always be retracted. Guard the schema for symmetry with
        // onAttest (reject foreign-schema revokes), then accept. No state to unwind — reverse
        // fan-in is off-chain (see contract NatSpec).
        AliasConfig storage $ = _cfg();
        if (a.schema != $.redirectSchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_DATA_LEN) revert BadPayload();
        (bytes32 target, uint16 kind) = abi.decode(a.data, (bytes32, uint16));

        // DRAFT (specs/09-redirect-resolution.md, Proposed): clear the active-redirect slot, but
        // ONLY if it still points at THIS redirect. A newer redirect from the same attester on the
        // same source (last-writer-wins) may already own the slot — revoking the stale older one
        // must not wipe the live newer pointer. (Even without this guard the read getter filters
        // revoked live, so resolution stays correct; this keeps the index tidy and the slot honest.)
        if ($.activeRedirectBySource[a.refUID][a.attester] == a.uid) {
            $.activeRedirectBySource[a.refUID][a.attester] = bytes32(0);
        }

        emit RedirectRevoked(a.refUID, target, kind, a.uid);
        return true;
    }
}
