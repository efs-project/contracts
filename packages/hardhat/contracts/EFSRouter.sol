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

    function getReferencingBySchemaAndAttester(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder
    ) external view returns (bytes32[] memory);

    function isRevoked(bytes32 uid) external view returns (bool);

    function DATA_SCHEMA_UID() external view returns (bytes32);
    function MIRROR_SCHEMA_UID() external view returns (bytes32);
    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
}

interface ITagResolverForRouter {
    function getActiveTargetsByAttesterAndSchema(
        bytes32 definition,
        address attester,
        bytes32 schema,
        uint256 start,
        uint256 length
    ) external view returns (bytes32[] memory);

    function getActiveTargetsByAttesterAndSchemaCount(
        bytes32 definition,
        address attester,
        bytes32 schema
    ) external view returns (uint256);
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
    ITagResolverForRouter public tagResolver;
    bytes32 public dataSchemaUID;

    constructor(address _indexer, address _eas, address _tagResolver, bytes32 _dataSchemaUID) {
        indexer = IEFSIndexer(_indexer);
        eas = IEAS(_eas);
        tagResolver = ITagResolverForRouter(_tagResolver);
        dataSchemaUID = _dataSchemaUID;
    }

    // EIP-6944: Manual Resolve Mode
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @dev Maximum number of edition addresses accepted in a single `?editions=` query param.
    ///      Prevents crafted URLs from causing unbounded `_parseAddressList` gas in RPC nodes.
    uint256 private constant MAX_EDITIONS = 20;

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
            // Traverse down the hierarchy.
            // Intermediate segments must be folders (generic schema).
            // Last segment: try data-schema anchor first (file), fall back to generic (folder).
            if (i == resource.length - 1) {
                targetAnchor = indexer.resolveAnchor(currentParent, resource[i], dataSchemaUID);
                if (targetAnchor == bytes32(0)) {
                    targetAnchor = indexer.resolvePath(currentParent, resource[i]);
                }
            } else {
                targetAnchor = indexer.resolvePath(currentParent, resource[i]);
            }

            if (targetAnchor == bytes32(0)) {
                return (404, bytes("Not Found: Path does not exist"), new KeyValue[](0));
            }
            currentParent = targetAnchor;
        }

        // Combine parameter checks
        address[] memory editions;
        string memory chunkIndexStr = "";
        for (uint i = 0; i < params.length; i++) {
            if (
                _stringsEqual(params[i].key, "editions") ||
                _stringsEqual(params[i].key, "edition") ||
                _stringsEqual(params[i].key, "curator")
            ) {
                editions = _parseAddressList(params[i].value);
            } else if (_stringsEqual(params[i].key, "chunk")) {
                chunkIndexStr = params[i].value;
            }
        }

        // 2. Find DATA via TAG query: resolve editions → TAG → DATA → MIRROR
        (bytes32 dataUID, address dataAttester) = _findDataAtPath(targetAnchor, editions);
        if (dataUID == bytes32(0)) {
            return (404, "Not Found: No data attached or curator unset", new KeyValue[](0));
        }

        // 3. Get best MIRROR for retrieval URI (scoped to the edition attester)
        (string memory uri, bool hadMirrors) = _getBestMirrorURI(dataUID, dataAttester);

        // 4. Get contentType from PROPERTY on DATA, scoped to the edition attester
        string memory contentType = _getContentType(dataUID, dataAttester);

        // 5. Content Retrieval & Translation
        if (bytes(uri).length == 0) {
            if (hadMirrors) {
                // Mirrors exist but none have a valid URI — data is stored but unresolvable.
                return (500, bytes("Stored mirror URI is invalid"), new KeyValue[](0));
            }
            return (404, bytes("Not Found: No mirror available"), new KeyValue[](0));
        }

        if (
            _startsWith(uri, "ipfs://") ||
            _startsWith(uri, "ar://") ||
            _startsWith(uri, "https://") ||
            _startsWith(uri, "magnet:")
        ) {
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
        bytes memory addrBytes = bytes(addrStr);
        uint offset = 0;

        while (offset < addrBytes.length && addrBytes[offset] == 0x20) {
            offset++;
        }

        if (
            offset + 1 < addrBytes.length &&
            addrBytes[offset] == "0" &&
            (addrBytes[offset + 1] == "x" || addrBytes[offset + 1] == "X")
        ) {
            offset += 2;
        }

        if (addrBytes.length < offset + 40) return address(0);

        uint160 parsed = 0;
        for (uint i = 0; i < 40; i++) {
            parsed *= 16;
            parsed += _hexCharToByte(uint8(addrBytes[offset + i]));
        }
        return address(parsed);
    }

    function _parseAddressList(string memory addrListStr) private pure returns (address[] memory) {
        bytes memory strBytes = bytes(addrListStr);
        if (strBytes.length == 0) return new address[](0);

        uint256 count = 1;
        for (uint i = 0; i < strBytes.length; i++) {
            if (strBytes[i] == ",") count++;
        }

        // Guard against DoS via crafted URLs with hundreds of addresses
        if (count > MAX_EDITIONS) count = MAX_EDITIONS;

        address[] memory addresses = new address[](count);
        uint256 addrIdx = 0;
        uint256 lastSplit = 0;

        for (uint i = 0; i < strBytes.length; i++) {
            if (strBytes[i] == ",") {
                if (addrIdx >= count) break; // stop writing once array is full
                addresses[addrIdx++] = _parseAddress(_substring(addrListStr, lastSplit, i));
                lastSplit = i + 1;
            }
        }

        if (addrIdx < count && lastSplit < strBytes.length) {
            addresses[addrIdx] = _parseAddress(_substring(addrListStr, lastSplit, strBytes.length));
        }

        return addresses;
    }

    function _substring(string memory str, uint256 startIndex, uint256 endIndex) private pure returns (string memory) {
        bytes memory strBytes = bytes(str);
        bytes memory result = new bytes(endIndex - startIndex);
        for (uint i = startIndex; i < endIndex; i++) {
            result[i - startIndex] = strBytes[i];
        }
        return string(result);
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

    // Find DATA at a path anchor via TAG query — returns the most recent DATA by timestamp
    // and the attester whose TAG resolved it (used to scope mirror selection).
    // The _activeByAttesterAndSchema array uses swap-and-pop, so element order is not
    // chronological. We scan all active targets and pick the one with the highest `time`.
    function _findDataAtPath(bytes32 targetAnchor, address[] memory editions) private view returns (bytes32, address) {
        bytes32 dataSchema = indexer.DATA_SCHEMA_UID();

        // Build the attester list to query. When no editions are specified (bare web3:// URL),
        // fall back to the anchor's own attester so that `web3://<router>/path/file` works
        // without requiring an explicit ?editions= parameter.
        address[] memory attesters;
        if (editions.length > 0) {
            attesters = editions;
        } else {
            attesters = new address[](1);
            attesters[0] = eas.getAttestation(targetAnchor).attester;
        }

        for (uint256 i = 0; i < attesters.length; i++) {
            uint256 count = tagResolver.getActiveTargetsByAttesterAndSchemaCount(
                targetAnchor,
                attesters[i],
                dataSchema
            );
            if (count == 0) continue;

            bytes32[] memory targets = tagResolver.getActiveTargetsByAttesterAndSchema(
                targetAnchor,
                attesters[i],
                dataSchema,
                0,
                count
            );

            // Pick the most recent target by attestation timestamp
            bytes32 best = targets[0];
            uint64 bestTime = eas.getAttestation(targets[0]).time;
            for (uint256 j = 1; j < targets.length; j++) {
                uint64 t = eas.getAttestation(targets[j]).time;
                if (t > bestTime) {
                    bestTime = t;
                    best = targets[j];
                }
            }
            return (best, attesters[i]);
        }

        return (bytes32(0), address(0));
    }

    // Get the best mirror URI for a DATA attestation, scoped to the edition attester.
    // Only mirrors attached by `attester` are considered — prevents third parties from
    // injecting mirrors onto a DATA that is served under someone else's edition.
    //
    // Returns (uri, hadMirrors) where hadMirrors=true means at least one non-revoked mirror
    // from `attester` existed (even if none had a valid URI). Caller uses this to distinguish
    // 404 (no mirrors) from 500 (mirrors exist but all are unresolvable).
    //
    // Priority order: web3:// (on-chain, permanent) > ar:// (permanent, content-addressed) >
    //                 ipfs:// (content-addressed, requires pinning) >
    //                 magnet: (peer-dependent) > https:// (mutable, centralized)
    function _getBestMirrorURI(bytes32 dataUID, address attester) private view returns (string memory, bool) {
        bytes32 mirrorSchema = indexer.MIRROR_SCHEMA_UID();
        if (mirrorSchema == bytes32(0)) return ("", false); // MIRROR not wired yet

        // Use the per-(data,schema,attester) index so spam mirrors from other addresses
        // cannot push the edition attester's mirrors out of the scanned window.
        bytes32[] memory mirrors = indexer.getReferencingBySchemaAndAttester(dataUID, mirrorSchema, attester, 0, 50, true);

        string memory best = "";
        uint256 bestPriority = 99;
        bool hadMirrors = false;

        for (uint256 i = 0; i < mirrors.length; i++) {
            if (indexer.isRevoked(mirrors[i])) continue;
            IEAS.Attestation memory mirrorAtt = eas.getAttestation(mirrors[i]);
            hadMirrors = true;

            (, string memory uri) = abi.decode(mirrorAtt.data, (bytes32, string));

            uint256 priority;
            if (_startsWith(uri, "web3://")) priority = 0;
            else if (_startsWith(uri, "ar://")) priority = 1;
            else if (_startsWith(uri, "ipfs://")) priority = 2;
            else if (_startsWith(uri, "magnet:")) priority = 3;
            else priority = 4; // https:// and anything else

            if (priority < bestPriority) {
                if (priority == 0) {
                    // Validate web3:// address format before committing — a malformed URI
                    // would return 500 even when valid lower-priority mirrors exist.
                    address candidate = _parseContractFromWeb3URI(uri);
                    if (candidate == address(0)) continue; // bad address — try lower-priority mirrors
                    bestPriority = 0;
                    best = uri;
                    break; // web3:// with valid address is highest priority — stop scanning
                }
                bestPriority = priority;
                best = uri;
            }
        }
        return (best, hadMirrors);
    }

    // Get contentType from PROPERTY on DATA, scoped to the edition attester.
    // Only properties authored by `attester` are considered — prevents third parties from
    // overriding the MIME type by attaching a later PROPERTY to someone else's DATA.
    function _getContentType(bytes32 dataUID, address attester) private view returns (string memory) {
        bytes32 propertySchema = indexer.PROPERTY_SCHEMA_UID();
        bytes32[] memory props = indexer.getReferencingAttestations(dataUID, propertySchema, 0, 20, true);

        for (uint256 i = 0; i < props.length; i++) {
            if (indexer.isRevoked(props[i])) continue;
            IEAS.Attestation memory propAtt = eas.getAttestation(props[i]);
            if (propAtt.attester != attester) continue;
            (string memory key, string memory value) = abi.decode(propAtt.data, (string, string));
            if (keccak256(bytes(key)) == keccak256("contentType") && bytes(value).length > 0) return value;
        }
        return "application/octet-stream";
    }
}
