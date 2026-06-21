// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

/// @notice Minimal EFSIndexer read view the WhiteoutResolver needs. It reads ONLY — it never writes
///         kernel state (no `index`/`propagateContains`). `getParent` derives the suppressed child's
///         parent anchor (the per-name whiteout key); `ANCHOR_SCHEMA_UID` types the refUID at write
///         time. Both are pure reads of the append-only kernel.
interface IEFSIndexerForWhiteout {
    function getParent(bytes32 anchorUID) external view returns (bytes32);

    function ANCHOR_SCHEMA_UID() external view returns (bytes32);
}

/**
 * @title WhiteoutResolver
 * @dev Resolver for the EFS WHITEOUT schema (ADR-0055). Write-time enforcement engine + per-parent
 *      discovery index for the cross-lens negative mask (overlayfs whiteout / lens-local delete): a
 *      lens asserts "render this path empty in MY view; stop fall-through to lower lenses" WITHOUT
 *      substituting its own content. The one filesystem primitive additive-only lenses (ADR-0031)
 *      otherwise lack.
 *
 *      WHITEOUT schema: "" (EMPTY — a pure-identity negative marker, same idiom as DATA, ADR-0049).
 *      The assertion is "this source is suppressed in this lens"; it needs no payload — the meaning
 *      is carried entirely by (schema, attester, refUID).
 *      revocable: true (revoke == un-hide; onRevoke returns true).
 *
 *      Field semantics:
 *        refUID = the suppressed source. v1: a path **ANCHOR ONLY** (per-name whiteout). The parent
 *                 is `indexer.getParent(refUID)` and the suppressed child is `refUID` itself, so the
 *                 whiteout keys on `(parent, suppressedChildAnchor)` — NOT definition-scoped (ADR-0055:
 *                 whiteouts are not edges, so they never share EdgeResolver's `(parent, definition)`
 *                 key shape or its storage).
 *
 *      v1 SCOPE (narrows ADR-0055's "ANCHOR or DATA" — the ADR left v1 scope open): refUID MUST be an
 *      ANCHOR. DATA-whiteout and the opaque-directory marker are DEFERRED — additive later (widening
 *      the guard never orphans data). Suppressing a PROPERTY / MIRROR / DATA / another whiteout is
 *      meaningless and rejected at write time (SourceNotAnchor).
 *
 *      WRITE-TIME GUARDS ONLY + a read-side discovery index. This resolver does NOT write kernel
 *      state — it reads `getParent` (ADR-0055: read-side only; the kernel's indices and
 *      weight-neutrality are untouched). Read-time resolution (the negative terminal in the lens
 *      scan; readdir participation) lives in EFSRouter / EFSFileView, NOT here.
 *
 *      Upgradeable (ADR-0048): runs behind an ERC1967 proxy whose ADDRESS is the EAS resolver baked
 *      into the WHITEOUT schema UID. Per-deployment config (the self-derived WHITEOUT schema UID plus
 *      the indexer ref + ANCHOR schema UID used for typing) lives in ERC-7201 namespaced storage
 *      (`efs.whiteout.config`), set once via initialize().
 *
 *      CRITICAL self-UID fix (same as AliasResolver): the WHITEOUT schema UID self-derivation
 *      (keccak256(WHITEOUT_DEFINITION, address(this), true)) MUST run in initialize(), where the
 *      proxy's delegatecall makes address(this) == the PROXY (the resolver baked into the schema UID
 *      at EAS registration). Deriving it in the constructor would use the IMPLEMENTATION address,
 *      producing a UID that diverges from the registered one — onAttest/onRevoke would then reject
 *      EVERY genuine WHITEOUT with WrongSchema. See initialize() and whiteoutSchemaUID().
 *
 *      WhiteoutResolver has no deployer/owner-gated functions, so it does NOT inherit OwnableUpgradeable.
 */
contract WhiteoutResolver is EFSUpgradeableResolver {
    // ── Errors ──────────────────────────────────────────────────────────────────
    error WrongSchema();
    error BadPayload();
    error ZeroRef();
    error NotRevocable();
    error HasExpiration();
    error SourceNotAnchor();
    error OrphanAnchor();

    // ── Events ──────────────────────────────────────────────────────────────────
    // Indexed topics: parent, suppressedChild, whiteoutUID. The attester is left non-indexed
    // (low-cardinality vs the join keys, and always co-filtered with parent/child off the log data).
    // `whiteoutUID` (the attestation's own UID) is the join key for correlating with the native EAS
    // `Attested`/`Revoked` logs and for "was THIS whiteout retracted?" lookups, so it earns the 3rd
    // indexed slot. (EVM caps non-anonymous events at 3 topics.)
    event WhiteoutAttested(
        bytes32 indexed parent,
        bytes32 indexed suppressedChild,
        address attester,
        bytes32 indexed whiteoutUID
    );
    event WhiteoutRevoked(
        bytes32 indexed parent,
        bytes32 indexed suppressedChild,
        address attester,
        bytes32 indexed whiteoutUID
    );

    // ── Constants ───────────────────────────────────────────────────────────────
    // The WHITEOUT field string — FROZEN (ADR-0055) and MUST match the deploy registration exactly
    // (it's hashed into the schema UID). Empty: a pure-identity negative marker (ADR-0049 idiom).
    // Used to self-derive this resolver's own WHITEOUT schema UID so onAttest/onRevoke can reject
    // attestations from any OTHER schema an attacker registers pointing at this resolver (which would
    // otherwise bypass write-time enforcement).
    string private constant WHITEOUT_DEFINITION = "";

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    /// @custom:storage-location erc7201:efs.whiteout.config
    struct WhiteoutConfig {
        bytes32 whiteoutSchemaUID; // self-derived against the PROXY in initialize()
        IEFSIndexerForWhiteout indexer; // read-only kernel ref (getParent + ANCHOR_SCHEMA_UID)
        bytes32 anchorSchemaUID; // typing reference: refUID MUST be an ANCHOR (v1)
        // ─────────────────────────────────────────────────────────────────────────────────────
        // TWO-STRUCTURE STORAGE (mirrors AliasResolver's additive index + EdgeResolver's
        // discovery-list-plus-marker split): an append-only discovery list for paging/readdir, plus
        // an active-marker map for O(1) liveness. The list entry may be STALE (marker cleared to 0
        // after revoke); readers/predicate filter on the marker. NEVER pop the list (ADR-0009).
        //
        // childrenWhitedOut[parent][attester] — append-only discovery list of suppressed child
        // anchors (a per-name whiteout keys on (parent, suppressedChildAnchor); leave room here for
        // a future opaque-directory marker keyed on (parent) alone, ADR-0055 — DEFERRED, not built).
        mapping(bytes32 parent => mapping(address attester => bytes32[] children)) childrenWhitedOut;
        // isChildWhitedOut[parent][attester][child] — append-once membership guard so re-whiteout of
        // the same child by the same attester doesn't double-push the discovery list (idempotent).
        mapping(bytes32 parent => mapping(address attester => mapping(bytes32 child => bool)))
            isChildWhitedOut;
        // activeWhiteout[parent][attester][child] — the LIVE whiteout UID for this slot, or 0 when
        // none/revoked. The O(1) liveness predicate (`isWhitedOut` != 0) reads this; cleared on
        // revoke (last-writer-wins). cardinality-1 per (parent, attester, child).
        mapping(bytes32 parent => mapping(address attester => mapping(bytes32 child => bytes32 uid)))
            activeWhiteout;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.whiteout.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant WHITEOUT_CONFIG_SLOT = 0xa5c53223ecaa41b7a6fdaddbcfa4b4cf6a476f663272302d45b97d6a62ebbb00;

    function _cfg() private pure returns (WhiteoutConfig storage $) {
        assembly {
            $.slot := WHITEOUT_CONFIG_SLOT
        }
    }

    // ── Constructor / initializer ─────────────────────────────────────────────────
    /// @param eas The canonical EAS for the target chain (immutable on the base; see
    ///            EFSUpgradeableResolver NatSpec). The base constructor runs `_disableInitializers()`
    ///            so the implementation itself can never be initialized — only a proxy can.
    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Stores the read-only indexer
    ///      ref, snapshots the ANCHOR schema UID (used to type refUID), and self-derives this
    ///      resolver's own WHITEOUT schema UID.
    ///
    ///      The self-UID derivation MUST live here, NOT in the constructor: under the proxy's
    ///      delegatecall `address(this)` is the PROXY, which is the resolver address baked into the
    ///      WHITEOUT schema UID at EAS registration. Deriving it in the constructor would use the
    ///      IMPLEMENTATION address, producing a UID that diverges from the registered one — and
    ///      onAttest/onRevoke (which compare `a.schema` against the stored UID) would then reject
    ///      EVERY genuine WHITEOUT with WrongSchema. (ADR-0048.)
    /// @param indexer_ The EFSIndexer (proxy) — read-only (getParent + ANCHOR_SCHEMA_UID).
    function initialize(IEFSIndexerForWhiteout indexer_) external initializer {
        require(address(indexer_) != address(0), "indexer is zero");
        WhiteoutConfig storage $ = _cfg();
        $.indexer = indexer_;
        bytes32 anchorUID = indexer_.ANCHOR_SCHEMA_UID();
        require(anchorUID != bytes32(0), "anchorSchemaUID is zero");
        $.anchorSchemaUID = anchorUID;
        // address(this) == proxy here (delegatecall) — matches the EAS-registered resolver.
        $.whiteoutSchemaUID = keccak256(abi.encodePacked(WHITEOUT_DEFINITION, address(this), true));
    }

    // ── Getters ───────────────────────────────────────────────────────────────────

    /// @notice This resolver's own WHITEOUT schema UID, self-derived in initialize() against the
    ///         PROXY address (keccak256(WHITEOUT_DEFINITION, address(this), true)).
    /// @dev EAS UID = keccak256(abi.encodePacked(schemaString, resolver, revocable)); resolver (the
    ///      proxy) and revocable (true) are fixed, so the value is deterministic once the proxy
    ///      address is known. onAttest/onRevoke use this to reject foreign schemas pointed here. The
    ///      deploy verify gate (deploy-lib/verify.ts) asserts this equals the computed WHITEOUT UID.
    function whiteoutSchemaUID() external view returns (bytes32) {
        return _cfg().whiteoutSchemaUID;
    }

    /// @notice The EFSIndexer (proxy) this resolver reads (getParent + ANCHOR_SCHEMA_UID). Read-only.
    function indexer() external view returns (address) {
        return address(_cfg().indexer);
    }

    /// @notice The ANCHOR schema UID used to type-check refUID (v1: refUID MUST be an ANCHOR).
    function anchorSchemaUID() external view returns (bytes32) {
        return _cfg().anchorSchemaUID;
    }

    // ── Read views (co-shaped with EdgeResolver.getChildrenWithEdge) ────────────────────────────

    /// @notice O(1) liveness predicate: true iff `attester` has an ACTIVE whiteout suppressing
    ///         `child` under `parent`. The read-time negative terminal (EFSRouter / EFSFileView) and
    ///         readdir filter call this once per item per lens. A revoked whiteout reads false (the
    ///         marker was cleared); a re-attested one reads true under the new UID.
    /// @param parent   The parent anchor (`indexer.getParent(child)` at attest time).
    /// @param attester The lens whose whiteout to read.
    /// @param child    The suppressed child anchor (the refUID of the whiteout).
    function isWhitedOut(bytes32 parent, address attester, bytes32 child) external view returns (bool) {
        return _cfg().activeWhiteout[parent][attester][child] != bytes32(0);
    }

    /// @notice Paged discovery: child anchors `attester` has an ACTIVE whiteout on under `parent`.
    ///         Walks the append-only list and filters to live markers (a stale entry — revoked — is
    ///         skipped). Co-shaped with `EdgeResolver.getChildrenWithEdge` for readdir participation.
    /// @dev    The slice is taken over the RAW append-only list (so `start`/`length` page the list,
    ///         not the filtered view); revoked entries inside the page are dropped, so the returned
    ///         array may be shorter than `length`. A caller paging the full set walks until
    ///         `start >= getChildrenWhitedOutCount`.
    function getChildrenWhitedOut(
        bytes32 parent,
        address attester,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory) {
        WhiteoutConfig storage $ = _cfg();
        bytes32[] storage all = $.childrenWhitedOut[parent][attester];
        uint256 total = all.length;
        if (total == 0 || start >= total) return new bytes32[](0);
        uint256 end = start + length;
        if (end > total) end = total;

        // First pass: count live entries in the window so the result array is exact-sized.
        uint256 live = 0;
        for (uint256 i = start; i < end; ++i) {
            if ($.activeWhiteout[parent][attester][all[i]] != bytes32(0)) live++;
        }
        bytes32[] memory res = new bytes32[](live);
        uint256 j = 0;
        for (uint256 i = start; i < end; ++i) {
            bytes32 child = all[i];
            if ($.activeWhiteout[parent][attester][child] != bytes32(0)) res[j++] = child;
        }
        return res;
    }

    /// @notice Length of the append-only discovery list for `(parent, attester)` — INCLUDING stale
    ///         (revoked) entries (ADR-0009: the list never pops). Use as the paging bound for
    ///         `getChildrenWhitedOut`; the live count is obtained by filtering the pages.
    function getChildrenWhitedOutCount(bytes32 parent, address attester) external view returns (uint256) {
        return _cfg().childrenWhitedOut[parent][attester].length;
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        WhiteoutConfig storage $ = _cfg();
        // Only genuine WHITEOUT attestations may pass. EAS lets anyone register a new schema pointing
        // at this resolver; without this guard their attests would skip write-time typing.
        if (a.schema != $.whiteoutSchemaUID) revert WrongSchema();
        // Empty field string ⇒ zero-length payload (pure-identity marker). A non-empty data field is
        // not a WHITEOUT this resolver authored.
        if (a.data.length != 0) revert BadPayload();
        // refUID is the suppressed source; a whiteout with no source is meaningless.
        if (a.refUID == bytes32(0)) revert ZeroRef();
        // Lifecycle invariants (ADR-0055) — a WHITEOUT is "active until explicitly revoked" (revoke
        // == un-hide), with no expiry. A revocable *schema* only PERMITS revocable attestations; EAS
        // still accepts revocable=false (the whiteout becomes permanent/uncorrectable — un-hide would
        // be impossible) and nonzero expirationTime (it silently expires while reads filter on
        // revocation, not expiry, leaving a "stuck" hide). Reject both.
        if (!a.revocable) revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();

        // v1 typing: the suppressed source MUST be an ANCHOR (per-name whiteout). DATA/PROPERTY/
        // MIRROR/another-whiteout refUIDs are meaningless to suppress and rejected (ADR-0055).
        if (_eas.getAttestation(a.refUID).schema != $.anchorSchemaUID) revert SourceNotAnchor();

        // Derive the parent (the whiteout key is (parent, suppressedChild)). A root-level anchor has
        // no parent — whiting out root is meaningless (there is no lens below root to suppress at the
        // parent slot), so reject it rather than key a whiteout on parent==0.
        bytes32 parent = $.indexer.getParent(a.refUID);
        if (parent == bytes32(0)) revert OrphanAnchor();

        bytes32 child = a.refUID;
        address attester = a.attester;

        // Append-only discovery push, guarded so re-whiteout of the same child is idempotent (the
        // list never holds a duplicate; ADR-0009 never pops). The activeWhiteout marker below is what
        // carries last-writer-wins liveness even when the list entry already exists.
        if (!$.isChildWhitedOut[parent][attester][child]) {
            $.isChildWhitedOut[parent][attester][child] = true;
            $.childrenWhitedOut[parent][attester].push(child);
        }
        // Last-writer-wins: record THIS attestation as the live whiteout for the slot. A second
        // whiteout from the same attester on the same child overwrites the marker (cardinality-1),
        // and revoking the OLDER UID will then no-op (the marker no longer points at it).
        $.activeWhiteout[parent][attester][child] = a.uid;

        emit WhiteoutAttested(parent, child, attester, a.uid);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        // revocable == true: a WHITEOUT can always be retracted (un-hide). Guard the schema for
        // symmetry with onAttest (reject foreign-schema revokes), then clear the live marker — but
        // ONLY if it still points at THIS whiteout (last-writer-wins, like AliasResolver.onRevoke):
        // a newer whiteout from the same attester on the same child may already own the marker, and
        // revoking the stale older one must not wipe the live newer pointer. The append-only
        // discovery list entry is left in place (ADR-0009 never pops); readers filter on the marker.
        WhiteoutConfig storage $ = _cfg();
        if (a.schema != $.whiteoutSchemaUID) revert WrongSchema();
        if (a.data.length != 0) revert BadPayload();
        if (a.refUID == bytes32(0)) revert ZeroRef();

        // AGENT-NOTE (ADR-0055): onRevoke intentionally does NOT re-validate the refUID's typing
        // (SourceNotAnchor) or re-derive/re-check its parent against the one used at attest time. It is
        // safe to trust `getParent(a.refUID)` here because anchors are NON-revocable and their parent
        // (`refUID` at mint) is IMMUTABLE — so `getParent(a.refUID)` returns the exact same parent it
        // returned in onAttest, and the (parent, attester, child) slot key is stable across the
        // attest→revoke lifetime. Even in the impossible event of a mismatch, the `== a.uid` guard
        // below makes it a harmless no-op: a key that never held this UID simply isn't cleared. Skipping
        // the re-typing keeps revoke (un-hide) cheap and unconditional, matching revocable=true intent.
        bytes32 parent = $.indexer.getParent(a.refUID);
        bytes32 child = a.refUID;
        address attester = a.attester;

        if ($.activeWhiteout[parent][attester][child] == a.uid) {
            $.activeWhiteout[parent][attester][child] = bytes32(0);
        }

        emit WhiteoutRevoked(parent, child, attester, a.uid);
        return true;
    }
}
