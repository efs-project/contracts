// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

interface IEFSIndexer {
    function getChildren(bytes32 anchorUID, uint256 start, uint256 length, bool reverseOrder) external view returns (bytes32[] memory);
    function getChildrenCount(bytes32 anchorUID) external view returns (uint256);
    function getReferencingAttestationCount(bytes32 targetUID, bytes32 schemaUID) external view returns (uint256);
    function getEAS() external view returns (IEAS);
}

contract EFSFileView {
    
    struct FileSystemItem {
        bytes32 uid;
        string name;
        bytes32 parentUID;
        bool isFolder;
        bool hasData;
        uint256 childCount;
        uint256 propertyCount;
        uint64 timestamp;
        address attester;
    }

    IEFSIndexer public immutable indexer;
    IEAS public immutable eas;

    constructor(IEFSIndexer _indexer) {
        indexer = _indexer;
        eas = _indexer.getEAS();
    }

    function getDirectoryPage(
        bytes32 parentAnchor, 
        uint256 start, 
        uint256 length, 
        bytes32 dataSchemaUID,
        bytes32 propertySchemaUID
    ) external view returns (FileSystemItem[] memory) {
        // 1. Get UIDs from Indexer (Newest First = true)
        bytes32[] memory uids = indexer.getChildren(parentAnchor, start, length, true);
        
        FileSystemItem[] memory items = new FileSystemItem[](uids.length);

        for (uint256 i = 0; i < uids.length; i++) {
            bytes32 uid = uids[i];
            Attestation memory att = eas.getAttestation(uid);
            
            string memory name = "";
            if (att.data.length > 0) {
               name = abi.decode(att.data, (string));
            }

            uint256 childCount = indexer.getChildrenCount(uid);
            uint256 dataCount = indexer.getReferencingAttestationCount(uid, dataSchemaUID);
            uint256 propertyCount = indexer.getReferencingAttestationCount(uid, propertySchemaUID);

            items[i] = FileSystemItem({
                uid: uid,
                name: name,
                parentUID: parentAnchor,
                isFolder: childCount > 0,
                hasData: dataCount > 0,
                childCount: childCount,
                propertyCount: propertyCount,
                timestamp: att.time,
                attester: att.attester
            });
        }

        return items;
    }

    function decodeName(bytes memory data) external pure returns (string memory) {
        return abi.decode(data, (string));
    }
}
