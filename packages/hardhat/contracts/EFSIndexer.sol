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

    // State Variables
    bytes32 public rootAnchorUID;

    // Immutable Schema UIDs
    bytes32 public immutable ANCHOR_SCHEMA_UID;
    bytes32 public immutable PROPERTY_SCHEMA_UID;
    bytes32 public immutable DATA_SCHEMA_UID;
    bytes32 public immutable BLOB_SCHEMA_UID;
    bytes32 public immutable TAG_SCHEMA_UID;

    // O(1) Indexing Helpers
    struct IndexData {
        uint32 child;
        uint32 childSchema; // Index in _childrenBySchema
        uint32 ref;
        uint32 sent;
        uint32 rec;
        uint32 attester; // For _childrenByAttester
        uint32 typeFull;
        uint32 typeCat;
        uint32 schema; // For _schemaAttestations
        uint32 schemaAttester; // For _schemaAttesterAttestations
    }
    mapping(bytes32 => IndexData) private _uidIndices;

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

    // Tag Weights: targetUID => labelUID => weight
    mapping(bytes32 => mapping(bytes32 => int256)) private _tagWeights;

    // List of Schemas referencing a target: targetUID => schemaUIDs
    mapping(bytes32 => bytes32[]) private _referencingSchemas;
    // Helper to check existence: targetUID => schemaUID => exists
    mapping(bytes32 => mapping(bytes32 => bool)) private _hasReferencingSchema;

    // ============================================================================================
    // STORAGE: EDITIONS (APPEND-ONLY HISTORY)
    // ============================================================================================

    // Mappings to track full references (mimics EAS core indexer)
    mapping(bytes32 => bytes32[]) private _allReferencing;
    mapping(bytes32 => mapping(address => bytes32[])) private _referencingByAttester;
    mapping(bytes32 => mapping(bytes32 => mapping(address => bytes32[]))) private _referencingBySchemaAndAttester;

    // Specific mapping for fast lookups of Data payloads per user for subjective File content
    mapping(bytes32 => mapping(address => bytes32[])) private _dataAttestationsByAddress;

    constructor(
        IEAS eas,
        bytes32 anchorSchemaUID,
        bytes32 propertySchemaUID,
        bytes32 dataSchemaUID,
        bytes32 blobSchemaUID,
        bytes32 tagSchemaUID
    ) SchemaResolver(eas) {
        ANCHOR_SCHEMA_UID = anchorSchemaUID;
        PROPERTY_SCHEMA_UID = propertySchemaUID;
        DATA_SCHEMA_UID = dataSchemaUID;
        BLOB_SCHEMA_UID = blobSchemaUID;
        TAG_SCHEMA_UID = tagSchemaUID;
    }

    function onAttest(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        bytes32 schema = attestation.schema;

        // 1. GLOBAL INDEXING (ALL ATTESTATIONS)
        _schemaAttestations[schema].push(attestation.uid);
        _uidIndices[attestation.uid].schema = uint32(_schemaAttestations[schema].length);

        _schemaAttesterAttestations[schema][attestation.attester].push(attestation.uid);
        _uidIndices[attestation.uid].schemaAttester = uint32(
            _schemaAttesterAttestations[schema][attestation.attester].length
        );

        _sentAttestations[attestation.attester][schema].push(attestation.uid);
        _uidIndices[attestation.uid].sent = uint32(_sentAttestations[attestation.attester][schema].length);

        if (attestation.recipient != address(0)) {
            _receivedAttestations[attestation.recipient][schema].push(attestation.uid);
            _uidIndices[attestation.uid].rec = uint32(_receivedAttestations[attestation.recipient][schema].length);
        }

        if (attestation.refUID != EMPTY_UID) {
            _referencingAttestations[attestation.refUID][schema].push(attestation.uid);
            _uidIndices[attestation.uid].ref = uint32(_referencingAttestations[attestation.refUID][schema].length);
            _addReferencingSchema(attestation.refUID, schema);

            // Perspective Mappings (Append-only history, no swap-and-pop)
            _allReferencing[attestation.refUID].push(attestation.uid);
            _referencingByAttester[attestation.refUID][attestation.attester].push(attestation.uid);
            _referencingBySchemaAndAttester[attestation.refUID][schema][attestation.attester].push(attestation.uid);
        }

        // 2. EFS CORE LOGIC (ANCHORS)
        if (schema == ANCHOR_SCHEMA_UID) {
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
                    // If no parent, it must be the root itself (already handled by rootAnchorUID logic mostly, but let's be strict)
                    if (attestation.uid != rootAnchorUID) {
                        revert MissingParent();
                    }
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
            _uidIndices[attestation.uid].child = uint32(_children[parentUID].length);

            // Hierarchy Index (By Schema)
            _childrenBySchema[parentUID][anchorSchema].push(attestation.uid);
            _uidIndices[attestation.uid].childSchema = uint32(_childrenBySchema[parentUID][anchorSchema].length);

            _parents[attestation.uid] = parentUID;

            // Attester Index (My Files)
            _childrenByAttester[parentUID][attestation.attester].push(attestation.uid);
            _uidIndices[attestation.uid].attester = uint32(_childrenByAttester[parentUID][attestation.attester].length);

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

            return true;
        } else if (schema == TAG_SCHEMA_UID) {
            // Encode: (bytes32 labelUID, int256 weight)
            (, int256 weight) = abi.decode(attestation.data, (bytes32, int256));

            // Crowd Source: Aggregate weight
            (bytes32 labelUID, ) = abi.decode(attestation.data, (bytes32, int256));
            _tagWeights[attestation.refUID][labelUID] += weight;

            return true;
        }

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        bytes32 schema = attestation.schema;

        // 1. CLEANUP GLOBAL INDICES
        _removeSchemaAttestation(_schemaAttestations[schema], attestation.uid);
        _removeSchemaAttesterAttestation(_schemaAttesterAttestations[schema][attestation.attester], attestation.uid);
        _removeSent(_sentAttestations[attestation.attester][schema], attestation.uid);

        if (attestation.recipient != address(0)) {
            _removeReceived(_receivedAttestations[attestation.recipient][schema], attestation.uid);
        }

        if (attestation.refUID != EMPTY_UID) {
            _removeRef(_referencingAttestations[attestation.refUID][schema], attestation.uid);
            _removeReferencingSchema(attestation.refUID, schema);
        }

        // 2. CLEANUP EFS SPECIFIC
        if (schema == ANCHOR_SCHEMA_UID) {
            (string memory name, bytes32 anchorSchema) = abi.decode(attestation.data, (string, bytes32));

            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }

            if (parentUID != EMPTY_UID) {
                _removeChild(_children[parentUID], attestation.uid);
                _removeChildSchema(_childrenBySchema[parentUID][anchorSchema], attestation.uid);
            }

            if (_nameToAnchor[parentUID][name][anchorSchema] == attestation.uid) {
                delete _nameToAnchor[parentUID][name][anchorSchema];
            }

            _removeAttester(_childrenByAttester[parentUID][attestation.attester], attestation.uid);
        } else if (schema == DATA_SCHEMA_UID) {
            bytes32 anchorUID = attestation.refUID;
            if (anchorUID != EMPTY_UID) {
                bytes32 parentUID = _parents[anchorUID];
                if (parentUID != bytes32(0)) {
                    (, string memory contentType, ) = abi.decode(attestation.data, (string, string, string));

                    if (bytes(contentType).length > 0) {
                        bytes32 fullHash = keccak256(abi.encodePacked(contentType));
                        _removeType(_childrenByType[parentUID][fullHash], anchorUID, true);

                        bytes memory mimeBytes = bytes(contentType);
                        for (uint i = 0; i < mimeBytes.length; i++) {
                            if (mimeBytes[i] == 0x2f) {
                                bytes memory category = new bytes(i);
                                for (uint j = 0; j < i; j++) {
                                    category[j] = mimeBytes[j];
                                }
                                bytes32 catHash = keccak256(category);
                                _removeType(_childrenByType[parentUID][catHash], anchorUID, false);
                                break;
                            }
                        }
                    }
                }
            }
        } else if (schema == TAG_SCHEMA_UID) {
            (bytes32 labelUID, int256 weight) = abi.decode(attestation.data, (bytes32, int256));
            _tagWeights[attestation.refUID][labelUID] -= weight;
        }

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
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_children[anchorUID], start, length, reverseOrder);
    }

    function getChildrenCount(bytes32 anchorUID) external view returns (uint256) {
        return _children[anchorUID].length;
    }

    function getChildrenByType(
        bytes32 anchorUID,
        string memory mimeType,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return
            _sliceUIDs(_childrenByType[anchorUID][keccak256(abi.encodePacked(mimeType))], start, length, reverseOrder);
    }

    function getChildrenByAttester(
        bytes32 anchorUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenByAttester[anchorUID][attester], start, length, reverseOrder);
    }

    function getAnchorsBySchema(
        bytes32 anchorUID,
        bytes32 schema,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenBySchema[anchorUID][schema], start, length, reverseOrder);
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
    // READ FUNCTIONS: PERSPECTIVES (Address-Based Queries & History)
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
            
            if (showRevoked || _eas.getAttestation(uid).revocationTime == 0) {
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
    function getDataByAddressList(bytes32 anchorUID, address[] calldata attesters, bool showRevoked) external view returns (bytes32) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        address[] memory addressesToCheck = attesters;

        for (uint256 i = 0; i < addressesToCheck.length; i++) {
            bytes32[] storage userHistory = _dataAttestationsByAddress[anchorUID][addressesToCheck[i]];
            if (userHistory.length > 0) {
                // Loop backwards to find the most recent valid one
                for (uint256 j = userHistory.length; j > 0; j--) {
                    bytes32 uid = userHistory[j - 1];
                    if (showRevoked || _eas.getAttestation(uid).revocationTime == 0) {
                        return uid; // Win condition
                    }
                }
            }
        }

        return bytes32(0);
    }

    // --- Directory Perspectives (ANCHOR Schema) ---

    // Round-Robin pagination merging files from multiple users in a directory
    // cursor format: (userIndex << 128) | itemIndex
    function getChildrenByAddressList(
        bytes32 parentUID,
        address[] calldata attesters,
        uint256 startingCursor,
        uint256 pageSize,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory results, uint256 nextCursor) {
        require(attesters.length > 0, "Attesters list cannot be empty");
        address[] memory addressesToCheck = attesters;

        uint256 userCount = addressesToCheck.length;
        uint256[] memory currentIndices = new uint256[](userCount);
        bool[] memory userExhausted = new bool[](userCount);
        uint256 exhaustedCount = 0;

        uint256 startingUserIdx = 0;

        // Decode O(1) cursor if provided
        if (startingCursor != 0) {
            uint256 cursorUserIdx = startingCursor >> 128; // Top 128 bits
            uint256 cursorItemIdx = startingCursor & ((1 << 128) - 1); // Bottom 128 bits
            
            if (cursorUserIdx < userCount) {
                // Reconstruct exactly where each user was based on the cursor
                // We know exactly how many items we processed from each user to get to this point
                
                for (uint256 i = 0; i < userCount; i++) {
                    if (i <= cursorUserIdx) {
                        currentIndices[i] = cursorItemIdx + 1;
                    } else {
                        currentIndices[i] = cursorItemIdx;
                    }
                }
                startingUserIdx = (cursorUserIdx + 1) % userCount;
            }
        }

        // Pre-check for already exhausted lists based on indices
        for (uint256 i = 0; i < userCount; i++) {
             if (currentIndices[i] >= _childrenByAttester[parentUID][addressesToCheck[i]].length) {
                 userExhausted[i] = true;
                 exhaustedCount++;
             }
        }



        // Now, collect results
        bytes32[] memory tempResults = new bytes32[](pageSize);
        uint256 resultCount = 0;
        uint256 currentUser = startingUserIdx;
        uint256 finalCursor = 0;

        while (resultCount < pageSize && exhaustedCount < userCount) {
            if (!userExhausted[currentUser]) {
                bytes32[] storage userList = _childrenByAttester[parentUID][addressesToCheck[currentUser]];
                uint256 listLen = userList.length;
                uint256 relIdx = currentIndices[currentUser]; // Number of items processed from this list

                // Loop until we find a valid item or exhaust the list
                bool validItemFound = false;
                while (relIdx < listLen && !validItemFound) {
                    uint256 actualIdx = reverseOrder ? listLen - 1 - relIdx : relIdx;
                    bytes32 candidateUID = userList[actualIdx];
                    
                    if (showRevoked || _eas.getAttestation(candidateUID).revocationTime == 0) {
                        tempResults[resultCount++] = candidateUID;
                        // Pack cursor as (userIndex << 128) | relIdx
                        finalCursor = (currentUser << 128) | relIdx;
                        validItemFound = true;
                    }
                    relIdx++; // Look at next item next time
                }

                currentIndices[currentUser] = relIdx; // Save progress
                if (relIdx >= listLen) {
                    userExhausted[currentUser] = true;
                    exhaustedCount++;
                }
            }

            currentUser = (currentUser + 1) % userCount;
        }

        // Trim results
        bytes32[] memory finalResults = new bytes32[](resultCount);
        for (uint256 i = 0; i < resultCount; i++) {
            finalResults[i] = tempResults[i];
        }

        // If we hit the end, return 0 for the cursor
        if (exhaustedCount == userCount) {
            finalCursor = 0;
        }

        return (finalResults, finalCursor);
    }

    function getTagWeight(bytes32 targetUID, bytes32 labelUID) external view returns (int256) {
        return _tagWeights[targetUID][labelUID];
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

    function getReferencingBySchemaAndAttesterCount(bytes32 targetUID, bytes32 schemaUID, address attester) external view returns (uint256) {
        return _referencingBySchemaAndAttester[targetUID][schemaUID][attester].length;
    }

    // ============================================================================================
    // INTERNAL HELPERS
    // ============================================================================================

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
            revert InvalidOffset();
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

    // O(1) REMOVAL HELPERS

    // Note: The _swapPop method was removed as it was unused dead code.

    function _removeChild(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].child;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];

        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].child = index;
        }
        delete _uidIndices[uid].child;
    }

    function _removeChildSchema(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].childSchema;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];

        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].childSchema = index;
        }
        delete _uidIndices[uid].childSchema;
    }

    function _removeSchemaAttestation(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].schema;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].schema = index;
        }
        delete _uidIndices[uid].schema;
    }

    function _removeSchemaAttesterAttestation(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].schemaAttester;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].schemaAttester = index;
        }
        delete _uidIndices[uid].schemaAttester;
    }

    function _removeRef(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].ref;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].ref = index;
        }
        delete _uidIndices[uid].ref;
    }

    function _removeSent(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].sent;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].sent = index;
        }
        delete _uidIndices[uid].sent;
    }

    function _removeReceived(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].rec;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].rec = index;
        }
        delete _uidIndices[uid].rec;
    }

    function _removeAttester(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].attester;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            _uidIndices[lastUID].attester = index;
        }
        delete _uidIndices[uid].attester;
    }

    function _removeType(bytes32[] storage array, bytes32 uid, bool isFull) private {
        uint32 index = isFull ? _uidIndices[uid].typeFull : _uidIndices[uid].typeCat;
        if (index == 0) return;

        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        array[idx] = lastUID;
        array.pop();

        if (lastUID != uid) {
            if (isFull) _uidIndices[lastUID].typeFull = index;
            else _uidIndices[lastUID].typeCat = index;
        }
        if (isFull) delete _uidIndices[uid].typeFull;
        else delete _uidIndices[uid].typeCat;
    }

    function _indexMimeType(bytes32 parentUID, bytes32 attestationUID, bytes memory data) private {
        (, string memory contentType, string memory fileMode) = abi.decode(data, (string, string, string));
        if (keccak256(bytes(fileMode)) == TOMBSTONE_HASH) {
            return;
        }

        if (bytes(contentType).length > 0) {
            bytes32 fullHash = keccak256(abi.encodePacked(contentType));
            _childrenByType[parentUID][fullHash].push(attestationUID);
            _uidIndices[attestationUID].typeFull = uint32(_childrenByType[parentUID][fullHash].length);

            bytes memory mimeBytes = bytes(contentType);
            for (uint i = 0; i < mimeBytes.length; i++) {
                if (mimeBytes[i] == 0x2f) {
                    // "/"
                    bytes memory category = new bytes(i);
                    for (uint j = 0; j < i; j++) {
                        category[j] = mimeBytes[j];
                    }
                    bytes32 catHash = keccak256(category);
                    _childrenByType[parentUID][catHash].push(attestationUID);
                    _uidIndices[attestationUID].typeCat = uint32(_childrenByType[parentUID][catHash].length);
                    break;
                }
            }
        }
    }

    function _addReferencingSchema(bytes32 targetUID, bytes32 schemaUID) private {
        if (!_hasReferencingSchema[targetUID][schemaUID]) {
            _referencingSchemas[targetUID].push(schemaUID);
            _hasReferencingSchema[targetUID][schemaUID] = true;
        }
    }

    function _removeReferencingSchema(bytes32 targetUID, bytes32 schemaUID) private {
        if (_referencingAttestations[targetUID][schemaUID].length == 0) {
            bytes32[] storage array = _referencingSchemas[targetUID];
            for (uint256 i = 0; i < array.length; i++) {
                if (array[i] == schemaUID) {
                    array[i] = array[array.length - 1];
                    array.pop();
                    break;
                }
            }
            _hasReferencingSchema[targetUID][schemaUID] = false;
        }
    }
}
