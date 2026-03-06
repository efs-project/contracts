// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Interfaces for Web3:// Resolution

interface IDecentralizedApp {
    struct KeyValue {
        string key;
        string value;
    }

    function request(
        string[] memory resource,
        KeyValue[] memory params
    ) external view returns (uint256 statusCode, bytes memory body, KeyValue[] memory headers);
}

interface IChunkedSSTORE2 {
    function chunkCount() external view returns (uint256);

    function chunkAddress(uint256 index) external view returns (address);
}

// Interfaces for EAS and EFS
interface IEFSIndexer {
    function resolvePath(bytes32 parentUID, string memory name) external view returns (bytes32);

    function resolveAnchor(bytes32 parentUID, string memory name, bytes32 schema) external view returns (bytes32);

    function rootAnchorUID() external view returns (bytes32);

    function getReferencingAttestations(
        bytes32 targetUID,
        bytes32 schemaUID,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory);
}

interface IEAS {
    struct Attestation {
        bytes32 uid;
        bytes32 schema;
        uint64 time;
        uint64 expirationTime;
        uint64 revocationTime;
        bytes32 refUID;
        address recipient;
        address attester;
        bool revocable;
        bytes data;
    }

    function getAttestation(bytes32 uid) external view returns (Attestation memory);
}

contract EFSRouter is IDecentralizedApp {
    IEFSIndexer public indexer;
    IEAS public eas;
    bytes32 public dataSchemaUID;

    constructor(address _indexer, address _eas, bytes32 _dataSchemaUID) {
        indexer = IEFSIndexer(_indexer);
        eas = IEAS(_eas);
        dataSchemaUID = _dataSchemaUID;
    }

    // EIP-6944: Manual Resolve Mode
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    // String comparison helper
    function _stringsEqual(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    // Substring helper for prefix checking
    function _startsWith(string memory str, string memory prefix) private pure returns (bool) {
        bytes memory strBytes = bytes(str);
        bytes memory prefixBytes = bytes(prefix);
        if (prefixBytes.length > strBytes.length) return false;

        for (uint i = 0; i < prefixBytes.length; i++) {
            if (strBytes[i] != prefixBytes[i]) return false;
        }
        return true;
    }

    // Web3 Request Handler (EIP-5219)
    function request(
        string[] memory resource,
        KeyValue[] memory params
    ) external view override returns (uint statusCode, bytes memory body, KeyValue[] memory headers) {
        // 1. Path Resolution: Traverse directory from Root Anchor
        bytes32 currentParent = indexer.rootAnchorUID();
        bytes32 targetAnchor = currentParent;

        // Empty path guard (must be before the loop)
        if (resource.length == 0) return (404, bytes("Not Found: Empty path"), new KeyValue[](0));

        for (uint i = 0; i < resource.length; i++) {
            // Traverse down the hierarchy
            // For folders, we assume schema is 0 (generic). For the file (last element), it could be dataSchemaUID.
            // Let's try resolvePath first (generic schema 0)
            targetAnchor = indexer.resolvePath(currentParent, resource[i]);

            // If it's the last element and nothing was found, try the specific dataSchemaUID
            if (targetAnchor == bytes32(0) && i == resource.length - 1) {
                targetAnchor = indexer.resolveAnchor(currentParent, resource[i], dataSchemaUID);
            }

            if (targetAnchor == bytes32(0)) {
                return (404, bytes("Not Found: Path does not exist"), new KeyValue[](0));
            }
            currentParent = targetAnchor;
        }

        // Combine parameter checks
        address edition = address(0);
        string memory chunkIndexStr = "";
        for (uint i = 0; i < params.length; i++) {
            if (_stringsEqual(params[i].key, "edition") || _stringsEqual(params[i].key, "curator")) {
                edition = _parseAddress(params[i].value);
            } else if (_stringsEqual(params[i].key, "chunk")) {
                chunkIndexStr = params[i].value;
            }
        }

        // 2. Fetch the appropriate Data Attestation
        // In EFS, multiple 'Data' schemas can point to the same file Anchor.
        // Real logic would require iterating Indexer.getAttestationsBySchemaAndAttester or similar,
        // or retrieving the 'live' state from the Edition resolving layer.
        // For simplicity in this router V1, we will trust a method that returns the *active*
        // Data attestation UID for this anchor by this edition.
        // Since `EFSRouter` runs natively on the EVM, we mock `getDataAttestationId` logic inline.

        bytes32 dataUID = _findActiveDataAttestation(targetAnchor, edition);
        if (dataUID == bytes32(0)) {
            return (404, "Not Found: No data attached or curator unset", new KeyValue[](0));
        }

        IEAS.Attestation memory dataAtt = eas.getAttestation(dataUID);

        // Decode Data (Quad-Schema): string uri, string contentType, string fileMode
        (string memory uri, string memory contentType, string memory fileMode) = abi.decode(
            dataAtt.data,
            (string, string, string)
        );

        // 3. Evaluate FileMode
        if (_stringsEqual(fileMode, "tombstone")) {
            return (404, bytes("Not Found: Deleted"), new KeyValue[](0));
        }
        if (_stringsEqual(fileMode, "symlink")) {
            // Return HTTP 307 Redirect.
            // `uri` holds the redirect target (another web3:// or Path)
            headers = new KeyValue[](1);
            headers[0] = KeyValue("Location", uri);
            return (307, bytes(""), headers);
        }

        // 4. Content Retrieval & Translation
        if (_startsWith(uri, "ipfs://") || _startsWith(uri, "ar://") || _startsWith(uri, "https://")) {
            // External URI Delegation (message/external-body)
            headers = new KeyValue[](2);
            headers[0] = KeyValue(
                "Content-Type",
                string(abi.encodePacked('message/external-body; access-type=URL; URL="', uri, '"'))
            );
            headers[1] = KeyValue("Content-Type", contentType); // Provide hint
            return (200, bytes(""), headers);
        } else if (_startsWith(uri, "web3://")) {
            // On-chain fetch via SSTORE2 or similar.
            // In a real deployed version, web3:// contract addresses are queried.
            // For now, if uri is internal or points to contract, pull bytes. (Mocking EXTCODECOPY)

            // EIP-7617 Chunking Validation
            address targetContract = _parseContractFromWeb3URI(uri);
            if (targetContract == address(0)) {
                return (500, bytes("Invalid on-chain URI"), new KeyValue[](0));
            }

            uint256 chunkIdx = _parseUint(chunkIndexStr);

            bool isChunked = false;
            uint256 totalChunks = 0;

            // Native detection of Array Storage.
            // Using low-level staticcall because SSTORE2 contracts return success=true and 0 bytes.
            // Solidity `try/catch` would revert attempting to ABI-decode 0 bytes into uint256.
            (bool success, bytes memory returnData) = targetContract.staticcall(
                abi.encodeWithSelector(IChunkedSSTORE2.chunkCount.selector)
            );
            if (success && returnData.length >= 32) {
                isChunked = true;
                totalChunks = abi.decode(returnData, (uint256));
            }

            if (isChunked) {
                if (chunkIdx >= totalChunks) {
                    return (404, bytes("Chunk out of bounds"), new KeyValue[](0));
                }

                (bool successAddr, bytes memory addrData) = targetContract.staticcall(
                    abi.encodeWithSelector(IChunkedSSTORE2.chunkAddress.selector, chunkIdx)
                );
                if (!successAddr || addrData.length < 32) {
                    return (500, bytes("Chunk reading failed"), new KeyValue[](0));
                }
                targetContract = abi.decode(addrData, (address));

                if (chunkIdx + 1 < totalChunks) {
                    headers = new KeyValue[](2);
                    headers[0] = KeyValue("Content-Type", contentType);
                    headers[1] = KeyValue(
                        "web3-next-chunk",
                        string(abi.encodePacked("?chunk=", _uintToString(chunkIdx + 1)))
                    );
                } else {
                    headers = new KeyValue[](1);
                    headers[0] = KeyValue("Content-Type", contentType);
                }
            } else {
                headers = new KeyValue[](1);
                headers[0] = KeyValue("Content-Type", contentType);
            }

            // Guard: if the storage contract has no code, return 500
            uint256 codeLen;
            assembly {
                codeLen := extcodesize(targetContract)
            }
            if (codeLen == 0) {
                return (500, bytes("Storage contract has no code"), new KeyValue[](0));
            }

            // Using inline assembly to read SSTORE2 bytes (skipping first 1 byte STOP opcode)
            bytes memory rawData = "";
            assembly {
                let size := extcodesize(targetContract)
                if gt(size, 1) {
                    // Normal SSTORE2 skips first byte 0x00
                    rawData := mload(0x40) // get free memory pointer
                    mstore(0x40, add(rawData, and(add(add(sub(size, 1), 0x20), 0x1f), not(0x1f)))) // advance free memory pointer
                    mstore(rawData, sub(size, 1)) // store length (excluding first byte)
                    extcodecopy(targetContract, add(rawData, 0x20), 1, sub(size, 1)) // copy code
                }
            }
            return (200, rawData, headers);
        }

        // Fallback for raw byte URIs / encoded data
        headers = new KeyValue[](1);
        headers[0] = KeyValue("Content-Type", contentType);
        return (200, bytes(uri), headers);
    }

    // ---------- HELPER FUNCTIONS ------------

    function _parseAddress(string memory addrStr) private pure returns (address) {
        // String to address parsing.
        // For simplicity in mock/test, assume address conversion or rely on indexer.
        // (Production requires full hex validation)
        return address(bytes20(bytes(addrStr))); // stub
    }

    // Helper to decode 1 hex char
    function _hexCharToByte(uint8 c) private pure returns (uint8) {
        if (bytes1(c) >= bytes1("0") && bytes1(c) <= bytes1("9")) {
            return c - uint8(bytes1("0"));
        }
        if (bytes1(c) >= bytes1("a") && bytes1(c) <= bytes1("f")) {
            return 10 + c - uint8(bytes1("a"));
        }
        if (bytes1(c) >= bytes1("A") && bytes1(c) <= bytes1("F")) {
            return 10 + c - uint8(bytes1("A"));
        }
        revert("Invalid hex char");
    }

    // Parses string "web3://0x123..." -> address
    function _parseContractFromWeb3URI(string memory uri) private pure returns (address) {
        bytes memory uriBytes = bytes(uri);
        // Expect format: web3://0xAbCdEf... (minimum 49 chars)
        if (uriBytes.length < 49) return address(0);

        // Ensure prefix is web3://
        if (
            uriBytes[0] != "w" ||
            uriBytes[1] != "e" ||
            uriBytes[2] != "b" ||
            uriBytes[3] != "3" ||
            uriBytes[4] != ":" ||
            uriBytes[5] != "/" ||
            uriBytes[6] != "/"
        ) {
            return address(0);
        }

        // Check for '0x' or '0X'
        uint offset = 7;
        if (uriBytes[offset] == "0" && (uriBytes[offset + 1] == "x" || uriBytes[offset + 1] == "X")) {
            offset += 2;
        }

        if (uriBytes.length < offset + 40) return address(0);

        uint160 parsed = 0;
        for (uint i = 0; i < 40; i++) {
            parsed *= 16;
            parsed += _hexCharToByte(uint8(uriBytes[offset + i]));
        }
        return address(parsed);
    }

    // Parses a string to uint256
    function _parseUint(string memory str) private pure returns (uint256) {
        bytes memory strBytes = bytes(str);
        if (strBytes.length == 0) return 0;
        uint256 result = 0;
        for (uint i = 0; i < strBytes.length; i++) {
            uint8 b = uint8(strBytes[i]);
            if (b >= 48 && b <= 57) {
                result = result * 10 + (b - 48);
            } else {
                // Invalid character, default to 0 to prevent revert on malformed query strings
                return 0;
            }
        }
        return result;
    }

    // uint256 to string helper
    function _uintToString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    // Searches Indexer for the most recent Data attestation attached to an Anchor by Edition
    // SECURITY: V1 intentionally serves the most-recent data attestation regardless of edition/attester.
    // The `edition` parameter is accepted but not yet filtered. Edition-based curation (subjective
    // filesystem views) is a planned V2 feature that requires `getReferencingAttestationsByAttester`
    // or equivalent filtering on the Indexer side. Until then, any attester can publish a newer
    // data attestation that supersedes older ones for a given file anchor.
    function _findActiveDataAttestation(bytes32 targetAnchor, address /*edition*/) private view returns (bytes32) {
        bytes32[] memory records = indexer.getReferencingAttestations(targetAnchor, dataSchemaUID, 0, 1, true);
        if (records.length > 0) {
            return records[0];
        }
        return bytes32(0);
    }
}
