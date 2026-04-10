// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { EMPTY_UID } from "@ethereum-attestation-service/eas-contracts/contracts/Common.sol";

contract EFSIndexer is SchemaResolver {
    error DuplicateFileName();
    error InvalidOffset();
    error MissingParent();
    error InvalidAttestation();
    error AlreadyIndexed();

    /// @notice Emitted when a new Anchor is created under a parent directory.
    ///         Enables off-chain indexers (The Graph) to track directory structure changes
    ///         without scanning all EAS Attested events.
    event AnchorCreated(
        bytes32 indexed parentUID,
        bytes32 indexed anchorUID,
        address indexed attester,
        bytes32 anchorSchema
    );

    /// @notice Emitted when a DATA attestation is attached to an Anchor (new file edition).
    event DataCreated(bytes32 indexed anchorUID, bytes32 indexed dataUID, address indexed attester);

    /// @notice Emitted when a PROPERTY attestation is attached to an Anchor.
    event PropertyCreated(bytes32 indexed anchorUID, bytes32 indexed propertyUID, address indexed attester);

    /// @notice Emitted when any EFS-native attestation (ANCHOR, DATA, PROPERTY, BLOB) is revoked.
    event AttestationRevoked(bytes32 indexed uid, address indexed attester);

    /// @notice Emitted when an external attestation is indexed via the public index() API.
    event AttestationIndexed(bytes32 indexed uid, bytes32 indexed schema, address indexed attester);

    /// @notice Emitted when a revocation is synced for an externally-indexed attestation.
    event RevocationIndexed(bytes32 indexed uid);

    // State Variables
    bytes32 public rootAnchorUID;

    // Immutable Schema UIDs (set at construction, resolver = EFSIndexer)
    bytes32 public immutable ANCHOR_SCHEMA_UID;
    bytes32 public immutable PROPERTY_SCHEMA_UID;
    bytes32 public immutable DATA_SCHEMA_UID;
    bytes32 public immutable BLOB_SCHEMA_UID;

    // Partner contract references — set once via wireContracts() after full deployment
    // These are bytes32 storage (not immutable) because partner contracts deploy after EFSIndexer.
    bytes32 public TAG_SCHEMA_UID;
    bytes32 public SORT_INFO_SCHEMA_UID;
    address public tagResolver;
    address public sortOverlay;
    address public schemaRegistry;

    // Well-known /sorts/ anchor — set once via setSortsAnchor() after deployment
    bytes32 public sortsAnchorUID;

    // Deployer — authorized to call wireContracts()
    address public immutable DEPLOYER;

    // Revocation tracking (set in onRevoke, never cleared)
    mapping(bytes32 => bool) private _isRevoked;

    // External index tracking — UIDs indexed via the public index() API (not via onAttest)
    mapping(bytes32 => bool) private _indexed;

    bytes32 private constant TOMBSTONE_HASH = keccak256("tombstone");

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

    // Type Index: parentAnchorUID => mimeHash => childAnchorUIDs
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _childrenByType;

    // Attester Index: parentAnchorUID => attester => childAnchorUIDs
    mapping(bytes32 => mapping(address => bytes32[])) private _childrenByAttester;

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
    // STORAGE: EDITIONS (APPEND-ONLY HISTORY)
    // ============================================================================================
    // These mappings are append-only. Revocations do NOT remove entries from these arrays.
    // This preserves the full edit history and allows clients to filter by showRevoked.
    mapping(bytes32 => bytes32[]) private _allReferencing;
    mapping(bytes32 => mapping(address => bytes32[])) private _referencingByAttester;
    mapping(bytes32 => mapping(bytes32 => mapping(address => bytes32[]))) private _referencingBySchemaAndAttester;

    // Specific mapping for fast lookups of Data payloads per user for subjective File content
    mapping(bytes32 => mapping(address => bytes32[])) private _dataAttestationsByAddress;

    // Edition Activity Trackers
    // NOTE: These flags are SET-ONLY and never cleared on revocation.
    // `_containsAttestations[uid][attester]` means "attester has EVER contributed under this anchor",
    // not "attester currently has active/unrevoked data here". This is intentional:
    //   - Clearing on revoke would require expensive decrement logic on every revocation
    //   - The UI handles revoked content correctly via getDataByAddressList filtering
    //   - The early-break optimization in the recursive loop depends on monotonic set-only behavior
    mapping(bytes32 => mapping(address => bool)) private _containsAttestations;
    mapping(bytes32 => mapping(address => mapping(bytes32 => bool))) private _containsSchemaAttestations;

    constructor(
        IEAS eas,
        bytes32 anchorSchemaUID,
        bytes32 propertySchemaUID,
        bytes32 dataSchemaUID,
        bytes32 blobSchemaUID
    ) SchemaResolver(eas) {
        ANCHOR_SCHEMA_UID = anchorSchemaUID;
        PROPERTY_SCHEMA_UID = propertySchemaUID;
        DATA_SCHEMA_UID = dataSchemaUID;
        BLOB_SCHEMA_UID = blobSchemaUID;
        DEPLOYER = msg.sender;
    }

    /**
     * @notice Wire partner contracts after full deployment.
     *         Call once from the deploy script after TagResolver and EFSSortOverlay are deployed.
     *         After calling, TAG_SCHEMA_UID, SORT_INFO_SCHEMA_UID, tagResolver, sortOverlay,
     *         and schemaRegistry are all queryable from a single entry point (this contract).
     * @dev Can only be called by DEPLOYER and only once (tagResolver address guards re-entry).
     */
    function wireContracts(
        address _tagResolver,
        bytes32 _tagSchemaUID,
        address _sortOverlay,
        bytes32 _sortInfoSchemaUID,
        address _schemaRegistry
    ) external {
        require(msg.sender == DEPLOYER, "EFSIndexer: not deployer");
        require(tagResolver == address(0), "EFSIndexer: already wired");
        tagResolver = _tagResolver;
        TAG_SCHEMA_UID = _tagSchemaUID;
        sortOverlay = _sortOverlay;
        SORT_INFO_SCHEMA_UID = _sortInfoSchemaUID;
        schemaRegistry = _schemaRegistry;
    }

    /**
     * @notice Set the well-known /sorts/ anchor UID.
     *         Called once from the deploy script after the sorts anchor is created.
     * @dev Can only be called by DEPLOYER and only once.
     */
    function setSortsAnchor(bytes32 _sortsAnchorUID) external {
        require(msg.sender == DEPLOYER, "EFSIndexer: not deployer");
        require(sortsAnchorUID == bytes32(0), "EFSIndexer: sorts anchor already set");
        sortsAnchorUID = _sortsAnchorUID;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        // 1. GLOBAL INDEXING (ALL ATTESTATIONS)
        _indexGlobal(attestation);

        // 2. EFS CORE LOGIC (ANCHORS)
        bytes32 schema = attestation.schema;
        if (schema == ANCHOR_SCHEMA_UID) {
            // Anchors are permanent structural nodes — revocable anchors are rejected.
            if (attestation.revocable) return false;

            (string memory name, bytes32 anchorSchema) = abi.decode(attestation.data, (string, bytes32));

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

            // Write Directory
            _nameToAnchor[parentUID][name][anchorSchema] = attestation.uid;

            // Hierarchy Index (All Children)
            _children[parentUID].push(attestation.uid);

            // Hierarchy Index (By Schema)
            _childrenBySchema[parentUID][anchorSchema].push(attestation.uid);

            _parents[attestation.uid] = parentUID;

            // Attester Index (My Files)
            // Note: Since _childrenByAttester is now natively tracking collaborative interactions deeply via the recursion loop above,
            // we only push to it here IF it's the very first time this creator has interacted with this parent, to prevent duplicates.
            if (!_containsAttestations[attestation.uid][attestation.attester]) {
                _containsAttestations[attestation.uid][attestation.attester] = true;
                if (parentUID != bytes32(0)) {
                    _childrenByAttester[parentUID][attestation.attester].push(attestation.uid);
                }
            }

            emit AnchorCreated(parentUID, attestation.uid, attestation.attester, anchorSchema);
            return true;
        } else if (schema == DATA_SCHEMA_UID) {
            // VALIDATION: Check refUID is a valid Anchor AND matches DATA_SCHEMA constraint
            if (attestation.refUID == EMPTY_UID) return false;

            Attestation memory target = _eas.getAttestation(attestation.refUID);
            if (target.schema != ANCHOR_SCHEMA_UID) return false;

            // Enforce that the attributes/data are attached to a FILE ANCHOR (schema == DATA_SCHEMA_UID)
            // Decode the anchor to check its type? No, we don't have the data decoded.
            // BUT we can check _nameToAnchor? No, we have the UID.
            // We need to know the schema of the Anchor.
            // We can decode the target.data.
            (, bytes32 targetAnchorSchema) = abi.decode(target.data, (string, bytes32));
            if (targetAnchorSchema != DATA_SCHEMA_UID) {
                return false; // Files must be attached to Data Anchors
            }

            // Index MimeType
            bytes32 parentUID = _parents[attestation.refUID];
            if (parentUID != bytes32(0)) {
                _indexMimeType(parentUID, attestation.refUID, attestation.data);
            }

            // Index File Content Perspectives (Append-only by design, not deleted in onRevoke)
            _dataAttestationsByAddress[attestation.refUID][attestation.attester].push(attestation.uid);

            emit DataCreated(attestation.refUID, attestation.uid, attestation.attester);
            return true;
        } else if (schema == PROPERTY_SCHEMA_UID) {
            // VALIDATION: Check refUID is a valid Anchor AND matches PROPERTY_SCHEMA constraint
            if (attestation.refUID == EMPTY_UID) return false;

            Attestation memory target = _eas.getAttestation(attestation.refUID);
            if (target.schema != ANCHOR_SCHEMA_UID) return false;

            // Enforce that properties are attached to PROPERTY ANCHORS
            (, bytes32 targetAnchorSchema) = abi.decode(target.data, (string, bytes32));
            // Optimization: If property anchor schema is 0 (generic), we might allow properties on generic anchors?
            // User plan said: "Properties must verify their parent Anchor has schema == PROPERTY_SCHEMA"
            if (targetAnchorSchema != PROPERTY_SCHEMA_UID) {
                return false;
            }

            // Ensure Anchor is valid (has parent or recipient)
            if (target.refUID == EMPTY_UID && target.recipient == address(0)) {
                return false; // Floating anchor
            }

            emit PropertyCreated(attestation.refUID, attestation.uid, attestation.attester);
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

    function getChildrenByType(
        bytes32 anchorUID,
        string memory mimeType,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory) {
        return
            _sliceUIDsFiltered(
                _childrenByType[anchorUID][keccak256(abi.encodePacked(mimeType))],
                start,
                length,
                reverseOrder,
                showRevoked
            );
    }

    /// @notice Convenience overload — showRevoked defaults to false.
    function getChildrenByType(
        bytes32 anchorUID,
        string memory mimeType,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return
            _sliceUIDsFiltered(
                _childrenByType[anchorUID][keccak256(abi.encodePacked(mimeType))],
                start,
                length,
                reverseOrder,
                false
            );
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
    // READ FUNCTIONS: EDITIONS (Address-Based Queries & History)
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

    // --- File Content Perspectives (DATA Schema) ---

    // Standard pagination for a single user's edits
    // Returns results and the nextStart cursor for subsequent pages. If nextStart is 0, the end is reached.
    function getDataHistoryByAddress(
        bytes32 anchorUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextStart) {
        bytes32[] storage allEdits = _dataAttestationsByAddress[anchorUID][attester];
        uint256 totalLen = allEdits.length;

        if (start >= totalLen || length == 0) {
            return (new bytes32[](0), 0);
        }

        bytes32[] memory tempResults = new bytes32[](length);
        uint256 count = 0;
        uint256 currentIndex = start;

        while (count < length && currentIndex < totalLen) {
            uint256 actualIdx = reverseOrder ? totalLen - 1 - currentIndex : currentIndex;
            bytes32 uid = allEdits[actualIdx];

            if (showRevoked || !_isRevoked[uid]) {
                tempResults[count++] = uid;
            }
            currentIndex++;
        }

        bytes32[] memory finalResults = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            finalResults[i] = tempResults[i];
        }

        // If we hit the end of the array, return 0 for nextStart
        uint256 next = currentIndex >= totalLen ? 0 : currentIndex;
        return (finalResults, next);
    }

    // Subjective lookup combining multiple trusted addresses into a final single data UID return value
    function getDataByAddressList(
        bytes32 anchorUID,
        address[] calldata attesters,
        bool showRevoked
    ) external view returns (bytes32) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        address[] memory addressesToCheck = attesters;

        for (uint256 i = 0; i < addressesToCheck.length; i++) {
            bytes32[] storage userHistory = _dataAttestationsByAddress[anchorUID][addressesToCheck[i]];
            if (userHistory.length > 0) {
                // Loop backwards to find the most recent valid one
                for (uint256 j = userHistory.length; j > 0; j--) {
                    bytes32 uid = userHistory[j - 1];
                    if (showRevoked || !_isRevoked[uid]) {
                        return uid; // Win condition
                    }
                }
            }
        }

        return bytes32(0);
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

    function getEAS() external view returns (IEAS) {
        return _eas;
    }

    function getDataHistoryCountByAddress(bytes32 anchorUID, address attester) external view returns (uint256) {
        return _dataAttestationsByAddress[anchorUID][attester].length;
    }

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

    /// @notice Unfiltered slice — used by generic explorer functions that don't need revocation filtering.
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

        bytes32[] memory res = new bytes32[](count);
        for (uint256 i = 0; i < count; i++) {
            res[i] = temp[i];
        }
        return res;
    }

    function _indexMimeType(bytes32 parentUID, bytes32 attestationUID, bytes memory data) private {
        (, string memory contentType, string memory fileMode) = abi.decode(data, (string, string, string));
        if (keccak256(bytes(fileMode)) == TOMBSTONE_HASH) {
            return;
        }

        if (bytes(contentType).length > 0) {
            bytes32 fullHash = keccak256(abi.encodePacked(contentType));
            _childrenByType[parentUID][fullHash].push(attestationUID);

            bytes memory mimeBytes = bytes(contentType);
            for (uint i = 0; i < mimeBytes.length; i++) {
                if (mimeBytes[i] == 0x2f) {
                    bytes memory category = new bytes(i);
                    for (uint j = 0; j < i; j++) {
                        category[j] = mimeBytes[j];
                    }
                    bytes32 catHash = keccak256(category);
                    _childrenByType[parentUID][catHash].push(attestationUID);
                    break;
                }
            }
        }
    }

    /// @dev Core indexing logic shared by onAttest and the public index() API.
    ///      Writes all generic discovery indices: schema, attester, sent, received,
    ///      referencing, and the upward _childrenByAttester propagation chain.
    ///      Does NOT run EFS-specific logic (Anchor tree, DATA content, Property validation).
    function _indexGlobal(Attestation memory attestation) private {
        bytes32 schema = attestation.schema;

        _schemaAttestations[schema].push(attestation.uid);
        _schemaAttesterAttestations[schema][attestation.attester].push(attestation.uid);
        _sentAttestations[attestation.attester][schema].push(attestation.uid);

        if (attestation.recipient != address(0)) {
            _receivedAttestations[attestation.recipient][schema].push(attestation.uid);
        }

        if (attestation.refUID != EMPTY_UID) {
            _referencingAttestations[attestation.refUID][schema].push(attestation.uid);
            _addReferencingSchema(attestation.refUID, schema);

            _allReferencing[attestation.refUID].push(attestation.uid);
            _referencingByAttester[attestation.refUID][attestation.attester].push(attestation.uid);
            _referencingBySchemaAndAttester[attestation.refUID][schema][attestation.attester].push(attestation.uid);

            // Edition Mappings (Recursive upward propagation for Folder Visibility)
            // This loop walks the _parents chain from attestation.refUID to root, marking each
            // ancestor as "containing activity by this attester". It also pushes each ancestor
            // into its parent's _childrenByAttester, so edition-filtered directory listings
            // transitively include intermediate folders that contain the attester's work.
            //
            // Example: User2 attests DATA on /pets/cats/fluffy.png
            //   → _childrenByAttester[catsUID][user2]  gets fluffy.png's anchor
            //   → _childrenByAttester[petsUID][user2]  gets catsUID
            //   → _childrenByAttester[rootUID][user2]  gets petsUID
            // This enables getChildrenByAddressList to show the full navigable tree for each user.
            bytes32 currentUID = attestation.refUID;

            // Set specific schema interaction on the direct target only (not recursively)
            if (!_containsSchemaAttestations[currentUID][attestation.attester][schema]) {
                _containsSchemaAttestations[currentUID][attestation.attester][schema] = true;
            }

            // Propagate generic "active in this structure" flag all the way up the tree
            while (currentUID != bytes32(0)) {
                // If this level is already flagged true, the rest of the chain above it must be too.
                // Break early to save gas (amortized O(1) for repeat contributions by same user).
                if (_containsAttestations[currentUID][attestation.attester]) {
                    break;
                }

                _containsAttestations[currentUID][attestation.attester] = true;

                // Drive the structural index: push this child into the parent's Edition array
                bytes32 parentUID = _parents[currentUID];
                if (parentUID != bytes32(0)) {
                    _childrenByAttester[parentUID][attestation.attester].push(currentUID);
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
     * Silently skips EFS-native schemas (ANCHOR, DATA, PROPERTY, BLOB) — those are indexed
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
        if (
            schema == ANCHOR_SCHEMA_UID ||
            schema == DATA_SCHEMA_UID ||
            schema == PROPERTY_SCHEMA_UID ||
            schema == BLOB_SCHEMA_UID
        ) {
            return false;
        }

        _indexed[uid] = true;
        _indexGlobal(att);

        // Mirror revocation state: if the attestation was already revoked in EAS when indexed,
        // mark it revoked now so callers don't need a separate indexRevocation() call.
        if (att.revocationTime != 0) {
            _isRevoked[uid] = true;
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
        for (uint256 i = 0; i < uids.length; i++) {
            bytes32 uid = uids[i];
            if (_indexed[uid]) continue;

            Attestation memory att = _eas.getAttestation(uid);
            if (att.uid == bytes32(0)) revert InvalidAttestation();

            bytes32 schema = att.schema;
            if (
                schema == ANCHOR_SCHEMA_UID ||
                schema == DATA_SCHEMA_UID ||
                schema == PROPERTY_SCHEMA_UID ||
                schema == BLOB_SCHEMA_UID
            ) {
                continue;
            }

            _indexed[uid] = true;
            _indexGlobal(att);
            if (att.revocationTime != 0) {
                _isRevoked[uid] = true;
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
