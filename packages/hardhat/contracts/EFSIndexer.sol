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
        uint32 attester;
        uint32 typeFull;
        uint32 typeCat;
    }
    mapping(bytes32 => IndexData) private _uidIndices;

    // ============================================================================================
    // STORAGE: FILE SYSTEM INDICES (EFS CORE)
    // ============================================================================================

    // Directory Index (Path Resolution): parentAnchorUID => name => childAnchorUID
    mapping(bytes32 => mapping(string => bytes32)) private _directory;

    // Hierarchy List: parentAnchorUID => childAnchorUIDs
    mapping(bytes32 => bytes32[]) private _children;

    // Parent Lookups: childAnchorUID => parentAnchorUID
    mapping(bytes32 => bytes32) private _parents;

    // State Index (The Head): anchorUID => schemaUID => attester => attestationUID
    mapping(bytes32 => mapping(bytes32 => mapping(address => bytes32))) private _head;

    // Type Index: parentAnchorUID => mimeHash => childAnchorUIDs
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _childrenByType;

    // Attester Index: parentAnchorUID => attester => childAnchorUIDs
    mapping(bytes32 => mapping(address => bytes32[])) private _childrenByAttester;


    // ============================================================================================
    // STORAGE: GENERIC INDICES (SOCIAL LAYER)
    // ============================================================================================

    // Incoming: recipient => schemaUID => attestationUIDs
    mapping(address => mapping(bytes32 => bytes32[])) private _receivedAttestations;

    // Outgoing: attester => schemaUID => attestationUIDs
    mapping(address => mapping(bytes32 => bytes32[])) private _sentAttestations;

    // References: targetUID => schemaUID => attestationUIDs
    mapping(bytes32 => mapping(bytes32 => bytes32[])) private _referencingAttestations;

    // Tag Weights: targetUID => labelUID => weight
    mapping(bytes32 => mapping(bytes32 => int256)) private _tagWeights;


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

        // BRANCH A: EFS CORE LOGIC
        if (schema == ANCHOR_SCHEMA_UID) {
            string memory name = abi.decode(attestation.data, (string));
            
            // Resolve Parent (Use refUID, else recipient cast to bytes32, else generic root if 0)
            // Note: refUID is primary parent pointer.
            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }
            
            // ROOT ANCHOR LOGIC
            // The "rootAnchorUID" tracks the GLOBALLY first anchor.
            // However, users can create "User Roots" by attaching to a new parent or using recipient-based roots.
            // The system enforces that if you aren't the global root, you must have a parent.
            // This prevents "Floating Anchors" that are undiscoverable.
            
            // First anchor becomes root if not set
            if (rootAnchorUID == bytes32(0)) {
                rootAnchorUID = attestation.uid;
            } else {
                // Subsequent anchors MUST have a valid parent
                if (parentUID == bytes32(0)) {
                    // Check if it's the root itself being re-attested? (Unlikely)
                    // If not root, must have parent
                    if (attestation.uid != rootAnchorUID) {
                        revert MissingParent();
                    }
                }
            }
                
            // Validation: Enforce unique filenames
            if (_directory[parentUID][name] != bytes32(0)) {
                revert DuplicateFileName();
            }

            // Write Directory
            _directory[parentUID][name] = attestation.uid;
            
            // Scalable Indexing (1-based)
            _children[parentUID].push(attestation.uid);
            _uidIndices[attestation.uid].child = uint32(_children[parentUID].length);
            
            _parents[attestation.uid] = parentUID;
            
            // Attester Index (My Files)
            _childrenByAttester[parentUID][attestation.attester].push(attestation.uid);
            _uidIndices[attestation.uid].attester = uint32(_childrenByAttester[parentUID][attestation.attester].length);

            // MimeType indexing moved to DATA_SCHEMA_UID block


            // Index Reference for Explorer
            if (parentUID != bytes32(0)) {
                _referencingAttestations[parentUID][schema].push(attestation.uid);
                _uidIndices[attestation.uid].ref = uint32(_referencingAttestations[parentUID][schema].length);
            }
            
            // Index Sender
            _sentAttestations[attestation.attester][schema].push(attestation.uid);
            _uidIndices[attestation.uid].sent = uint32(_sentAttestations[attestation.attester][schema].length);

            return true;

        } else if (schema == DATA_SCHEMA_UID) {
            // Index MimeType
            if (attestation.refUID != EMPTY_UID) {
                bytes32 parentUID = _parents[attestation.refUID];
                if (parentUID != bytes32(0)) {
                    _indexMimeType(parentUID, attestation.refUID, attestation.data);
                }
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

            _head[attestation.refUID][schema][attestation.attester] = attestation.uid;
            // Index Reference for Explorer
            _referencingAttestations[attestation.refUID][schema].push(attestation.uid);
            _uidIndices[attestation.uid].ref = uint32(_referencingAttestations[attestation.refUID][schema].length);

            return true;
        } else if (schema == TAG_SCHEMA_UID) {
            // Encode: (bytes32 labelUID, int256 weight)
            (, int256 weight) = abi.decode(attestation.data, (bytes32, int256));
            
            // Crowd Source: Aggregate weight
            // Note: We key by LABEL UID.
            // But wait, the schema is `labelUID, weight`. We need to extract labelUID.
            (bytes32 labelUID, ) = abi.decode(attestation.data, (bytes32, int256)); 

            _tagWeights[attestation.refUID][labelUID] += weight;
                        // Also Index Reference for lookup
            if (attestation.refUID != EMPTY_UID) {
                _referencingAttestations[attestation.refUID][schema].push(attestation.uid);
                _uidIndices[attestation.uid].ref = uint32(_referencingAttestations[attestation.refUID][schema].length);
            }
            
             // Index Sender
            _sentAttestations[attestation.attester][schema].push(attestation.uid);
            _uidIndices[attestation.uid].sent = uint32(_sentAttestations[attestation.attester][schema].length);
            
            return true;
        }

        // BRANCH B: GENERIC LOGIC (Social Layer)
        
        // Index Recipient
        if (attestation.recipient != address(0)) {
            _receivedAttestations[attestation.recipient][schema].push(attestation.uid);
             _uidIndices[attestation.uid].rec = uint32(_receivedAttestations[attestation.recipient][schema].length);
        }

        // Index Sender
        _sentAttestations[attestation.attester][schema].push(attestation.uid);
        _uidIndices[attestation.uid].sent = uint32(_sentAttestations[attestation.attester][schema].length);

        // Index Reference
        if (attestation.refUID != EMPTY_UID) {
            _referencingAttestations[attestation.refUID][schema].push(attestation.uid);
            _uidIndices[attestation.uid].ref = uint32(_referencingAttestations[attestation.refUID][schema].length);
        }

        return true;
    }

    function onRevoke(Attestation calldata attestation, uint256 /*value*/) internal override returns (bool) {
        bytes32 schema = attestation.schema;

        // Head Cleanup
        if (_head[attestation.refUID][schema][attestation.attester] == attestation.uid) {
            delete _head[attestation.refUID][schema][attestation.attester];
        }

        if (schema == ANCHOR_SCHEMA_UID) {
            string memory name = abi.decode(attestation.data, (string));
            
            bytes32 parentUID = attestation.refUID;
            if (parentUID == EMPTY_UID && attestation.recipient != address(0)) {
                parentUID = bytes32(uint256(uint160(attestation.recipient)));
            }
            
            // Fix: Remove from _children array (Ghost Child) - O(1)
            if (parentUID != EMPTY_UID) {
                _removeChild(_children[parentUID], attestation.uid);
            }

            // Cleanup Directory mapping to allow name reuse
            if (_directory[parentUID][name] == attestation.uid) {
                delete _directory[parentUID][name];
            }

            // Cleanup Attester Index
            _removeAttester(_childrenByAttester[parentUID][attestation.attester], attestation.uid);
            
        } else if (schema == DATA_SCHEMA_UID) {
             // Cleanup Type Indices
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
        }
        
        // Fix: Remove from _referencingAttestations (Ghost References) - O(1)
        if (attestation.refUID != EMPTY_UID) {
            _removeRef(_referencingAttestations[attestation.refUID][schema], attestation.uid);
        }

        // Fix: Remove from _sentAttestations - O(1)
        _removeSent(_sentAttestations[attestation.attester][schema], attestation.uid);

        // Fix: Remove from _receivedAttestations - O(1)
        if (attestation.recipient != address(0)) {
            _removeReceived(_receivedAttestations[attestation.recipient][schema], attestation.uid);
        }

        if (schema == TAG_SCHEMA_UID) {
             (bytes32 labelUID, int256 weight) = abi.decode(attestation.data, (bytes32, int256));
             _tagWeights[attestation.refUID][labelUID] -= weight;
        }

        return true;
    }

    // ============================================================================================
    // READ FUNCTIONS: EFS CORE
    // ============================================================================================

    function resolvePath(bytes32 parentUID, string memory name) external view returns (bytes32) {
        return _directory[parentUID][name];
    }

    function getChildren(bytes32 anchorUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_children[anchorUID], start, length, reverseOrder);
    }

    function getChildrenByType(bytes32 anchorUID, string memory mimeType, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenByType[anchorUID][keccak256(abi.encodePacked(mimeType))], start, length, reverseOrder);
    }

    function getChildrenByAttester(bytes32 anchorUID, address attester, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_childrenByAttester[anchorUID][attester], start, length, reverseOrder);
    }

    function getHead(bytes32 anchorUID, bytes32 schemaUID, address attester) external view returns (bytes32) {
        return _head[anchorUID][schemaUID][attester];
    }

    // ============================================================================================
    // READ FUNCTIONS: GENERIC EXPLORER
    // ============================================================================================

    function getIncomingAttestations(address recipient, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_receivedAttestations[recipient][schemaUID], start, length, reverseOrder);
    }

    function getOutgoingAttestations(address attester, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_sentAttestations[attester][schemaUID], start, length, reverseOrder);
    }

    function getTagWeight(bytes32 targetUID, bytes32 labelUID) external view returns (int256) {
        return _tagWeights[targetUID][labelUID];
    }

    function getEAS() external view returns (IEAS) {
        return _eas;
    }
    
    function getReferencingAttestations(bytes32 targetUID, bytes32 schemaUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory) {
        return _sliceUIDs(_referencingAttestations[targetUID][schemaUID], start, length, reverseOrder);
    }

    // ============================================================================================
    // HELPERS
    // ============================================================================================

    /// @dev Returns a slice in an array of attestation UIDs.
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

    /// @dev O(1) Removal Helpers
    /// Logic: Swap element to remove with last element. Update last element's index. Pop.
    
    function _removeChild(bytes32[] storage array, bytes32 uid) private {
        uint32 index = _uidIndices[uid].child;
        if (index == 0) return; // Not in list
        
        // Convert to 0-based
        uint256 idx = uint256(index) - 1;
        bytes32 lastUID = array[array.length - 1];
        
        // Swap
        array[idx] = lastUID;
        array.pop();
        
        // Update index of moved element
        if (lastUID != uid) {
            _uidIndices[lastUID].child = index; 
        }
        
        delete _uidIndices[uid].child;
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
    function _indexMimeType(bytes32 parentUID, bytes32 attestationUID, bytes memory data) private {
        ( , string memory fileMode) = abi.decode(data, (bytes32, string));
         if (keccak256(bytes(fileMode)) == keccak256(bytes("tombstone"))) {
             return;
         }
         
        (bytes32 blobUID, ) = abi.decode(data, (bytes32, string));
        Attestation memory blobAttestation = _eas.getAttestation(blobUID);
        
        if (blobAttestation.uid != bytes32(0)) {
            (string memory mimeType, , ) = abi.decode(blobAttestation.data, (string, uint8, bytes));
            
            // Index Full MimeType
            bytes32 fullHash = keccak256(abi.encodePacked(mimeType));
            _childrenByType[parentUID][fullHash].push(attestationUID);
            _uidIndices[attestationUID].typeFull = uint32(_childrenByType[parentUID][fullHash].length);    

            // Index Category
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
}
