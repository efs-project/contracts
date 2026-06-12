// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

contract EFSIndexer is EFSUpgradeableResolver, OwnableUpgradeable {
    error DuplicateFileName();
    error InvalidOffset();
    error MissingParent();
    error InvalidAttestation();
    error AlreadyIndexed();
    error AnchorTooDeep();
    error Unauthorized();
    error InvalidAnchorName();

    /// @notice Emitted when a new Anchor is created under a parent directory.
    ///         Enables off-chain indexers (The Graph) to track directory structure changes
    ///         without scanning all EAS Attested events.
    event AnchorCreated(
        bytes32 indexed parentUID,
        bytes32 indexed anchorUID,
        address indexed attester,
        bytes32 anchorSchema,
        string name
    );

    /// @notice Emitted when a standalone DATA attestation is created (file identity).
    /// @dev    ADR-0049: DATA is now an empty (pure-identity) schema. The `contentHash`
    ///         parameter was removed — content hash lives as a lens-scoped PROPERTY on the
    ///         DATA UID, not as a DATA field. Downstream indexers binding to this event must
    ///         re-bind to the new 2-arg signature.
    event DataCreated(bytes32 indexed dataUID, address indexed attester);

    /// @notice Emitted when a MIRROR attestation is attached to a DATA (retrieval method).
    event MirrorCreated(bytes32 indexed dataUID, bytes32 indexed mirrorUID, address indexed attester);

    /// @notice Emitted when a PROPERTY (interned value) attestation is created.
    /// @dev    `valueHash = keccak256(bytes(value))` is the value's canonical content key (ties
    ///         to the forthcoming canonical-hashing spec). It is the lookup key clients use to
    ///         find an existing value to dedup against — off-chain via this indexed topic, and
    ///         on-chain via the future opt-in intern registry (ADR-0052). PROPERTY is
    ///         non-revocable interned content; the revocable claim is the PIN binding.
    event PropertyCreated(bytes32 indexed propertyUID, address indexed attester, bytes32 indexed valueHash);

    /// @notice SchemaResolver onRevoke hook — flips the `_isRevoked` read-filter for an attestation
    ///         under this indexer's schemas. NOTE: ANCHOR/DATA/PROPERTY are all non-revocable
    ///         (their onAttest rejects `revocable`), so EAS never invokes this in practice; it
    ///         remains as the resolver-interface contract. The revocable schemas
    ///         (PIN/TAG/MIRROR/LIST_ENTRY/REDIRECT) are tracked by their own resolvers.
    event AttestationRevoked(bytes32 indexed uid, address indexed attester);

    /// @notice Emitted when an external attestation is indexed via the public index() API.
    event AttestationIndexed(bytes32 indexed uid, bytes32 indexed schema, address indexed attester);

    /// @notice Emitted when a revocation is synced for an externally-indexed attestation.
    event RevocationIndexed(bytes32 indexed uid);

    // ============================================================================================
    // ERC-7201 NAMESPACED CONFIG (per-deployment, set in initialize())
    // ============================================================================================
    // The schema UIDs and deployer were constructor immutables when EFSIndexer was deployed
    // directly. Under the upgradeable-proxy pattern (ADR-0048) the implementation runs via the
    // proxy's delegatecall, so immutables (which live in the impl's bytecode) would read the
    // impl's construction-time values, not the proxy's. Per-deployment config therefore moves into
    // ERC-7201 namespaced storage written once in initialize(). The namespaced slot sits far from
    // slot 0, so it cannot collide with the existing sequential mapping layout below.

    /// @custom:storage-location erc7201:efs.indexer.config
    struct IndexerConfig {
        bytes32 anchorSchemaUID;
        bytes32 propertySchemaUID;
        bytes32 dataSchemaUID;
    }

    // keccak256(abi.encode(uint256(keccak256("efs.indexer.config")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant INDEXER_CONFIG_SLOT = 0x8236c748e6a502fa91232b6ce96a08db6ef6eb51d97817035831708b310c8900;

    function _cfg() private pure returns (IndexerConfig storage $) {
        assembly {
            $.slot := INDEXER_CONFIG_SLOT
        }
    }

    // Schema-UID public getters preserved by NAME for ABI/consumer compatibility — they now read
    // the ERC-7201 config struct instead of construction-time immutables.
    function ANCHOR_SCHEMA_UID() public view returns (bytes32) {
        return _cfg().anchorSchemaUID;
    }

    function PROPERTY_SCHEMA_UID() public view returns (bytes32) {
        return _cfg().propertySchemaUID;
    }

    function DATA_SCHEMA_UID() public view returns (bytes32) {
        return _cfg().dataSchemaUID;
    }

    // State Variables
    bytes32 public rootAnchorUID;

    // Partner contract references — set once via wireContracts() after full deployment
    // These are bytes32 storage (not immutable) because partner contracts deploy after EFSIndexer.
    //
    // PIN_SCHEMA_UID and TAG_SCHEMA_UID are sibling edge schemas served by a single
    // EdgeResolver contract; cardinality lives in the schema UID itself (PIN = singleton,
    // TAG = list). See ADR-0041.
    bytes32 public PIN_SCHEMA_UID;
    bytes32 public TAG_SCHEMA_UID;
    bytes32 public SORT_INFO_SCHEMA_UID;
    bytes32 public MIRROR_SCHEMA_UID;
    address public edgeResolver;
    address public sortOverlay;
    address public mirrorResolver;
    address public schemaRegistry;

    // Well-known /sorts/ anchor — set once via setSortsAnchor() after deployment
    bytes32 public sortsAnchorUID;

    // Authorization for wireContracts()/setSortsAnchor() is now `onlyOwner` (OwnableUpgradeable),
    // set in initialize(). The former `address public immutable DEPLOYER` is removed — immutables
    // don't work under the proxy delegatecall. Its role (the system-provided-defaults attester and
    // wiring authority) is subsumed by the owner. The `DEPLOYER()` getter is preserved by NAME for
    // ABI/consumer compatibility (EFSRouter default-lens fallback; the nextjs explorer) and now
    // simply returns `owner()`.
    function DEPLOYER() external view returns (address) {
        return owner();
    }

    // Maximum anchor nesting depth — prevents gas griefing in propagateContains
    uint256 public constant MAX_ANCHOR_DEPTH = 32;

    // Content-addressed deduplication: keccak256(contentHash) => first DATA UID.
    // AGENT-NOTE: this is a RETAINED DEAD SLOT, kept for storage-layout stability, no longer
    // written (ADR-0049). DATA is now empty (pure identity) and carries no contentHash, so
    // nothing writes here. Do NOT remove the slot — deleting storage risks the layout snapshot
    // / upgrade-safety gate. ADR-0049 prose was corrected to say "retained as a dead slot, no
    // longer written" (it previously said "removed") so code and ADR agree. Dedup is now
    // client-side prevention + REDIRECT resolution (ADR-0050). EFSFileView.getCanonicalData
    // still reads it (returns bytes32(0)).
    mapping(bytes32 => bytes32) public dataByContentKey;

    // Revocation tracking (set in onRevoke, never cleared)
    mapping(bytes32 => bool) private _isRevoked;

    // External index tracking — UIDs indexed via the public index() API (not via onAttest)
    mapping(bytes32 => bool) private _indexed;

    // ============================================================================================
    // STORAGE: FILE SYSTEM INDICES (EFS CORE)
    // ============================================================================================

    // Directory Index (Path Resolution): parentAnchorUID => name => schemaUID => childAnchorUID
    mapping(bytes32 => mapping(string => mapping(bytes32 => bytes32))) private _nameToAnchor;

    // Hierarchy List: parentAnchorUID => childAnchorUIDs
    mapping(bytes32 => bytes32[]) private _children;

    // Children By Schema: parentAnchorUID => schemaUID => childAnchorUIDs
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _childrenBySchema;

    // Parent Lookups: childAnchorUID => parentAnchorUID
    mapping(bytes32 => bytes32) private _parents;

    // Attester Index: parentAnchorUID => attester => childAnchorUIDs
    mapping(bytes32 => mapping(address => bytes32[])) private _childrenByAttester;

    // Dedup set for `_childrenByAttester`: parent => attester => child => pushed-ever.
    // Separate from `_containsAttestations` because `clearContains` flips the latter
    // to false (to make empty folders disappear from directory views) — but
    // `_childrenByAttester` is append-only per ADR-0009, and re-pushing the same
    // child on a remove-then-readd cycle would produce duplicates and inflate
    // `getChildrenByAttesterCount`. This flag is SET-ONLY, never cleared.
    mapping(bytes32 => mapping(address => mapping(bytes32 => bool))) private _childInChildrenByAttester;

    // ============================================================================================
    // STORAGE: GENERIC INDICES (SOCIAL LAYER)
    // ============================================================================================

    // Global Schema Index: schemaUID => attestationUIDs
    mapping(bytes32 => bytes32[]) private _schemaAttestations;

    // User Schema Index: attester => schemaUID => attestationUIDs
    mapping(address => mapping(bytes32 => bytes32[])) private _sentAttestations;

    // User Schema Specific Index: schemaUID => attester => attestationUIDs
    mapping(bytes32 => mapping(address => bytes32[])) private _schemaAttesterAttestations;

    // Incoming: recipient => schemaUID => attestationUIDs
    mapping(address => mapping(bytes32 => bytes32[])) private _receivedAttestations;

    // References: targetUID => schemaUID => attestationUIDs
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _referencingAttestations;

    // List of Schemas referencing a target: targetUID => schemaUIDs
    mapping(bytes32 => bytes32[]) private _referencingSchemas;
    // Helper to check existence: targetUID => schemaUID => exists
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasReferencingSchema;

    // ============================================================================================
    // STORAGE: LENSES (APPEND-ONLY HISTORY)
    // ============================================================================================
    // These mappings are append-only. Revocations do NOT remove entries from these arrays.
    // This preserves the full edit history and allows clients to filter by showRevoked.
    mapping(bytes32 => bytes32[]) private _allReferencing;
    mapping(bytes32 => mapping(address => bytes32[])) private _referencingByAttester;
    mapping(bytes32 => mapping(bytes32 => mapping(address => bytes32[]))) private _referencingBySchemaAndAttester;

    // Lens Activity Trackers
    // NOTE: These flags are SET-ONLY and never cleared on revocation.
    // `_containsAttestations[uid][attester]` means "attester has EVER contributed under this anchor",
    // not "attester currently has active/unrevoked data here". This is intentional:
    //   - Clearing on revoke would require expensive decrement logic on every revocation
    //   - The UI filters active content via EdgeResolver's _activeBySlot (PIN) and _activeByAAS (TAG) indices
    //   - The early-break optimization in the recursive loop depends on monotonic set-only behavior
    mapping(bytes32 => mapping(address => bool)) private _containsAttestations;
    mapping(bytes32 => mapping(address => mapping(bytes32 => bool))) private _containsSchemaAttestations;

    // Anchor type cache: anchorUID => anchorSchema (the bytes32 content-type field in anchor data).
    // Stored at creation so parent-type checks are O(1) without re-decoding EAS attestation data.
    mapping(bytes32 => bytes32) private _anchorSchemaOf;

    /// @param eas The canonical EAS for the target chain. Stays a constructor immutable on the
    ///            base (EAS is a per-chain constant; see EFSUpgradeableResolver NatSpec). The base
    ///            constructor also runs `_disableInitializers()` so the implementation itself can
    ///            never be initialized — only a proxy can.
    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. Sets the EFS schema UIDs
    ///      (baked into the schema UIDs that name this proxy as resolver) and the owner authorized
    ///      to wire partner contracts. The schema UIDs migrate here from former constructor
    ///      immutables (ADR-0048).
    /// @param anchorSchemaUID   ANCHOR schema UID resolved by this indexer.
    /// @param propertySchemaUID PROPERTY schema UID resolved by this indexer.
    /// @param dataSchemaUID     DATA schema UID resolved by this indexer.
    /// @param owner_            Address authorized to call wireContracts()/setSortsAnchor().
    function initialize(
        bytes32 anchorSchemaUID,
        bytes32 propertySchemaUID,
        bytes32 dataSchemaUID,
        address owner_
    ) external initializer {
        require(owner_ != address(0), "EFSIndexer: owner is zero");
        __Ownable_init(owner_);
        IndexerConfig storage $ = _cfg();
        $.anchorSchemaUID = anchorSchemaUID;
        $.propertySchemaUID = propertySchemaUID;
        $.dataSchemaUID = dataSchemaUID;
    }

    /**
     * @notice Wire partner contracts after full deployment.
     *         Call once from the deploy script after EdgeResolver and EFSSortOverlay are deployed.
     *         After calling, PIN_SCHEMA_UID, TAG_SCHEMA_UID, SORT_INFO_SCHEMA_UID, edgeResolver,
     *         sortOverlay, and schemaRegistry are all queryable from a single entry point.
     * @dev Can only be called by the owner and only once (edgeResolver address guards re-entry).
     *      The one-shot `edgeResolver == address(0)` guard reads proxy storage and survives
     *      implementation upgrades.
     */
    function wireContracts(
        address _edgeResolver,
        bytes32 _pinSchemaUID,
        bytes32 _tagSchemaUID,
        address _sortOverlay,
        bytes32 _sortInfoSchemaUID,
        address _mirrorResolver,
        bytes32 _mirrorSchemaUID,
        address _schemaRegistry
    ) external onlyOwner {
        require(edgeResolver == address(0), "EFSIndexer: already wired");
        edgeResolver = _edgeResolver;
        PIN_SCHEMA_UID = _pinSchemaUID;
        TAG_SCHEMA_UID = _tagSchemaUID;
        sortOverlay = _sortOverlay;
        SORT_INFO_SCHEMA_UID = _sortInfoSchemaUID;
        mirrorResolver = _mirrorResolver;
        MIRROR_SCHEMA_UID = _mirrorSchemaUID;
        schemaRegistry = _schemaRegistry;
    }

    /**
     * @notice Set the well-known /sorts/ anchor UID.
     *         Called once from the deploy script after the sorts anchor is created.
     * @dev Can only be called by the owner and only once. The one-shot
     *      `sortsAnchorUID == bytes32(0)` guard reads proxy storage and survives upgrades.
     */
    function setSortsAnchor(bytes32 _sortsAnchorUID) external onlyOwner {
        require(sortsAnchorUID == bytes32(0), "EFSIndexer: sorts anchor already set");
        sortsAnchorUID = _sortsAnchorUID;
    }

    /**
     * @notice Propagate "contains attestations by attester" flags from an anchor up the tree.
     *         Called by EdgeResolver when a PIN or TAG with a non-zero refUID places content
     *         at an anchor, and by SortOverlay for sort-related propagation.
     *
     *         Walks _parents from anchorUID to root, flagging _containsAttestations and
     *         building _childrenByAttester. Early-exits if already flagged (amortized O(1)).
     *
     * @param anchorUID The anchor to start propagation from.
     * @param attester  The attester whose presence to propagate.
     */
    function propagateContains(bytes32 anchorUID, address attester) external {
        if (msg.sender != edgeResolver && msg.sender != sortOverlay) {
            revert Unauthorized();
        }
        _propagateContains(anchorUID, attester);
    }

    /**
     * @notice Clear the "contains attestations by attester" flag at a single anchor.
     *         Called by EdgeResolver when the last active edge placed at an anchor by an
     *         attester is removed (revoked PIN or revoked TAG). Only clears the immediate
     *         anchor — ancestor flags remain set (optimistic / sticky).
     *
     *         Clearing the immediate folder flag is O(1) and sufficient for accurate
     *         subfolder listing: getDirectoryByAddressList and getAnchorsBySchemaAndAddressList
     *         both check _containsAttestations[child][attester] on the direct children, so
     *         clearing it makes an empty folder disappear from the attester's directory view.
     *
     *         Note: this does NOT clear `_childInChildrenByAttester` — that mapping is the
     *         append-only dedup set for `_childrenByAttester`. If we cleared it, a subsequent
     *         `_propagateContains` on re-add would push the child a second time, inflating
     *         `getChildrenByAttesterCount`. Readers that need "is this folder currently
     *         non-empty for this attester?" must check `_containsAttestations`; the child
     *         array is a historical-membership index per ADR-0009.
     *
     * @param anchorUID The folder anchor to clear.
     * @param attester  The attester whose flag to clear.
     */
    function clearContains(bytes32 anchorUID, address attester) external {
        if (msg.sender != edgeResolver) revert Unauthorized();
        _containsAttestations[anchorUID][attester] = false;
    }

    function _propagateContains(bytes32 anchorUID, address attester) private {
        bytes32 current = anchorUID;
        uint256 depth = 0;
        while (current != bytes32(0)) {
            if (_containsAttestations[current][attester]) break;
            if (depth++ > MAX_ANCHOR_DEPTH) break;
            _containsAttestations[current][attester] = true;
            bytes32 parentUID = _parents[current];
            // Guard the append-only push with a dedicated dedup flag (not
            // `_containsAttestations`, which `clearContains` toggles off).
            // Without this guard, a remove-then-readd cycle would push `current`
            // twice and inflate `getChildrenByAttesterCount`.
            if (parentUID != bytes32(0) && !_childInChildrenByAttester[parentUID][attester][current]) {
                _childrenByAttester[parentUID][attester].push(current);
                _childInChildrenByAttester[parentUID][attester][current] = true;
            }
            current = parentUID;
        }
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        // 1. GLOBAL INDEXING (ALL ATTESTATIONS)
        _indexGlobal(attestation);

        // 2. EFS CORE LOGIC (ANCHORS)
        bytes32 schema = attestation.schema;
        IndexerConfig storage $ = _cfg();
        if (schema == $.anchorSchemaUID) {
            // Anchors are permanent structural nodes — revocable anchors are rejected.
            if (attestation.revocable) return false;
            // ...and non-expiring: a non-revocable *schema* doesn't stop EAS accepting a nonzero
            // expirationTime, and EFS reads filter on revocation/index state, not EAS expiry — so an
            // expiring anchor would keep resolving forever past its expiry. Reject it (PR #24 P2).
            if (attestation.expirationTime != 0) return false;

            (string memory name, bytes32 anchorSchema) = abi.decode(attestation.data, (string, bytes32));

            // Validate name: must be the canonical anchor-name encoding (NFC + percent-encode,
            // uppercase hex) — see _isValidAnchorName. Reserved bytes must be %XX-escaped; NFC
            // normalization is the client's responsibility (not verifiable on-chain). This keeps
            // exactly one valid encoding per name (the Schelling-point property).
            if (!_isValidAnchorName(name)) revert InvalidAnchorName();

            // Resolve Parent (Use refUID, else recipient cast to bytes32, else generic root if 0)
            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }

            // ROOT ANCHOR LOGIC
            // If this is the FIRST generic anchor (schema 0), it can be root if root is unset.
            if (rootAnchorUID == bytes32(0)) {
                if (anchorSchema == bytes32(0)) {
                    rootAnchorUID = attestation.uid;
                } else {
                    revert MissingParent(); // First anchor must be generic root
                }
            } else {
                if (parentUID == bytes32(0)) {
                    revert MissingParent();
                }
            }

            // Validation: Enforce unique filenames O(1) per Schema
            if (_nameToAnchor[parentUID][name][anchorSchema] != bytes32(0)) {
                revert DuplicateFileName();
            }

            // Validation: Enforce MAX_ANCHOR_DEPTH to prevent gas griefing in propagateContains
            if (parentUID != bytes32(0)) {
                uint256 depth = 1;
                bytes32 walker = parentUID;
                while (_parents[walker] != bytes32(0)) {
                    depth++;
                    if (depth > MAX_ANCHOR_DEPTH) revert AnchorTooDeep();
                    walker = _parents[walker];
                }
            }

            // Write Directory
            _nameToAnchor[parentUID][name][anchorSchema] = attestation.uid;

            // Hierarchy Index (All Children)
            _children[parentUID].push(attestation.uid);

            // Hierarchy Index (By Schema)
            _childrenBySchema[parentUID][anchorSchema].push(attestation.uid);

            _parents[attestation.uid] = parentUID;

            // Anchor type cache — enables O(1) parent-type lookup without re-decoding EAS data
            _anchorSchemaOf[attestation.uid] = anchorSchema;

            // Attester Index (My Files)
            // Note: Since _childrenByAttester is now natively tracking collaborative interactions deeply via the recursion loop above,
            // we only push to it here IF it's the very first time this creator has interacted with this parent, to prevent duplicates.
            // Set `_childInChildrenByAttester` as well so any later `_propagateContains(uid, attester)` after a
            // `clearContains` cycle doesn't re-push and duplicate the entry.
            if (!_containsAttestations[attestation.uid][attestation.attester]) {
                _containsAttestations[attestation.uid][attestation.attester] = true;
                if (
                    parentUID != bytes32(0) &&
                    !_childInChildrenByAttester[parentUID][attestation.attester][attestation.uid]
                ) {
                    _childrenByAttester[parentUID][attestation.attester].push(attestation.uid);
                    _childInChildrenByAttester[parentUID][attestation.attester][attestation.uid] = true;
                }
            }

            emit AnchorCreated(parentUID, attestation.uid, attestation.attester, anchorSchema, name);
            return true;
        } else if (schema == $.dataSchemaUID) {
            // DATA is pure file identity (ADR-0049): empty schema, standalone, non-revocable.
            // The attestation carries no fields (zero-length payload) — its UID *is* the
            // file's identity. contentHash/size now live as lens-scoped reserved-key
            // PROPERTYs bound to this UID, not as DATA fields, so there is nothing to decode.
            // EAS does not enforce the registered schema's ABI on attestation.data — it stores
            // whatever bytes are passed — so the resolver must reject any non-empty payload to
            // keep the empty-DATA canonical invariant (a DATA UID carrying arbitrary bytes would
            // otherwise be indexed and served as valid pure-identity DATA).
            if (attestation.refUID != EMPTY_UID) return false;
            if (attestation.revocable) return false;
            if (attestation.expirationTime != 0) return false; // permanent identity — no EAS expiry (PR #24 P2)
            if (attestation.data.length != 0) return false;

            // The bare DATA UID is already tracked by _indexGlobal above (step 1).
            emit DataCreated(attestation.uid, attestation.attester);
            return true;
        } else if (schema == $.propertySchemaUID) {
            // PROPERTY is a standalone value (ADR-0035): refUID must be 0x0, non-revocable.
            // Placement lives in a PIN under an Anchor<PROPERTY>(name="<key>") (ADR-0041,
            // superseding the original TAG framing). PROPERTY is NON-revocable interned content
            // (ADR-0052): a value is dumb, shared content (many PINs can point at one value),
            // not a claim — so the revocable *claim* lives in the PIN (the binding), not here.
            // Non-revocability is what makes a value safely shareable: it can't be yanked out
            // from under other bindings. Like ANCHOR and DATA, we reject revocable attestations.
            if (attestation.refUID != EMPTY_UID) return false;
            if (attestation.revocable) return false;
            if (attestation.expirationTime != 0) return false; // interned value is permanent — no EAS expiry (PR #24 P2)

            // valueHash = keccak256(bytes(value)) is the value's canonical lookup key (ties to
            // the forthcoming canonical-hashing spec). Clients use it as the content key to find
            // an existing value to dedup against — off-chain via this event's indexed topic, and
            // on-chain via the future opt-in intern registry (ADR-0052). Decode the sole field.
            string memory value = abi.decode(attestation.data, (string));
            emit PropertyCreated(attestation.uid, attestation.attester, keccak256(bytes(value)));
            return true;
        }

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        // Kernel keeps all items forever. Revocation is just a flag.
        // Read functions use _isRevoked to filter when showRevoked=false.
        _isRevoked[attestation.uid] = true;
        emit AttestationRevoked(attestation.uid, attestation.attester);
        return true;
    }

    // ============================================================================================
    // READ FUNCTIONS
    // ============================================================================================

    // EFS Core

    function resolvePath(bytes32 parentUID, string memory name) external view returns (bytes32) {
        return _nameToAnchor[parentUID][name][bytes32(0)]; // Default to Generic
    }

    function resolveAnchor(bytes32 parentUID, string memory name, bytes32 schema) external view returns (bytes32) {
        return _nameToAnchor[parentUID][name][schema];
    }

    function getChildren(
        bytes32 anchorUID,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_children[anchorUID], start, length, reverseOrder, showRevoked);
    }

    /// @notice Convenience overload — showRevoked defaults to false.
    function getChildren(
        bytes32 anchorUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_children[anchorUID], start, length, reverseOrder, false);
    }

    function getChildrenCount(bytes32 anchorUID) external view returns (uint256) {
        return _children[anchorUID].length;
    }

    function getChildrenByAttester(
        bytes32 anchorUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_childrenByAttester[anchorUID][attester], start, length, reverseOrder, showRevoked);
    }

    /// @notice Convenience overload — showRevoked defaults to false.
    function getChildrenByAttester(
        bytes32 anchorUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_childrenByAttester[anchorUID][attester], start, length, reverseOrder, false);
    }

    function getChildrenByAttesterCount(bytes32 anchorUID, address attester) external view returns (uint256) {
        return _childrenByAttester[anchorUID][attester].length;
    }

    /// @notice Read a single item from an attester's kernel array by physical index.
    ///         Used by EFSSortOverlay.processItems to validate submitted items against the
    ///         kernel before inserting them into the sorted linked list.
    function getChildrenByAttesterAt(bytes32 anchorUID, address attester, uint256 idx) external view returns (bytes32) {
        bytes32[] storage arr = _childrenByAttester[anchorUID][attester];
        require(idx < arr.length, "EFSIndexer: index out of bounds");
        return arr[idx];
    }

    // ============================================================================================
    // O(1) INDEX ACCESS — used by EFSSortOverlay.processItems for validation
    // ============================================================================================

    /// @notice Read a single item from the global children array by physical index.
    function getChildAt(bytes32 parentAnchor, uint256 idx) external view returns (bytes32) {
        bytes32[] storage arr = _children[parentAnchor];
        require(idx < arr.length, "EFSIndexer: index out of bounds");
        return arr[idx];
    }

    /// @notice Read a single item from the schema-filtered children array by physical index.
    function getChildBySchemaAt(bytes32 parentAnchor, bytes32 schema, uint256 idx) external view returns (bytes32) {
        bytes32[] storage arr = _childrenBySchema[parentAnchor][schema];
        require(idx < arr.length, "EFSIndexer: index out of bounds");
        return arr[idx];
    }

    /// @notice Read a single item from the referencing attestations array by physical index.
    function getReferencingAt(bytes32 targetUID, bytes32 schema, uint256 idx) external view returns (bytes32) {
        bytes32[] storage arr = _referencingAttestations[targetUID][schema];
        require(idx < arr.length, "EFSIndexer: index out of bounds");
        return arr[idx];
    }

    /// @notice Count of children matching a specific anchor schema.
    function getChildCountBySchema(bytes32 parentAnchor, bytes32 schema) external view returns (uint256) {
        return _childrenBySchema[parentAnchor][schema].length;
    }

    /// @notice Count of referencing attestations for a target UID and schema.
    ///         Alias for getReferencingAttestationCount — named for sort overlay consistency.
    function getReferencingCount(bytes32 targetUID, bytes32 schema) external view returns (uint256) {
        return _referencingAttestations[targetUID][schema].length;
    }

    function getAnchorsBySchema(
        bytes32 anchorUID,
        bytes32 schema,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_childrenBySchema[anchorUID][schema], start, length, reverseOrder, showRevoked);
    }

    /// @notice Convenience overload — showRevoked defaults to false.
    function getAnchorsBySchema(
        bytes32 anchorUID,
        bytes32 schema,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDsFiltered(_childrenBySchema[anchorUID][schema], start, length, reverseOrder, false);
    }

    /**
     * @notice Paginated list of a directory's Anchors filtered by BOTH anchorSchema AND
     *         attester list. Walks the schema-indexed array (smaller than the global children
     *         array) and applies the same O(1) `_containsAttestations` attester check.
     *
     *         Use this when you want, e.g., "all file-slot Anchors from [alice, bob]" without
     *         mixing in sort declarations, property slots, or generic folders:
     *           getAnchorsBySchemaAndAddressList(dirUID, DATA_SCHEMA_UID, [alice, bob], ...)
     *
     * @param parentUID    Directory Anchor UID.
     * @param anchorSchema The anchorSchema value to filter on (bytes32(0) = generic folders).
     * @param attesters    Addresses to filter by. An anchor qualifies if ANY attester contributed.
     * @param startCursor  Raw index into the schema-indexed array to resume from (0 = start).
     * @param pageSize     Maximum items to return.
     * @param reverseOrder If true, scan newest-first.
     * @param showRevoked  If false, revoked anchors are skipped.
     * @return results     Qualifying anchor UIDs.
     * @return nextCursor  Resume cursor. 0 = end of results.
     */
    function getAnchorsBySchemaAndAddressList(
        bytes32 parentUID,
        bytes32 anchorSchema,
        address[] calldata attesters,
        uint256 startCursor,
        uint256 pageSize,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextCursor) {
        require(attesters.length > 0, "Attesters list cannot be empty");

        bytes32[] storage schemaChildren = _childrenBySchema[parentUID][anchorSchema];
        uint256 total = schemaChildren.length;

        bytes32[] memory temp = new bytes32[](pageSize > 0 ? pageSize : 0);
        uint256 count = 0;
        uint256 i = startCursor;

        while (count < pageSize && i < total) {
            uint256 actualIdx = reverseOrder ? total - 1 - i : i;
            bytes32 uid = schemaChildren[actualIdx];
            i++;

            if (!showRevoked && _isRevoked[uid]) continue;

            bool qualifies = false;
            for (uint256 j = 0; j < attesters.length; j++) {
                if (_containsAttestations[uid][attesters[j]]) {
                    qualifies = true;
                    break;
                }
            }
            if (!qualifies) continue;

            temp[count++] = uid;
        }

        assembly {
            mstore(temp, count)
        }
        return (temp, i >= total ? 0 : i);
    }

    // Generic Explorer

    function getAttestationsBySchema(
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_schemaAttestations[schemaUID], start, length, reverseOrder);
    }

    function getAttestationCountBySchema(bytes32 schemaUID) external view returns (uint256) {
        return _schemaAttestations[schemaUID].length;
    }

    function getAttestationsBySchemaAndAttester(
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_schemaAttesterAttestations[schemaUID][attester], start, length, reverseOrder);
    }

    function getAttestationCountBySchemaAndAttester(
        bytes32 schemaUID,
        address attester
    ) external view returns (uint256) {
        return _schemaAttesterAttestations[schemaUID][attester].length;
    }

    function getReferencingAttestations(
        bytes32 targetUID,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingAttestations[targetUID][schemaUID], start, length, reverseOrder);
    }

    function getReferencingAttestationCount(bytes32 targetUID, bytes32 schemaUID) external view returns (uint256) {
        return _referencingAttestations[targetUID][schemaUID].length;
    }

    function getIncomingAttestations(
        address recipient,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_receivedAttestations[recipient][schemaUID], start, length, reverseOrder);
    }

    function getOutgoingAttestations(
        address attester,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_sentAttestations[attester][schemaUID], start, length, reverseOrder);
    }

    // ============================================================================================
    // READ FUNCTIONS: LENSES (Address-Based Queries & History)
    // ============================================================================================

    // --- Generic Referencing Mappings ---

    function getAllReferencing(
        bytes32 targetUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_allReferencing[targetUID], start, length, reverseOrder);
    }

    function getReferencingByAttester(
        bytes32 targetUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingByAttester[targetUID][attester], start, length, reverseOrder);
    }

    function getReferencingBySchemaAndAttester(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingBySchemaAndAttester[targetUID][schemaUID][attester], start, length, reverseOrder);
    }

    // --- Directory Perspectives (ANCHOR Schema) ---

    /**
     * @notice Return the unique children of `parentUID` that any of the given attesters
     *         have contributed to — anchors where any attester created or posted DATA.
     *
     *         Results are drawn from the global `_children` array (always unique, insertion order)
     *         and filtered with O(1) `_containsAttestations` lookups. No duplicates possible.
     *
     * @param parentUID    Anchor UID of the parent directory.
     * @param attesters    Addresses to filter by. An anchor qualifies if ANY attester contributed.
     * @param startCursor  Raw index into `_children[parentUID]` to resume scanning from (0 = start).
     *                     Pass the returned `nextCursor` on the next call. nextCursor = 0 means end.
     * @param pageSize     Maximum items to return.
     * @param reverseOrder If true, scan from the most recently added child backwards.
     * @param showRevoked  If false (default), revoked anchors are skipped.
     * @return results     Unique qualifying anchor UIDs.
     * @return nextCursor  Resume cursor for the next page. 0 = end of results.
     */
    function getChildrenByAddressList(
        bytes32 parentUID,
        address[] calldata attesters,
        uint256 startCursor,
        uint256 pageSize,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextCursor) {
        require(attesters.length > 0, "Attesters list cannot be empty");

        bytes32[] storage allChildren = _children[parentUID];
        uint256 total = allChildren.length;

        bytes32[] memory temp = new bytes32[](pageSize > 0 ? pageSize : 0);
        uint256 count = 0;
        uint256 i = startCursor;

        while (count < pageSize && i < total) {
            uint256 actualIdx = reverseOrder ? total - 1 - i : i;
            bytes32 uid = allChildren[actualIdx];
            i++;

            if (!showRevoked && _isRevoked[uid]) continue;

            bool qualifies = false;
            for (uint256 j = 0; j < attesters.length; j++) {
                if (_containsAttestations[uid][attesters[j]]) {
                    qualifies = true;
                    break;
                }
            }
            if (!qualifies) continue;

            temp[count++] = uid;
        }

        assembly {
            mstore(temp, count)
        }
        return (temp, i >= total ? 0 : i);
    }

    function getReferencingSchemas(bytes32 targetUID) external view returns (bytes32[] memory) {
        return _referencingSchemas[targetUID];
    }

    // getEAS() is inherited from EFSUpgradeableResolver (returns the constructor-immutable EAS).

    function getAllReferencingCount(bytes32 targetUID) external view returns (uint256) {
        return _allReferencing[targetUID].length;
    }

    function getReferencingByAttesterCount(bytes32 targetUID, address attester) external view returns (uint256) {
        return _referencingByAttester[targetUID][attester].length;
    }

    function getReferencingBySchemaAndAttesterCount(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester
    ) external view returns (uint256) {
        return _referencingBySchemaAndAttester[targetUID][schemaUID][attester].length;
    }

    function containsAttestations(bytes32 targetUID, address attester) external view returns (bool) {
        return _containsAttestations[targetUID][attester];
    }

    function containsSchemaAttestations(
        bytes32 targetUID,
        address attester,
        bytes32 schemaUID
    ) external view returns (bool) {
        return _containsSchemaAttestations[targetUID][attester][schemaUID];
    }

    // ============================================================================================
    // INTERNAL HELPERS
    // ============================================================================================

    /// @notice Validates the *canonical* on-chain encoding of an anchor name.
    /// @dev Canonical anchor-name encoding (ADR-0048 / decisions.md): the human-facing name is
    ///      Unicode-NFC-normalized **client-side** (NFC tables are too large to run on-chain — the
    ///      resolver CANNOT verify normalization and does not try), then the reserved byte set is
    ///      percent-encoded (`%XX`, UPPERCASE hex). This gives every name exactly ONE valid
    ///      on-chain representation, preserving the Schelling-point property that independent
    ///      clients resolve the same human name to the same anchor.
    ///
    ///      This function enforces the byte-level half of that contract — it accepts ONLY the
    ///      canonical form and rejects every non-canonical variant:
    ///        - empty, and the reserved relative segments "." / "..";
    ///        - a *bare* reserved byte (must be percent-encoded): the C0 control range 0x00–0x1F,
    ///          DEL 0x7F, space 0x20, and the URI/path-special set
    ///          `" # % & / : = ? @ [ \ ] ^ \` { | }` (see RESERVED table below);
    ///        - a malformed or truncated escape (`%`, `%2`, `%ZZ`);
    ///        - a lowercase-hex escape (`%2f`) — only UPPERCASE hex (`%2F`) is canonical, so a
    ///          single byte can't have two valid encodings.
    ///        - a *non-canonical* escape — a well-formed uppercase `%XX` whose decoded byte did NOT
    ///          have to be escaped. Canonicity requires the escape carry a byte that genuinely must
    ///          be percent-encoded: the decoded byte must be `_isReservedByte(b) || b == 0x25` (`%`).
    ///          So `%2F` (/), `%20` (space), `%25` (literal %) are accepted, but `%41` (A) and
    ///          `%2E` (.) are rejected — those bytes are unreserved and must appear bare, giving each
    ///          byte exactly ONE valid spelling.  (`%` itself is reserved-for-escaping but is
    ///          deliberately excluded from `_isReservedByte`, so it is admitted explicitly here.)
    ///      All other bytes — including high-bit (>= 0x80) UTF-8 bytes for non-ASCII names — pass
    ///      through unescaped. `%` is legal ONLY as the lead byte of a well-formed `%XX` escape.
    ///      Single byte-pass over the name (no allocation).
    function _isValidAnchorName(string memory _name) private pure returns (bool) {
        bytes memory nb = bytes(_name);
        uint256 len = nb.length;
        if (len == 0) return false;
        // Reject "." and ".." — reserved relative path segments
        if (len == 1 && nb[0] == 0x2E) return false;
        if (len == 2 && nb[0] == 0x2E && nb[1] == 0x2E) return false;
        for (uint256 i = 0; i < len; i++) {
            bytes1 c = nb[i];
            if (c == 0x25) {
                // "%" — must introduce a canonical uppercase %XX escape.
                if (i + 2 >= len) return false; // truncated (need two more bytes)
                if (!_isUpperHex(nb[i + 1]) || !_isUpperHex(nb[i + 2])) return false;
                // Canonicity: the escape must carry a byte that genuinely had to be encoded.
                // Decode the two uppercase-hex nibbles and reject the escape unless the byte is
                // reserved (or `%` itself, which is reserved-for-escaping but excluded from
                // _isReservedByte). This blocks aliases like %41 (A) / %2E (.) — they must be bare.
                bytes1 decoded = bytes1((_hexNibble(nb[i + 1]) << 4) | _hexNibble(nb[i + 2]));
                if (!_isReservedByte(decoded) && decoded != 0x25) return false;
                i += 2; // consume the two hex digits
            } else if (_isReservedByte(c)) {
                // Bare reserved byte — must have been percent-encoded client-side.
                return false;
            }
        }
        return true;
    }

    /// @dev Reserved bytes that MUST be percent-encoded in a canonical anchor name.
    ///      = the C0 control range (0x00–0x1F) + DEL (0x7F) + space (0x20) + the URI/path-special
    ///      set. `%` (0x25) is handled separately by the escape parser and is NOT listed here.
    function _isReservedByte(bytes1 c) private pure returns (bool) {
        if (uint8(c) < 0x20 || c == 0x7F) return true; // C0 controls + DEL
        return (c == 0x20 || // space
            c == 0x22 || // "
            c == 0x23 || // #
            c == 0x26 || // &
            c == 0x2F || // /
            c == 0x3A || // :
            c == 0x3D || // =
            c == 0x3F || // ?
            c == 0x40 || // @
            c == 0x5B || // [
            c == 0x5C || // \
            c == 0x5D || // ]
            c == 0x5E || // ^
            c == 0x60 || // `
            c == 0x7B || // {
            c == 0x7C || // |
            c == 0x7D); // }
    }

    /// @dev True for an UPPERCASE hex digit: 0-9 or A-F. Lowercase a-f is rejected so each byte
    ///      has exactly one canonical %XX escape.
    function _isUpperHex(bytes1 c) private pure returns (bool) {
        return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46);
    }

    /// @dev Decodes one UPPERCASE hex digit (0-9 or A-F) to its 0–15 nibble value. Caller must have
    ///      already confirmed the byte via `_isUpperHex`; behavior for other bytes is unspecified.
    function _hexNibble(bytes1 c) private pure returns (uint8) {
        uint8 v = uint8(c);
        // '0'..'9' → 0..9 ; 'A'..'F' → 10..15
        return v <= 0x39 ? v - 0x30 : v - 0x41 + 10;
    }

    function _sliceUIDs(
        bytes32[] storage uids,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) private view returns (bytes32[] memory) {
        uint256 attestationsLength = uids.length;
        if (attestationsLength == 0) {
            return new bytes32[](0);
        }

        if (start >= attestationsLength) {
            return new bytes32[](0);
        }

        unchecked {
            uint256 len = length;
            if (attestationsLength < start + length) {
                len = attestationsLength - start;
            }

            bytes32[] memory res = new bytes32[](len);

            for (uint256 i = 0; i < len; ++i) {
                res[i] = uids[reverseOrder ? attestationsLength - (start + i + 1) : start + i];
            }

            return res;
        }
    }

    /// @notice Filtered slice — skips revoked items when showRevoked=false.
    ///         `start` is the physical array index to begin scanning from.
    ///         Returns up to `length` non-revoked items (or all items if showRevoked=true).
    function _sliceUIDsFiltered(
        bytes32[] storage uids,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) private view returns (bytes32[] memory) {
        uint256 totalLen = uids.length;
        if (totalLen == 0 || length == 0) {
            return new bytes32[](0);
        }

        if (start >= totalLen) {
            revert InvalidOffset();
        }

        // Fast path: if showRevoked, behave exactly like _sliceUIDs
        if (showRevoked) {
            return _sliceUIDs(uids, start, length, reverseOrder);
        }

        bytes32[] memory temp = new bytes32[](length);
        uint256 count = 0;
        uint256 currentIndex = start;

        while (count < length && currentIndex < totalLen) {
            uint256 actualIdx = reverseOrder ? totalLen - 1 - currentIndex : currentIndex;
            bytes32 uid = uids[actualIdx];

            if (!_isRevoked[uid]) {
                temp[count++] = uid;
            }
            currentIndex++;
        }

        // Truncate to actual count in-place — avoids a second allocation + copy loop.
        assembly {
            mstore(temp, count)
        }
        return temp;
    }

    /// @dev Core indexing logic shared by onAttest and the public index() API.
    ///      Writes all generic discovery indices: schema, attester, sent, received,
    ///      referencing, and the upward _childrenByAttester propagation chain.
    ///      Does NOT run EFS-specific logic (Anchor tree, DATA content, Property validation).
    function _indexGlobal(Attestation memory attestation) private {
        // Cache struct fields to avoid repeated memory reads across multiple mappings.
        bytes32 uid = attestation.uid;
        bytes32 schema = attestation.schema;
        address attester = attestation.attester;
        bytes32 refUID = attestation.refUID;

        _schemaAttestations[schema].push(uid);
        _schemaAttesterAttestations[schema][attester].push(uid);
        _sentAttestations[attester][schema].push(uid);

        if (attestation.recipient != address(0)) {
            _receivedAttestations[attestation.recipient][schema].push(uid);
        }

        if (refUID != EMPTY_UID) {
            _referencingAttestations[refUID][schema].push(uid);
            _addReferencingSchema(refUID, schema);

            _allReferencing[refUID].push(uid);
            _referencingByAttester[refUID][attester].push(uid);
            _referencingBySchemaAndAttester[refUID][schema][attester].push(uid);

            // Lens Mappings (Recursive upward propagation for Folder Visibility)
            // This loop walks the _parents chain from refUID to root, marking each
            // ancestor as "containing activity by this attester". It also pushes each ancestor
            // into its parent's _childrenByAttester, so lens-filtered directory listings
            // transitively include intermediate folders that contain the attester's work.
            //
            // Example: User2 attests DATA on /pets/cats/fluffy.png
            //   → _childrenByAttester[catsUID][user2]  gets fluffy.png's anchor
            //   → _childrenByAttester[petsUID][user2]  gets catsUID
            //   → _childrenByAttester[rootUID][user2]  gets petsUID
            // This enables getChildrenByAddressList to show the full navigable tree for each user.
            bytes32 currentUID = refUID;

            // Set specific schema interaction on the direct target only (not recursively)
            if (!_containsSchemaAttestations[currentUID][attester][schema]) {
                _containsSchemaAttestations[currentUID][attester][schema] = true;
            }

            // Propagate generic "active in this structure" flag all the way up the tree
            while (currentUID != bytes32(0)) {
                // If this level is already flagged true, the rest of the chain above it must be too.
                // Break early to save gas (amortized O(1) for repeat contributions by same user).
                if (_containsAttestations[currentUID][attester]) {
                    break;
                }

                _containsAttestations[currentUID][attester] = true;

                // Drive the structural index: push this child into the parent's
                // Lens array, guarded by the append-only dedup flag so a
                // remove-then-readd cycle doesn't duplicate (`clearContains`
                // resets `_containsAttestations` but never this flag).
                bytes32 parentUID = _parents[currentUID];
                if (parentUID != bytes32(0) && !_childInChildrenByAttester[parentUID][attester][currentUID]) {
                    _childrenByAttester[parentUID][attester].push(currentUID);
                    _childInChildrenByAttester[parentUID][attester][currentUID] = true;
                }

                currentUID = parentUID;
            }
        }
    }

    function _addReferencingSchema(bytes32 targetUID, bytes32 schemaUID) private {
        if (!_hasReferencingSchema[targetUID][schemaUID]) {
            _referencingSchemas[targetUID].push(schemaUID);
            _hasReferencingSchema[targetUID][schemaUID] = true;
        }
    }

    // ============================================================================================
    // PUBLIC GETTERS FOR KERNEL STATE
    // ============================================================================================

    function isRevoked(bytes32 uid) external view returns (bool) {
        return _isRevoked[uid];
    }

    function getParent(bytes32 anchorUID) external view returns (bytes32) {
        return _parents[anchorUID];
    }

    // ============================================================================================
    // PUBLIC INDEX API — opt-in indexing for external resolvers and third-party attestations
    // ============================================================================================

    /**
     * @notice Index an existing EAS attestation into the EFSIndexer discovery layer.
     *
     * Permissionless and idempotent. Callers are resolvers for schemas not registered with
     * EFSIndexer (e.g. EFSSortOverlay), or any third party who wants their attestations
     * discoverable via the standard query functions (getReferencingAttestations,
     * getAttestationsBySchema, getOutgoingAttestations, etc.).
     *
     * After indexing, the attestation is queryable via:
     *   - getReferencingAttestations(refUID, schema, ...)
     *   - getAttestationsBySchema(schema, ...)
     *   - getOutgoingAttestations(attester, schema, ...)
     *   - getIncomingAttestations(recipient, schema, ...)
     *   - containsAttestations / containsSchemaAttestations
     *   - getReferencingSchemas(refUID)
     *
     * Reverts if the UID does not exist in EAS (uid == bytes32(0) on the returned attestation).
     * Silently skips EFS-native schemas (ANCHOR, DATA, PROPERTY) — those are indexed
     * atomically in onAttest and must not be double-indexed.
     *
     * @param uid The attestation UID to index.
     * @return wasIndexed true if this call performed the indexing, false if already indexed.
     */
    function index(bytes32 uid) external returns (bool wasIndexed) {
        if (_indexed[uid]) return false;

        Attestation memory att = _eas.getAttestation(uid);
        if (att.uid == bytes32(0)) revert InvalidAttestation();

        // EFS-native schemas are indexed atomically in onAttest — skip them here.
        bytes32 schema = att.schema;
        IndexerConfig storage $ = _cfg();
        if (schema == $.anchorSchemaUID || schema == $.dataSchemaUID || schema == $.propertySchemaUID) {
            return false;
        }

        _indexed[uid] = true;
        _indexGlobal(att);

        // Mirror revocation state: if the attestation was already revoked in EAS when indexed,
        // mark it revoked now so callers don't need a separate indexRevocation() call.
        if (att.revocationTime != 0) {
            _isRevoked[uid] = true;
        }

        // Emit schema-specific events for off-chain indexers
        if (schema == MIRROR_SCHEMA_UID && !_isRevoked[uid]) {
            emit MirrorCreated(att.refUID, uid, att.attester);
        }

        emit AttestationIndexed(uid, schema, att.attester);
        return true;
    }

    /**
     * @notice Index a batch of attestation UIDs in a single call.
     *
     * Equivalent to calling index() on each UID. Already-indexed and EFS-native UIDs are
     * skipped without reverting. Reverts if any UID does not exist in EAS.
     *
     * @param uids Array of attestation UIDs to index.
     * @return count Number of UIDs newly indexed (excludes already-indexed and skipped).
     */
    function indexBatch(bytes32[] calldata uids) external returns (uint256 count) {
        IndexerConfig storage $ = _cfg();
        for (uint256 i = 0; i < uids.length; i++) {
            bytes32 uid = uids[i];
            if (_indexed[uid]) continue;

            Attestation memory att = _eas.getAttestation(uid);
            if (att.uid == bytes32(0)) revert InvalidAttestation();

            bytes32 schema = att.schema;
            if (schema == $.anchorSchemaUID || schema == $.dataSchemaUID || schema == $.propertySchemaUID) {
                continue;
            }

            _indexed[uid] = true;
            _indexGlobal(att);
            if (att.revocationTime != 0) {
                _isRevoked[uid] = true;
            }

            if (schema == MIRROR_SCHEMA_UID && !_isRevoked[uid]) {
                emit MirrorCreated(att.refUID, uid, att.attester);
            }
            emit AttestationIndexed(uid, schema, att.attester);
            count++;
        }
    }

    /**
     * @notice Sync a revocation for an externally-indexed attestation.
     *
     * Called by external resolvers (e.g. EFSSortOverlay.onRevoke) to mirror a revocation
     * into EFSIndexer's _isRevoked mapping. This ensures isRevoked() returns true for
     * externally-resolved attestations, making getSortStaleness and other revocation-aware
     * functions behave correctly across all schema types.
     *
     * Permissionless — anyone can call this for any attestation that has been revoked in EAS.
     * Reverts if the attestation has not actually been revoked in EAS (revocationTime == 0).
     * Reverts if the UID does not exist in EAS.
     * Idempotent — safe to call multiple times.
     *
     * @param uid The attestation UID whose revocation to sync.
     */
    function indexRevocation(bytes32 uid) external {
        Attestation memory att = _eas.getAttestation(uid);
        if (att.uid == bytes32(0)) revert InvalidAttestation();
        require(att.revocationTime != 0, "EFSIndexer: not revoked in EAS");

        if (!_isRevoked[uid]) {
            _isRevoked[uid] = true;
            emit RevocationIndexed(uid);
        }
    }

    /**
     * @notice Returns true if a UID was indexed via the public index() API.
     *         EFS-native attestations (indexed via onAttest) return false here —
     *         use isRevoked() or getReferencingAttestations() to check their state.
     *
     * @param uid The attestation UID to check.
     */
    function isIndexed(bytes32 uid) external view returns (bool) {
        return _indexed[uid];
    }
}
