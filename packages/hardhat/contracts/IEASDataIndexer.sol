// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEASDataIndexer {
    struct IndexedFieldInfo {
        string fieldName;
        string fieldType;
        string queryTypeHint;
    }

    event AttestationDataIndexed(
        bytes32 indexed attestationUID,
        bytes32 indexed schemaUID,
        string fieldName,
        bytes32 valueHash
    );
    event BatchProcessedFromSource(
        address indexed attestationSource,
        bytes32 indexed schemaUID,
        uint256 numProcessed,
        uint256 newSourceOffset
    );

    // Errors (can be expanded)
    error IndexerMisconfiguration(string message);
    error AttestationAlreadyProcessed(bytes32 attestationUID);
    error AttestationProcessingFailed(bytes32 attestationUID, string reason);
    error SourceQueryFailed(address attestationSource);
    error InvalidArgument(string reason);
    error SchemaNotSupported(bytes32 schemaUID);


    function getEAS() external view returns (address);

    /**
     * @notice Returns an array of Schema UIDs that this indexer explicitly supports.
     * For an indexer dedicated to a single schema, this array will contain one element.
     * For a multi-schema indexer, it lists all schemas it can handle.
     */
    function getSupportedSchemaUIDs() external view returns (bytes32[] memory);

    /**
     * @notice Returns an array of field information for a specific schemaUID
     * that this indexer supports.
     * @param schemaUID The schema to get indexed field info for.
     */
    function getIndexedFields(bytes32 schemaUID) external view returns (IndexedFieldInfo[] memory fields);

    /**
     * @notice Processes a single attestation. The indexer will fetch schema info from EAS
     * and use its internal logic to decode and index based on the att.schema.
     * @dev Should revert if the attestation's schema is not supported by this indexer.
     * @param attestationUID The UID of the attestation to process.
     */
    function processAttestation(bytes32 attestationUID) external;

    /**
     * @notice Processes a batch of attestations.
     * @dev Should revert if any attestation's schema is not supported.
     * Consider atomicity: either all process or none.
     * @param attestationUIDs Array of UIDs to process.
     */
    function processAttestationsBatch(bytes32[] calldata attestationUIDs) external;

    /**
     * @notice Processes the next 'count' attestations for a specific schemaUID
     * that have not yet been indexed, sourcing UIDs from an official EAS indexer.
     * @param attestationSource Address of the official EAS Indexer.
     * @param schemaUID The specific schema to process attestations for.
     * @param count Max number of new attestations to attempt to process.
     * @return numProcessed The number of attestations actually processed.
     */
    function processNextAttestationsFromSource(
        address attestationSource,
        bytes32 schemaUID,
        uint256 count
    ) external returns (uint256 numProcessed);

    /**
     * @notice Retrieves indexed attestations.
     * @param schemaUID The schema context for the query.
     * @param fieldName The name of the field.
     * @param processedQueryValue Prepared query value.
     * @param offset Pagination offset.
     * @param limit Pagination limit.
     * @param reverseOrder Pagination order.
     * @return uids Array of matching attestation UIDs.
     */
    function getIndexedAttestations(
        bytes32 schemaUID,
        string calldata fieldName,
        bytes32 processedQueryValue,
        uint256 offset,
        uint256 limit,
        bool reverseOrder
    ) external view returns (bytes32[] memory uids);

    /**
     * @notice Gets the count for indexed attestations.
     */
    function getAttestationCount(
        bytes32 schemaUID,
        string calldata fieldName,
        bytes32 processedQueryValue
    ) external view returns (uint256 count);
}