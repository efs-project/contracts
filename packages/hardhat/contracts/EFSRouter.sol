// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { ISchemaRegistry, SchemaRecord } from "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol";

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

    function getReferencingBySchemaAndAttesterCount(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester
    ) external view returns (uint256);

    function isRevoked(bytes32 uid) external view returns (bool);

    function DATA_SCHEMA_UID() external view returns (bytes32);
    function MIRROR_SCHEMA_UID() external view returns (bytes32);
    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
    function DEPLOYER() external view returns (address);
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
    ISchemaRegistry public schemaRegistry;
    bytes32 public dataSchemaUID;

    /// @dev Top-level URL segment can resolve to four container flavors.
    ///      Resolution precedence at classification: Address (40-hex) →
    ///      Schema (64-hex registered) → Attestation (64-hex existing) → Anchor (name).
    ///      All flavors share the same downstream walk logic — they just seed
    ///      `currentParent` differently before `indexer.resolvePath` takes over.
    enum ContainerFlavor {
        Anchor,
        Address,
        Schema,
        Attestation
    }

    constructor(address _indexer, address _eas, address _tagResolver, address _schemaRegistry, bytes32 _dataSchemaUID) {
        indexer = IEFSIndexer(_indexer);
        eas = IEAS(_eas);
        tagResolver = ITagResolverForRouter(_tagResolver);
        schemaRegistry = ISchemaRegistry(_schemaRegistry);
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

    /// @dev Strip double-quotes and control characters (< 0x20) from a header value
    ///      to prevent header injection via user-supplied PROPERTY content types.
    function _sanitizeHeaderValue(string memory value) private pure returns (string memory) {
        bytes memory raw = bytes(value);
        // First pass: count safe bytes
        uint256 safeCount = 0;
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            if (c != '"' && c != "\\" && uint8(c) >= 0x20) {
                safeCount++;
            }
        }
        if (safeCount == raw.length) return value; // nothing to strip
        // Second pass: build sanitized string
        bytes memory out = new bytes(safeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < raw.length; i++) {
            bytes1 c = raw[i];
            if (c != '"' && c != "\\" && uint8(c) >= 0x20) {
                out[j++] = c;
            }
        }
        return string(out);
    }

    // Web3 Request Handler (EIP-5219)
    function request(
        string[] memory resource,
        KeyValue[] memory params
    ) external view override returns (uint statusCode, bytes memory body, KeyValue[] memory headers) {
        // Empty path guard (must be before classification)
        if (resource.length == 0) return (404, bytes("Not Found: Empty path"), new KeyValue[](0));

        // 1. Classify top-level segment → seed parent per container flavor (ADR-0033).
        //    Address / Schema / Attestation flavors skip segment 0 in the walk since it's the
        //    container itself; Anchor flavor keeps the pre-existing full walk from rootAnchorUID.
        //
        //    Schema / Attestation additionally prefer an *alias anchor* at root whose name is
        //    the UID's hex form — that's where EFS-native PROPERTYs / TAGs / sub-anchors live
        //    (see ADR-0033 §2). Raw-UID seed is only used when no alias has been attested yet;
        //    the JSON fallback below still serves raw EAS info for either case.
        (ContainerFlavor flavor, bytes32 rawUID) = _classifyTopLevel(resource[0]);

        bytes32 currentParent;
        bytes32 targetAnchor;
        uint256 startIdx;
        if (flavor == ContainerFlavor.Anchor) {
            currentParent = indexer.rootAnchorUID();
            targetAnchor = currentParent;
            startIdx = 0;
        } else if (flavor == ContainerFlavor.Address) {
            currentParent = rawUID;
            targetAnchor = rawUID;
            startIdx = 1;
        } else {
            // Schema or Attestation: prefer alias anchor at root if one exists.
            // Alias names are stored in lowercase 0x-hex (see 06_schema_aliases.ts),
            // so we lowercase the URL segment before the name lookup — otherwise
            // `0xABC…` URLs would miss an alias attested as `0xabc…`.
            bytes32 aliasUID = indexer.resolvePath(indexer.rootAnchorUID(), _lowercaseHex(resource[0]));
            currentParent = aliasUID != bytes32(0) ? aliasUID : rawUID;
            targetAnchor = currentParent;
            startIdx = 1;
        }

        for (uint i = startIdx; i < resource.length; i++) {
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
        bool editionsExplicit = false;
        address caller = msg.sender; // non-zero if web3:// client sets `from` on eth_call
        string memory chunkIndexStr = "";
        for (uint i = 0; i < params.length; i++) {
            if (
                _stringsEqual(params[i].key, "editions") ||
                _stringsEqual(params[i].key, "edition") ||
                _stringsEqual(params[i].key, "curator")
            ) {
                editions = _parseAddressList(params[i].value);
                editionsExplicit = true;
            } else if (_stringsEqual(params[i].key, "chunk")) {
                chunkIndexStr = params[i].value;
            } else if (_stringsEqual(params[i].key, "caller")) {
                address[] memory parsed = _parseAddressList(params[i].value);
                if (parsed.length > 0) caller = parsed[0];
            }
        }

        // Address-default editions: when browsing an address container with no explicit
        // `?editions=`, default to `[caller, segmentAddr]` — "Vitalik's files, with my
        // overrides on top". Consistent with ADR-0031 (explicit editions always override).
        if (flavor == ContainerFlavor.Address && !editionsExplicit) {
            address segmentAddr = address(uint160(uint256(rawUID)));
            if (caller != address(0) && caller != segmentAddr) {
                editions = new address[](2);
                editions[0] = caller;
                editions[1] = segmentAddr;
            } else {
                editions = new address[](1);
                editions[0] = segmentAddr;
            }
        }

        // 2. Find DATA via TAG query: resolve editions → TAG → DATA → MIRROR
        (bytes32 dataUID, address dataAttester) = _findDataAtPath(targetAnchor, editions, caller);
        if (dataUID == bytes32(0)) {
            // Schema/Attestation containers with no DATA attached fall back to raw-info JSON
            // instead of 404. Only fires when the user typed the container itself (no sub-path)
            // — for sub-paths under a schema/attestation, a missing file is still 404.
            // `rawUID` is preserved from classification regardless of whether we walked via an
            // alias anchor, so this responds with real EAS info either way.
            if (resource.length == 1) {
                if (flavor == ContainerFlavor.Schema) return _respondSchemaJSON(rawUID);
                if (flavor == ContainerFlavor.Attestation) return _respondAttestationJSON(rawUID);
            }
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
            // Single Content-Type with the actual type embedded as a parameter,
            // avoiding duplicate headers that clients may collapse or mishandle.
            // Sanitize contentType: strip quotes and control chars to prevent header injection.
            string memory safeContentType = _sanitizeHeaderValue(contentType);
            headers = new KeyValue[](1);
            headers[0] = KeyValue(
                "Content-Type",
                string(
                    abi.encodePacked(
                        'message/external-body; access-type=URL; URL="',
                        uri,
                        '"',
                        bytes(safeContentType).length > 0
                            ? string(abi.encodePacked('; content-type="', safeContentType, '"'))
                            : ""
                    )
                )
            );
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
            uint8 nibble = _hexCharToByte(uint8(addrBytes[offset + i]));
            if (nibble == 0xFF) return address(0); // non-hex char — malformed
            parsed *= 16;
            parsed += nibble;
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
    /// @dev Returns 0xFF on invalid hex character (sentinel, never a valid nibble).
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
        return 0xFF; // invalid — caller checks
    }

    // Parses string "web3://0x123..." -> address. Returns address(0) on any malformed input
    // (wrong prefix, too short, non-hex chars) so callers can skip bad mirrors without reverting.
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
            uint8 nibble = _hexCharToByte(uint8(uriBytes[offset + i]));
            if (nibble == 0xFF) return address(0); // non-hex char — malformed
            parsed *= 16;
            parsed += nibble;
        }
        return address(parsed);
    }

    /// @dev Produce a lowercased copy of a string's ASCII A–F range. Used to normalize URL-supplied
    ///      schema/attestation UIDs before alias-anchor name lookup — aliases are stored in lowercase
    ///      hex (see 06_schema_aliases.ts), so `/0xABC…` must match `/0xabc…`. Non-hex bytes pass
    ///      through unchanged; cheaper than full-string lowering and there's no need to handle the
    ///      rest of the ASCII table here.
    function _lowercaseHex(string memory str) private pure returns (string memory) {
        bytes memory sb = bytes(str);
        bytes memory out = new bytes(sb.length);
        for (uint i = 0; i < sb.length; i++) {
            bytes1 c = sb[i];
            if (c >= 0x41 && c <= 0x46) {
                out[i] = bytes1(uint8(c) + 32);
            } else {
                out[i] = c;
            }
        }
        return string(out);
    }

    /// @dev Non-reverting parser for 64-hex-char bytes32 (with optional 0x prefix and leading whitespace).
    ///      Returns (bytes32(0), false) on any malformed input. Mirrors `_parseAddress` per ADR-0019.
    function _parseBytes32(string memory str) private pure returns (bytes32, bool) {
        bytes memory sb = bytes(str);
        uint offset = 0;

        while (offset < sb.length && sb[offset] == 0x20) {
            offset++;
        }

        if (offset + 1 < sb.length && sb[offset] == "0" && (sb[offset + 1] == "x" || sb[offset + 1] == "X")) {
            offset += 2;
        }

        if (sb.length < offset + 64) return (bytes32(0), false);

        uint256 parsed = 0;
        for (uint i = 0; i < 64; i++) {
            uint8 nibble = _hexCharToByte(uint8(sb[offset + i]));
            if (nibble == 0xFF) return (bytes32(0), false);
            parsed = parsed * 16 + nibble;
        }
        return (bytes32(parsed), true);
    }

    /// @dev Returns the count of contiguous hex chars after an optional 0x prefix (with trailing
    ///      whitespace allowed). Returns 0 for empty input or if any non-hex / non-whitespace char
    ///      appears after the hex run. Used to disambiguate Address (40) vs Schema/Attestation (64).
    function _effectiveHexLength(string memory s) private pure returns (uint256) {
        bytes memory sb = bytes(s);
        uint offset = 0;
        while (offset < sb.length && sb[offset] == 0x20) offset++;
        if (offset + 1 < sb.length && sb[offset] == "0" && (sb[offset + 1] == "x" || sb[offset + 1] == "X")) {
            offset += 2;
        }
        uint count = 0;
        while (offset + count < sb.length && _hexCharToByte(uint8(sb[offset + count])) != 0xFF) {
            count++;
        }
        for (uint i = offset + count; i < sb.length; i++) {
            if (sb[i] != 0x20) return 0;
        }
        return count;
    }

    /// @dev Classify the top-level URL segment into one of four container flavors.
    ///      Precedence: Address (40 hex) → Schema (64 hex, registered) →
    ///      Attestation (64 hex, exists) → Anchor (anything else, including names).
    ///      See ADR-0033. ENS resolution is off-chain (frontend-only) per ADR-0030.
    function _classifyTopLevel(string memory segment) private view returns (ContainerFlavor, bytes32) {
        if (bytes(segment).length == 0) return (ContainerFlavor.Anchor, bytes32(0));

        uint256 hexLen = _effectiveHexLength(segment);

        if (hexLen == 40) {
            address a = _parseAddress(segment);
            if (a != address(0)) {
                return (ContainerFlavor.Address, bytes32(uint256(uint160(a))));
            }
        }

        if (hexLen == 64) {
            (bytes32 uid, bool ok) = _parseBytes32(segment);
            if (ok && uid != bytes32(0)) {
                if (schemaRegistry.getSchema(uid).uid != bytes32(0)) {
                    return (ContainerFlavor.Schema, uid);
                }
                if (eas.getAttestation(uid).uid != bytes32(0)) {
                    return (ContainerFlavor.Attestation, uid);
                }
            }
        }

        return (ContainerFlavor.Anchor, bytes32(0));
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

    /// @dev Lowercase-hex encoding of a bytes32 with 0x prefix. Used to serialize UIDs in JSON
    ///      responses for schema/attestation containers (see `_respondSchemaJSON` / `_respondAttestationJSON`).
    function _bytes32ToHex(bytes32 v) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory buf = new bytes(66);
        buf[0] = "0";
        buf[1] = "x";
        for (uint i = 0; i < 32; i++) {
            uint8 b = uint8(v[i]);
            buf[2 + i * 2] = alphabet[b >> 4];
            buf[3 + i * 2] = alphabet[b & 0x0f];
        }
        return string(buf);
    }

    function _addressToHex(address a) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory buf = new bytes(42);
        buf[0] = "0";
        buf[1] = "x";
        bytes20 b20 = bytes20(a);
        for (uint i = 0; i < 20; i++) {
            uint8 b = uint8(b20[i]);
            buf[2 + i * 2] = alphabet[b >> 4];
            buf[3 + i * 2] = alphabet[b & 0x0f];
        }
        return string(buf);
    }

    function _bytesToHex(bytes memory data) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory buf = new bytes(2 + data.length * 2);
        buf[0] = "0";
        buf[1] = "x";
        for (uint i = 0; i < data.length; i++) {
            uint8 b = uint8(data[i]);
            buf[2 + i * 2] = alphabet[b >> 4];
            buf[3 + i * 2] = alphabet[b & 0x0f];
        }
        return string(buf);
    }

    /// @dev Minimal JSON-string escaping: only backslash and double-quote are escaped.
    ///      Control characters are rare in schema strings and are passed through — this matches
    ///      the "best effort, never revert" spirit of the router. If an attester embeds raw
    ///      control chars in a schema, the resulting JSON may be parser-hostile but the router
    ///      still responds.
    function _jsonEscape(string memory s) private pure returns (string memory) {
        bytes memory sb = bytes(s);
        uint256 extra = 0;
        for (uint i = 0; i < sb.length; i++) {
            if (sb[i] == '"' || sb[i] == "\\") extra++;
        }
        if (extra == 0) return s;
        bytes memory out = new bytes(sb.length + extra);
        uint256 j = 0;
        for (uint i = 0; i < sb.length; i++) {
            if (sb[i] == '"' || sb[i] == "\\") {
                out[j++] = "\\";
            }
            out[j++] = sb[i];
        }
        return string(out);
    }

    /// @dev Build a 200 / application/json response for a schema container.
    ///      Shape: `{"uid":"0x…","resolver":"0x…","revocable":true,"schema":"…"}`.
    function _respondSchemaJSON(bytes32 uid) private view returns (uint, bytes memory, KeyValue[] memory) {
        SchemaRecord memory s = schemaRegistry.getSchema(uid);
        string memory json = string(
            abi.encodePacked(
                '{"uid":"',
                _bytes32ToHex(s.uid),
                '","resolver":"',
                _addressToHex(address(s.resolver)),
                '","revocable":',
                s.revocable ? "true" : "false",
                ',"schema":"',
                _jsonEscape(s.schema),
                '"}'
            )
        );
        KeyValue[] memory h = new KeyValue[](1);
        h[0] = KeyValue("Content-Type", "application/json");
        return (200, bytes(json), h);
    }

    /// @dev Build a 200 / application/json response for an attestation container.
    ///      Split into two encodePacked batches to keep the stack shallow.
    function _respondAttestationJSON(bytes32 uid) private view returns (uint, bytes memory, KeyValue[] memory) {
        IEAS.Attestation memory a = eas.getAttestation(uid);
        bytes memory part1 = abi.encodePacked(
            '{"uid":"',
            _bytes32ToHex(a.uid),
            '","schema":"',
            _bytes32ToHex(a.schema),
            '","attester":"',
            _addressToHex(a.attester),
            '","recipient":"',
            _addressToHex(a.recipient),
            '","refUID":"',
            _bytes32ToHex(a.refUID),
            '"'
        );
        bytes memory part2 = abi.encodePacked(
            ',"time":',
            _uintToString(a.time),
            ',"expirationTime":',
            _uintToString(a.expirationTime),
            ',"revocationTime":',
            _uintToString(a.revocationTime),
            ',"revocable":',
            a.revocable ? "true" : "false",
            ',"data":"',
            _bytesToHex(a.data),
            '"}'
        );
        string memory json = string(abi.encodePacked(part1, part2));
        KeyValue[] memory h = new KeyValue[](1);
        h[0] = KeyValue("Content-Type", "application/json");
        return (200, bytes(json), h);
    }

    // Find DATA at a path anchor via TAG query — returns the most recent DATA by timestamp
    // and the attester whose TAG resolved it (used to scope mirror selection).
    // The _activeByAttesterAndSchema array uses swap-and-pop, so element order is not
    // chronological. We scan all active targets and pick the one with the highest `time`.
    //
    // Fallback priority when no ?editions= is specified:
    //   1. caller (from ?caller= param or msg.sender if non-zero) — user sees their own files
    //   2. EFS deployer — system-provided defaults (settings, docs, etc.)
    function _findDataAtPath(
        bytes32 targetAnchor,
        address[] memory editions,
        address caller
    ) private view returns (bytes32, address) {
        bytes32 dataSchema = indexer.DATA_SCHEMA_UID();

        address[] memory attesters;
        if (editions.length > 0) {
            attesters = editions;
        } else if (caller != address(0)) {
            // Try caller first, then EFS deployer as fallback
            attesters = new address[](2);
            attesters[0] = caller;
            attesters[1] = indexer.DEPLOYER();
        } else {
            attesters = new address[](1);
            attesters[0] = indexer.DEPLOYER();
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

        // Page through the per-attester mirror index in chunks. The index is append-only
        // (revoked mirrors stay), so we must scan past revoked entries to find valid ones.
        uint256 total = indexer.getReferencingBySchemaAndAttesterCount(dataUID, mirrorSchema, attester);
        if (total == 0) return ("", false);

        string memory best = "";
        uint256 bestPriority = 99;
        bool hadMirrors = false;
        uint256 PAGE = 50;

        // Cap total pages to prevent unbounded gas consumption if an attester
        // accumulates a huge number of mirrors (including revoked ones).
        uint256 MAX_PAGES = 10; // 10 × 50 = 500 mirrors max scanned
        uint256 pages = 0;

        for (uint256 offset = 0; offset < total && pages < MAX_PAGES; offset += PAGE) {
            pages++;
            uint256 remaining = total - offset;
            uint256 chunk = remaining < PAGE ? remaining : PAGE;
            bytes32[] memory mirrors = indexer.getReferencingBySchemaAndAttester(
                dataUID,
                mirrorSchema,
                attester,
                offset,
                chunk,
                true
            );

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
                        address candidate = _parseContractFromWeb3URI(uri);
                        if (candidate == address(0)) continue;
                        return (uri, true); // web3:// is highest — done
                    }
                    bestPriority = priority;
                    best = uri;
                }
            }
        }
        return (best, hadMirrors);
    }

    // Get contentType from PROPERTY on DATA, scoped to the edition attester (ADR-0035).
    //
    // Unified PROPERTY model: the value lives on a free-floating PROPERTY attestation,
    // bound to the DATA via TAG under `Anchor<PROPERTY>(parent=DATA, name="contentType")`.
    // Per-attester singleton comes from TagResolver._activeByAAS — only the attester's
    // current binding is considered, so third parties cannot displace the MIME type.
    function _getContentType(bytes32 dataUID, address attester) private view returns (string memory) {
        bytes32 propertySchema = indexer.PROPERTY_SCHEMA_UID();

        // 1. Resolve the "contentType" key anchor under the DATA. Missing key anchor →
        //    no one has ever labeled this DATA's contentType anywhere.
        bytes32 keyAnchor = indexer.resolveAnchor(dataUID, "contentType", propertySchema);
        if (keyAnchor == bytes32(0)) return "application/octet-stream";

        // 2. Fetch the attester's active PROPERTY UID under that key anchor.
        bytes32[] memory targets = tagResolver.getActiveTargetsByAttesterAndSchema(
            keyAnchor,
            attester,
            propertySchema,
            0,
            1
        );
        if (targets.length == 0) return "application/octet-stream";

        bytes32 propertyUID = targets[0];
        if (indexer.isRevoked(propertyUID)) return "application/octet-stream";

        // 3. Decode the value.
        IEAS.Attestation memory propAtt = eas.getAttestation(propertyUID);
        string memory value = abi.decode(propAtt.data, (string));
        if (bytes(value).length == 0) return "application/octet-stream";
        return value;
    }
}
