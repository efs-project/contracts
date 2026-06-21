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
    // ADR-0055 opaque variant: the opaque marker's refUID MUST be a generic FOLDER anchor
    // (forSchema == bytes32(0)). Suppressing "all lower-lens children" only makes sense on a
    // directory; an opaque marker on a file/key/sort anchor is meaningless and rejected at write time.
    error OpaqueTargetNotFolder();

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
    // Opaque-directory marker (ADR-0055 opaque variant). `dir` is the opaque folder anchor (the
    // attestation's refUID); `attester` is the lens that curated it. `opaqueUID` (the attestation's
    // own UID) is the join key for correlating with native EAS Attested/Revoked logs and for
    // last-writer-wins liveness, so it earns the indexed slot. `dir` is the per-(dir) key an opaque
    // marker is stored under (keyed on (dir) alone — NOT (parent, child) like a per-name whiteout).
    event OpaqueAttested(bytes32 indexed dir, address attester, bytes32 indexed opaqueUID);
    event OpaqueRevoked(bytes32 indexed dir, address attester, bytes32 indexed opaqueUID);

    // ── Constants ───────────────────────────────────────────────────────────────
    // The WHITEOUT field string — FROZEN (ADR-0055) and MUST match the deploy registration exactly
    // (it's hashed into the schema UID). Empty: a pure-identity negative marker (ADR-0049 idiom).
    // Used to self-derive this resolver's own WHITEOUT schema UID so onAttest/onRevoke can reject
    // attestations from any OTHER schema an attacker registers pointing at this resolver (which would
    // otherwise bypass write-time enforcement).
    string private constant WHITEOUT_DEFINITION = "";

    // The WHITEOUT_OPAQUE field string — FROZEN (ADR-0055 opaque variant) once registered; MUST match
    // the deploy registration byte-for-byte (it's hashed into the opaque schema UID). It is NON-empty
    // ("bool opaque") on purpose: an empty string would self-derive the SAME UID as the per-name
    // WHITEOUT (both share this resolver proxy + revocable=true), so the two schemas would collide.
    // "bool opaque" gives a DISTINCT UID and is self-describing — the payload is abi.encode(true),
    // guarded == true at write time (a defensive payload, not a meaningful toggle: there is no
    // "opaque == false" marker — un-opaque is `revoke`, like the per-name marker's un-hide).
    string private constant WHITEOUT_OPAQUE_DEFINITION = "bool opaque";

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
        // ─────────────────────────────────────────────────────────────────────────────────────
        // OPAQUE-DIRECTORY MARKER (ADR-0055 opaque variant) — APPENDED to the ERC-7201 struct
        // (never reorder the fields above; appending preserves every existing storage slot). Same
        // two-structure shape as the per-name marker (append-only discovery list + active marker for
        // O(1) liveness), but keyed on (dir) alone — an opaque marker is NOT per-child, it suppresses
        // ALL lower-lens children of `dir` (including ones added later). `dir` = the opaque folder's
        // OWN anchor (the attestation's refUID).
        //
        // whiteoutOpaqueSchemaUID — self-derived against the PROXY in initialize() (the SECOND
        // self-UID; see WHITEOUT_OPAQUE_DEFINITION). onAttest/onRevoke branch on it.
        bytes32 whiteoutOpaqueSchemaUID;
        // activeOpaque[dir][attester] — the LIVE opaque UID for this (dir, attester) slot, or 0 when
        // none/revoked. The O(1) liveness predicate (`isOpaque` != 0) reads this; cleared on revoke
        // (last-writer-wins). cardinality-1 per (dir, attester).
        mapping(bytes32 dir => mapping(address attester => bytes32 uid)) activeOpaque;
        // opaqueDirs[attester] — append-only discovery list of dirs `attester` ever made opaque (a
        // stale entry — revoked — stays; readers filter on the marker). NEVER pop (ADR-0009).
        mapping(address attester => bytes32[] dirs) opaqueDirs;
        // isOpaqueListed[attester][dir] — append-once membership guard so re-opaquing the same dir by
        // the same attester doesn't double-push the discovery list (idempotent).
        mapping(address attester => mapping(bytes32 dir => bool)) isOpaqueListed;
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
        // address(this) == proxy here (delegatecall) — matches the EAS-registered resolver. BOTH
        // self-UIDs are derived here against the proxy: the per-name WHITEOUT (empty field string) and
        // the OPAQUE-directory marker ("bool opaque"). The two share this resolver + revocable=true, so
        // the distinct field strings are what give them distinct UIDs (see WHITEOUT_OPAQUE_DEFINITION).
        $.whiteoutSchemaUID = keccak256(abi.encodePacked(WHITEOUT_DEFINITION, address(this), true));
        $.whiteoutOpaqueSchemaUID = keccak256(abi.encodePacked(WHITEOUT_OPAQUE_DEFINITION, address(this), true));
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

    /// @notice This resolver's own WHITEOUT_OPAQUE schema UID (ADR-0055 opaque variant), self-derived
    ///         in initialize() against the PROXY address from the "bool opaque" field string. The
    ///         opaque-directory marker schema shares this resolver with the per-name WHITEOUT; the
    ///         distinct field string is what separates their UIDs. The deploy verify gate asserts this
    ///         equals the computed WHITEOUT_OPAQUE UID.
    function whiteoutOpaqueSchemaUID() external view returns (bytes32) {
        return _cfg().whiteoutOpaqueSchemaUID;
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

    /// @notice O(1) liveness predicate: true iff `attester` has an ACTIVE opaque marker on directory
    ///         `dir` (ADR-0055 opaque variant). The listing walk (EFSFileView) and the router's
    ///         per-segment cut call this once per directory page / segment to compute the opaque
    ///         cut-line. A revoked opaque reads false (the marker was cleared); a re-attested one reads
    ///         true under the new UID (last-writer-wins).
    /// @param dir      The opaque folder anchor (an opaque marker's refUID).
    /// @param attester The lens whose opaque marker to read.
    function isOpaque(bytes32 dir, address attester) external view returns (bool) {
        return _cfg().activeOpaque[dir][attester] != bytes32(0);
    }

    /// @notice Length of the append-only opaque-dir discovery list for `attester` — INCLUDING stale
    ///         (revoked) entries (ADR-0009: the list never pops). Co-shaped with
    ///         `getChildrenWhitedOutCount`; readers filter live entries via `isOpaque`.
    function getOpaqueDirsCount(address attester) external view returns (uint256) {
        return _cfg().opaqueDirs[attester].length;
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
        // Branch on the schema (ADR-0055): the per-name WHITEOUT and the opaque-directory marker share
        // this resolver but have distinct UIDs. EAS lets anyone register a NEW schema pointing at this
        // resolver; without this dispatch their attests would skip write-time typing → WrongSchema.
        if (a.schema == $.whiteoutOpaqueSchemaUID) return _onAttestOpaque($, a);
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

    /// @dev Opaque-directory marker write path (ADR-0055 opaque variant). Same lifecycle invariants as
    ///      the per-name marker (revocable, no expiry) PLUS: payload is `abi.encode(true)` (a defensive
    ///      `require true`, not a toggle — un-opaque is `revoke`), and refUID MUST be a generic FOLDER
    ///      anchor (`getAttestation(refUID).schema == ANCHOR` AND its decoded `forSchema == 0`). An
    ///      opaque marker on a file/key/sort anchor is meaningless (OpaqueTargetNotFolder); an opaque
    ///      marker on root IS allowed (suppressing all lower-lens root children is a coherent curation
    ///      act — unlike a per-name whiteout, opaque keys on (dir) alone, so there is no orphan-parent
    ///      problem). Keyed on (dir, attester); last-writer-wins; append-once discovery push.
    function _onAttestOpaque(WhiteoutConfig storage $, Attestation calldata a) private returns (bool) {
        // Payload guard: the "bool opaque" field decodes to exactly one bool, and it MUST be true. A
        // false/garbage payload is not an opaque marker this resolver authored (there is no opaque==false
        // marker; un-opaque is revoke). Reject anything that isn't a clean abi.encode(true).
        if (a.data.length != 32) revert BadPayload();
        bool opaque = abi.decode(a.data, (bool));
        if (!opaque) revert BadPayload();
        // refUID is the opaque directory; an opaque marker with no directory is meaningless.
        if (a.refUID == bytes32(0)) revert ZeroRef();
        // Lifecycle invariants (mirror the per-name path): revoke == un-opaque, no expiry.
        if (!a.revocable) revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();

        // Typing: refUID MUST be a generic FOLDER anchor. First it must be an ANCHOR at all, then its
        // payload's forSchema must be bytes32(0) (the generic-folder discriminant — files/keys/sort
        // anchors carry a non-zero forSchema). Suppressing "all lower children" only means something on
        // a directory.
        Attestation memory refAtt = _eas.getAttestation(a.refUID);
        if (refAtt.schema != $.anchorSchemaUID) revert OpaqueTargetNotFolder();
        // Decode (name, forSchema); a generic folder has forSchema == 0. Guard the decode on non-empty
        // data (EAS permits a zero-length data field on any schema; an unguarded decode would panic).
        bytes32 forSchema = bytes32(0);
        if (refAtt.data.length > 0) {
            (, forSchema) = abi.decode(refAtt.data, (string, bytes32));
        }
        if (forSchema != bytes32(0)) revert OpaqueTargetNotFolder();

        bytes32 dir = a.refUID;
        address attester = a.attester;

        // Append-once discovery push (idempotent re-opaque of the same dir by the same attester).
        if (!$.isOpaqueListed[attester][dir]) {
            $.isOpaqueListed[attester][dir] = true;
            $.opaqueDirs[attester].push(dir);
        }
        // Last-writer-wins liveness marker.
        $.activeOpaque[dir][attester] = a.uid;

        emit OpaqueAttested(dir, attester, a.uid);
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
        // Dispatch on schema (mirror onAttest): the opaque-directory revoke clears its own (dir,
        // attester) marker. Foreign schemas pointed at this resolver are rejected (WrongSchema).
        if (a.schema == $.whiteoutOpaqueSchemaUID) return _onRevokeOpaque($, a);
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

    /// @dev Opaque-directory marker revoke path (ADR-0055 opaque variant). Mirror the per-name revoke:
    ///      guard the payload (`abi.encode(true)` — EAS replays the original attestation's data on
    ///      revoke) + refUID, then clear the live (dir, attester) marker ONLY if it still points at
    ///      THIS uid (last-writer-wins — a newer opaque on the same dir by the same attester may own the
    ///      marker, and revoking the stale one must not wipe it). The append-only discovery list entry
    ///      stays (ADR-0009). Like the per-name path, refUID typing is NOT re-checked — anchors are
    ///      immutable, and the `== a.uid` guard makes any mismatch a harmless no-op.
    function _onRevokeOpaque(WhiteoutConfig storage $, Attestation calldata a) private returns (bool) {
        if (a.data.length != 32) revert BadPayload();
        if (!abi.decode(a.data, (bool))) revert BadPayload();
        if (a.refUID == bytes32(0)) revert ZeroRef();

        bytes32 dir = a.refUID;
        address attester = a.attester;
        if ($.activeOpaque[dir][attester] == a.uid) {
            $.activeOpaque[dir][attester] = bytes32(0);
        }

        emit OpaqueRevoked(dir, attester, a.uid);
        return true;
    }
}
