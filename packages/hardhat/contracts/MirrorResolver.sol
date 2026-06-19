// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

/// @dev Minimal interface for the EFSIndexer functions MirrorResolver needs.
interface IEFSIndexerForMirror {
    function index(bytes32 uid) external returns (bool);
    function indexRevocation(bytes32 uid) external;
    function MIRROR_SCHEMA_UID() external view returns (bytes32);
    function DATA_SCHEMA_UID() external view returns (bytes32);
    function ANCHOR_SCHEMA_UID() external view returns (bytes32);
    function getParent(bytes32 anchorUID) external view returns (bytes32);
}

/**
 * @title MirrorResolver
 * @dev SchemaResolver for the EFS Mirror schema. Validates that:
 *      1. refUID points to a valid DATA attestation
 *      2. transportDefinition points to a valid Anchor (e.g. /transports/ipfs)
 *
 *      Mirror schema: "bytes32 transportDefinition, string uri"
 *        - transportDefinition: Anchor UID for the transport type
 *        - uri: retrieval URI (ipfs://QmXxx, ar://yyy, web3://0xABC, etc.)
 *
 *      No singleton enforcement — multiple mirrors per transport type are allowed.
 *
 *      Upgradeable (ADR-0048): runs behind an ERC1967 proxy whose ADDRESS is the EAS
 *      resolver baked into the MIRROR schema UID. The former `indexer` constructor
 *      immutable moved into ERC-7201 namespaced storage (`efs.mirror.config`) set once
 *      via initialize(); the former `_deployer` immutable is replaced by OwnableUpgradeable
 *      (the owner authorizes setTransportsAnchor()). `transportsAnchorUID` keeps its
 *      sequential slot (slot 0) — Initializable/Ownable state lives in namespaced storage.
 */
contract MirrorResolver is EFSUpgradeableResolver, OwnableUpgradeable {
    error InvalidData();
    error WrongSchema();
    error InvalidTransport();
    error URITooLong();
    error NotRevocable();
    error HasExpiration();
    /// @dev MIRROR payload decodes but is not the exact canonical `abi.encode(bytes32, string)` — e.g.
    ///      extra trailing bytes. abi.decode tolerates a canonical prefix with trailing words, so two
    ///      byte-different payloads would decode to the SAME (transportDefinition, uri) and mint two
    ///      mirrors under distinct permanent UIDs, while an SDK/subgraph reconstructing the UID from the
    ///      decoded fields sees only one. The dynamic `string uri` rules out a fixed-length check, so we
    ///      re-encode the decoded fields and hash-compare (the SystemAccount._requireCanonicalAnchor
    ///      pattern). Reject anything that does not round-trip.
    error NonCanonicalPayload();

    // ── Mirror events (subgraph indexability, PR #24) ───────────────────────────────────────────
    // The kernel's generic MirrorCreated(dataUID, mirrorUID, attester) omits the URI — the whole point
    // of a MIRROR — because EFSIndexer.index() never decodes the mirror payload. The resolver does, so
    // it emits the URI-bearing event here. Indexed: (dataUID, attester, transportDefinition) — the
    // lens-scoped, transport-rankable key the router's mirror selection uses.
    event MirrorSet(
        bytes32 indexed dataUID,
        address indexed attester,
        bytes32 indexed transportDefinition,
        bytes32 mirrorUID,
        string uri
    );
    // Carries `transportDefinition` indexed so it presents the SAME (dataUID, attester,
    // transportDefinition) key as MirrorSet — a log-only indexer can retire the exact transport slot
    // without an eth_call to recover it from the mirrorUID.
    event MirrorCleared(
        bytes32 indexed dataUID,
        address indexed attester,
        bytes32 indexed transportDefinition,
        bytes32 mirrorUID
    );

    /// @notice Maximum allowed byte length for a MIRROR URI.
    uint256 public constant MAX_URI_LENGTH = 8192;

    /// @notice Maximum depth when walking ancestors to find /transports/.
    uint256 private constant MAX_TRANSPORT_DEPTH = 8;

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    // `indexer` was a constructor immutable when MirrorResolver was deployed directly. Under the
    // upgradeable-proxy pattern (ADR-0048) the implementation runs via the proxy's delegatecall,
    // so immutables (which live in the impl's bytecode) would read the impl's construction-time
    // value, not the proxy's. The partner reference therefore moves into ERC-7201 namespaced
    // storage written once in initialize(). Its OWN unique namespace (NOT efs.indexer.config).

    /// @custom:storage-location erc7201:efs.mirror.config
    struct MirrorConfig {
        IEFSIndexerForMirror indexer;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.mirror.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant MIRROR_CONFIG_SLOT = 0x3f72924bb6e35e0588c2971086d9c6a0d31d2c8b5992f0e713fd93fab2407a00;

    function _cfg() private pure returns (MirrorConfig storage $) {
        assembly {
            $.slot := MIRROR_CONFIG_SLOT
        }
    }

    /// @notice The EFSIndexer this resolver registers mirrors into. Preserved by NAME for
    ///         ABI/consumer compatibility — now reads the ERC-7201 config struct instead of
    ///         a construction-time immutable.
    function indexer() public view returns (IEFSIndexerForMirror) {
        return _cfg().indexer;
    }

    /// @notice The UID of the /transports/ anchor. Transport definitions must be
    ///         descendants of this anchor (e.g. /transports/ipfs, /transports/ipfs/v2).
    /// @dev Sequential storage slot 0 — kept stable across the upgradeable refactor.
    ///      Initializable and OwnableUpgradeable state live in ERC-7201 namespaced storage.
    bytes32 public transportsAnchorUID;

    /// @param eas The canonical EAS for the target chain. Stays a constructor immutable on the
    ///            base (EAS is a per-chain constant; see EFSUpgradeableResolver NatSpec). The base
    ///            constructor also runs `_disableInitializers()` so the implementation itself can
    ///            never be initialized — only a proxy can.
    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Sets the partner
    ///      EFSIndexer reference and the owner authorized to call setTransportsAnchor().
    /// @param indexer_ The EFSIndexer (proxy) this resolver indexes mirrors into.
    /// @param owner_   Address authorized to call setTransportsAnchor().
    function initialize(IEFSIndexerForMirror indexer_, address owner_) external initializer {
        __Ownable_init(owner_);
        _cfg().indexer = indexer_;
    }

    /// @notice Set the /transports/ anchor UID. Can only be called once, by the owner.
    function setTransportsAnchor(bytes32 uid) external onlyOwner {
        require(transportsAnchorUID == EMPTY_UID, "already set");
        require(uid != EMPTY_UID, "zero uid");
        transportsAnchorUID = uid;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        IEFSIndexerForMirror idx = _cfg().indexer;

        // Foreign-schema guard (matches AliasResolver/ListEntryResolver/EdgeResolver): EAS invokes this
        // resolver for ANY schema registered against it. Only the canonical MIRROR schema may pass —
        // otherwise a foreign schema with a valid DATA ref + transport + URI would index() and emit
        // MirrorSet, polluting the event-reconstruction flow (specs/03) even though the router (which
        // queries MIRROR_SCHEMA_UID) never serves it. The indexer stores MIRROR_SCHEMA_UID at wiring,
        // before any real mirror is attested, so this read is always populated.
        if (attestation.schema != idx.MIRROR_SCHEMA_UID()) revert WrongSchema();

        // MIRROR must reference a DATA attestation
        if (attestation.refUID == EMPTY_UID) return false;

        Attestation memory target = _eas.getAttestation(attestation.refUID);
        if (target.schema != idx.DATA_SCHEMA_UID()) return false;

        // Lifecycle invariants — a MIRROR is "active until explicitly revoked", with no expiry
        // (matches ListEntryResolver/EdgeResolver). A revocable *schema* only PERMITS revocable
        // attestations; EAS still accepts revocable=false (a dead/hostile URI welded on permanently)
        // and nonzero expirationTime (the mirror silently expires but router/file-view reads filter on
        // revocation, not expiry, so it stays live forever). Reject both at write time.
        if (!attestation.revocable) revert NotRevocable();
        if (attestation.expirationTime != 0) revert HasExpiration();

        // Validate transportDefinition is a valid Anchor and the URI is canonical + length-bounded.
        // NOTE (ADR-0056): there is deliberately NO URI-scheme allowlist. A scheme prefix check on an
        // immutable contract is not a security boundary (an allowed https:// mirror serves malicious
        // HTML just as well) and is trivially evaded (case / zero-width / whitespace / percent-encoding)
        // and un-patchable — and it cannot anticipate future transports. Render/scheme safety lives in
        // the upgradeable client layer (sandboxed rendering); the on-chain gate is the transport-anchor
        // ancestry + length only. See ADR-0056 (supersedes ADR-0023).
        (bytes32 transportDefinition, string memory uri) = abi.decode(attestation.data, (bytes32, string));
        // Reject non-canonical encodings (e.g. trailing bytes) so one semantic mirror has exactly one
        // permanent UID — re-encode the decoded fields and require the bytes round-trip.
        if (keccak256(attestation.data) != keccak256(abi.encode(transportDefinition, uri))) {
            revert NonCanonicalPayload();
        }
        if (bytes(uri).length == 0) revert InvalidData();
        if (bytes(uri).length > MAX_URI_LENGTH) revert URITooLong();
        if (transportDefinition == EMPTY_UID) revert InvalidTransport();
        Attestation memory transport = _eas.getAttestation(transportDefinition);
        if (transport.schema != idx.ANCHOR_SCHEMA_UID()) revert InvalidTransport();

        // Verify the transport anchor is a descendant of /transports/.
        // Allows /transports/ipfs, /transports/ipfs/v2, etc. but rejects
        // arbitrary anchors like /memes/cat.jpg being used as transport labels.
        if (!_isDescendantOfTransports(transportDefinition)) revert InvalidTransport();

        // Register in EFSIndexer for discovery via getReferencingAttestations
        idx.index(attestation.uid);

        // Surface the URI-bearing mirror event for log indexers (the kernel's MirrorCreated omits it).
        emit MirrorSet(attestation.refUID, attestation.attester, transportDefinition, attestation.uid, uri);

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        _cfg().indexer.indexRevocation(attestation.uid);
        // Decode the transportDefinition (the first MIRROR field) so MirrorCleared carries the same
        // (dataUID, attester, transportDefinition) key as MirrorSet. Just a calldata decode — no
        // external call — and lets a log indexer retire the exact transport slot without an eth_call.
        // No canonical-payload guard here: any stored mirror already passed the onAttest re-encode
        // check, so its payload is canonical by construction — and a revocation (a user withdrawing
        // their own mirror) should never be blocked by a write-shape check.
        (bytes32 transportDefinition, ) = abi.decode(attestation.data, (bytes32, string));
        emit MirrorCleared(attestation.refUID, attestation.attester, transportDefinition, attestation.uid);
        return true;
    }

    /// @dev Walk ancestors of `anchorUID` to check if /transports/ is in the chain.
    ///      Supports up to MAX_TRANSPORT_DEPTH (8) levels of nesting below /transports/.
    ///      e.g. /transports/ipfs (depth 1), /transports/ipfs/v2 (depth 2).
    ///      Anchors deeper than 8 levels below /transports/ will be rejected.
    function _isDescendantOfTransports(bytes32 anchorUID) private view returns (bool) {
        IEFSIndexerForMirror idx = _cfg().indexer;
        bytes32 current = anchorUID;
        for (uint256 i = 0; i < MAX_TRANSPORT_DEPTH; i++) {
            bytes32 parent = idx.getParent(current);
            if (parent == EMPTY_UID) return false;
            if (parent == transportsAnchorUID) return true;
            current = parent;
        }
        return false;
    }

}
