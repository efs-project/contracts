// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

contract SchemaNameIndex {
    IEAS public immutable _eas;
    bytes32 public immutable NAMING_SCHEMA_UID;

    // schemaUID => name
    mapping(bytes32 => string) public schemaNames;

    event SchemaNameIndexed(bytes32 indexed schemaUID, string name, bytes32 attestationUID);

    constructor(IEAS eas, bytes32 namingSchemaUID) {
        _eas = eas;
        NAMING_SCHEMA_UID = namingSchemaUID;
    }

    function indexAttestation(bytes32 uid) external {
        Attestation memory attestation = _eas.getAttestation(uid);
        
        // Basic Validation
        require(attestation.uid != bytes32(0), "Attestation not found");
        require(attestation.schema == NAMING_SCHEMA_UID, "Invalid schema: Must be Naming Schema");
        require(attestation.revocationTime == 0, "Attestation is revoked");

        // Decode Data: bytes32 schemaId, string name
        (bytes32 targetSchemaUID, string memory name) = abi.decode(attestation.data, (bytes32, string));
        
        // In a real decentralized system there might be conflict resolution rules.
        // For this explorer/indexer, simplest "Last Indexed Wins" is sufficient.
        schemaNames[targetSchemaUID] = name;
        
        emit SchemaNameIndexed(targetSchemaUID, name, uid);
    }
}
