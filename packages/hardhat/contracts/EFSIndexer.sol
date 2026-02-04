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
        uint32 ref;
        uint32 sent;
        uint32 rec;
        uint32 attester; // For _childrenByAttester
        uint32 typeFull;
        uint32 typeCat;
        uint32 schema;   // For _schemaAttestations
        uint32 schemaAttester; // For _schemaAttesterAttestations
    }
    mapping(bytes32 => IndexData) private _uidIndices;

    // ============================================================================================
    // STORAGE: FILE SYSTEM INDICES (EFS CORE)
    // ============================================================================================

    // Directory Index (Path Resolution): parentAnchorUID => name => childAnchorUID
    // Renamed from _directory for clarity
    mapping(bytes32 => mapping(string => bytes32)) private _nameToAnchor;

    // Hierarchy List: parentAnchorUID => childAnchorUIDs
    mapping(bytes32 => bytes32[]) private _children;

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

    // User Schema Index: attester => schemaUID => attestationUIDs (Note: distinct from _sentAttestations which is same structure. 
    // The plan asks for: mapping(address attester => mapping(bytes32 schemaUID => bytes32[] uids)) called "User Schema Index".
    // _sentAttestations already exists with this signature. I will use _sentAttestations for this.)
    mapping(address => mapping(bytes32 => bytes32[])) private _sentAttestations;

    // User Schema Specific Index (for efficient "Sort by User" on a schema): schemaUID => attester => attestationUIDs
    // Plan asked for: getAttestationsBySchemaAndAttester. This maps to:
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
        _uidIndices[attestation.uid].schemaAttester = uint32(_schemaAttesterAttestations[schema][attestation.attester].length);

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
        }

        // 2. EFS CORE LOGIC (ANCHORS)
        if (schema == ANCHOR_SCHEMA_UID) {
            string memory name = abi.decode(attestation.data, (string));
            
            // Resolve Parent (Use refUID, else recipient cast to bytes32, else generic root if 0)
            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }
            
            // ROOT ANCHOR LOGIC
            if (rootAnchorUID == bytes32(0)) {
                rootAnchorUID = attestation.uid;
            } else {
                if (parentUID == bytes32(0)) {
                    if (attestation.uid != rootAnchorUID) {
                        revert MissingParent();
                    }
                }
            }
                
            // Validation: Enforce unique filenames O(1)
            if (_nameToAnchor[parentUID][name] != bytes32(0)) {
                revert DuplicateFileName();
            }

            // Write Directory
            _nameToAnchor[parentUID][name] = attestation.uid;
            
            // Hierarchy Index
            _children[parentUID].push(attestation.uid);
            _uidIndices[attestation.uid].child = uint32(_children[parentUID].length);
            
            _parents[attestation.uid] = parentUID;
            
            // Attester Index (My Files)
            _childrenByAttester[parentUID][attestation.attester].push(attestation.uid);
            _uidIndices[attestation.uid].attester = uint32(_childrenByAttester[parentUID][attestation.attester].length);

            return true;

        } else if (schema == DATA_SCHEMA_UID) {
            // VALIDATION: Check refUID is a valid Anchor
            if (attestation.refUID == EMPTY_UID) {
                 return false; 
            }
            Attestation memory target = _eas.getAttestation(attestation.refUID);
            if (target.schema != ANCHOR_SCHEMA_UID) {
                return false; // Must be attached to an Anchor
            }

            // Index MimeType
            bytes32 parentUID = _parents[attestation.refUID];
            if (parentUID != bytes32(0)) {
                _indexMimeType(parentUID, attestation.refUID, attestation.data);
            }
            return true;
        } else if (schema == PROPERTY_SCHEMA_UID) {
             // VALIDATION: Check refUID is a valid Anchor
            if (attestation.refUID == EMPTY_UID) {
                 return false; 
            }
            Attestation memory target = _eas.getAttestation(attestation.refUID);
            if (target.schema != ANCHOR_SCHEMA_UID) {
                return false; // Must be attached to an Anchor
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
            string memory name = abi.decode(attestation.data, (string));
            
            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }
            
            if (parentUID != EMPTY_UID) {
                _removeChild(_children[parentUID], attestation.uid);
            }

            if (_nameToAnchor[parentUID][name] == attestation.uid) {
                delete _nameToAnchor[parentUID][name];
            }

            _removeAttester(_childrenByAttester[parentUID][attestation.attester], attestation.uid);
            
        } else if (schema == DATA_SCHEMA_UID) {
             bytes32 anchorUID = attestation.refUID;
             if (anchorUID != EMPTY_UID) {
                 bytes32 parentUID = _parents[anchorUID];
                 if (parentUID != bytes32(0)) {
                    (bytes32 blobUID, ) = abi.decode(attestation.data, (bytes32, string));
                    Attestation memory blobAttestation = _eas.getAttestation(blobUID);
                    if (blobAttestation.uid != bytes32(0)) {
                         (string memory mimeType, , ) = abi.decode(blobAttestation.data, (string, uint8, bytes));
                         bytes32 fullHash = keccak256(abi.encodePacked(mimeType));
                         _removeType(_childrenByType[parentUID][fullHash], anchorUID, true);
        
                         bytes memory mimeBytes = bytes(mimeType);
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
        return _nameToAnchor[parentUID][name];
    }

    function getChildren(bytes32 anchorUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_children[anchorUID], start, length, reverseOrder);
    }
    
    function getChildrenCount(bytes32 anchorUID) external view returns (uint256) {
        return _children[anchorUID].length;
    }

    function getChildrenByType(bytes32 anchorUID, string memory mimeType, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenByType[anchorUID][keccak256(abi.encodePacked(mimeType))], start, length, reverseOrder);
    }

    function getChildrenByAttester(bytes32 anchorUID, address attester, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenByAttester[anchorUID][attester], start, length, reverseOrder);
    }

    // Generic Explorer

    function getAttestationsBySchema(bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_schemaAttestations[schemaUID], start, length, reverseOrder);
    }
    
    function getAttestationCountBySchema(bytes32 schemaUID) external view returns (uint256) {
        return _schemaAttestations[schemaUID].length;
    }

    function getAttestationsBySchemaAndAttester(bytes32 schemaUID, address attester, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_schemaAttesterAttestations[schemaUID][attester], start, length, reverseOrder);
    }
    
    function getAttestationCountBySchemaAndAttester(bytes32 schemaUID, address attester) external view returns (uint256) {
        return _schemaAttesterAttestations[schemaUID][attester].length;
    }

    function getReferencingAttestations(bytes32 targetUID, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingAttestations[targetUID][schemaUID], start, length, reverseOrder);
    }
    
    function getReferencingAttestationCount(bytes32 targetUID, bytes32 schemaUID) external view returns (uint256) {
        return _referencingAttestations[targetUID][schemaUID].length;
    }

    function getIncomingAttestations(address recipient, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_receivedAttestations[recipient][schemaUID], start, length, reverseOrder);
    }

    function getOutgoingAttestations(address attester, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_sentAttestations[attester][schemaUID], start, length, reverseOrder);
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

    // ============================================================================================
    // HELPERS
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
    
    function _swapPop(bytes32[] storage array, uint32 indexInMapping) private returns (uint32) {
        if (indexInMapping == 0) return 0;
        uint256 idx = uint256(indexInMapping) - 1;
        bytes32 lastUID = array[array.length - 1];
        
        array[idx] = lastUID;
        array.pop();
        
        return indexInMapping; // Returns the index reused (unless popped) - Wait, we need to return new index for lastUID
    }

    // NOTE: The helpers need to update indices for the moved element (lastUID).
    
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
        ( , string memory fileMode) = abi.decode(data, (bytes32, string));
         if (keccak256(bytes(fileMode)) == keccak256(bytes("tombstone"))) {
             return;
         }
         
        (bytes32 blobUID, ) = abi.decode(data, (bytes32, string));
        Attestation memory blobAttestation = _eas.getAttestation(blobUID);
        
        if (blobAttestation.uid != bytes32(0)) {
            if (blobAttestation.schema != BLOB_SCHEMA_UID) return;

            (string memory mimeType, , ) = abi.decode(blobAttestation.data, (string, uint8, bytes));
            
            bytes32 fullHash = keccak256(abi.encodePacked(mimeType));
            _childrenByType[parentUID][fullHash].push(attestationUID);
            _uidIndices[attestationUID].typeFull = uint32(_childrenByType[parentUID][fullHash].length);    

            bytes memory mimeBytes = bytes(mimeType);
            for (uint i = 0; i < mimeBytes.length; i++) {
                if (mimeBytes[i] == 0x2f) { // "/"
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
