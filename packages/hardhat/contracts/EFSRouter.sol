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
    ) external view returns (uint16 statusCode, bytes memory body, KeyValue[] memory headers);
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
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory);

    function getReferencingBySchemaAndAttester(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester,
        uint256 start,
        uint256 length,
        bool reverseOrder,
        bool showRevoked
    ) external view returns (bytes32[] memory);

    function getReferencingBySchemaAndAttesterCount(
        bytes32 targetUID,
        bytes32 schemaUID,
        address attester
    ) external view returns (uint256);

    function isRevoked(bytes32 uid) external view returns (bool);

    /// @notice The parent anchor of `anchorUID` (ADR-0055 whiteout key: a whiteout on a file anchor
    ///         keys on (parent, fileAnchor)). Returns bytes32(0) for root / unknown.
    function getParent(bytes32 anchorUID) external view returns (bytes32);

    function DATA_SCHEMA_UID() external view returns (bytes32);
    function MIRROR_SCHEMA_UID() external view returns (bytes32);
    function PROPERTY_SCHEMA_UID() external view returns (bytes32);
    function DEPLOYER() external view returns (address);
}

interface IEdgeResolverForRouter {
    /// @notice O(1) read of the active PIN's target UID for a (definition, attester, schema) slot.
    ///         Used for Shape A reads — file placement (DATA at anchor) and PROPERTY value
    ///         binding (contentType, name, etc.). Returns bytes32(0) when the slot is empty.
    function getActivePinTarget(
        bytes32 definition,
        address attester,
        bytes32 targetSchema
    ) external view returns (bytes32);
}

/// @notice Minimal read view over the WhiteoutResolver (ADR-0055) for the router's negative terminal.
///         `address(0)` ⇒ whiteout disabled: the lens scan never calls it and serves exactly as
///         before WHITEOUT existed (pre-WHITEOUT router redeploys / harnesses that don't wire one).
interface IWhiteoutResolverForRouter {
    /// @notice True iff `attester` has an ACTIVE whiteout suppressing `child` under `parent`.
    ///         See `WhiteoutResolver.isWhitedOut`.
    function isWhitedOut(bytes32 parent, address attester, bytes32 child) external view returns (bool);
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
    IEdgeResolverForRouter public edgeResolver;
    ISchemaRegistry public schemaRegistry;
    bytes32 public dataSchemaUID;

    /// @notice The WhiteoutResolver (proxy) for the cross-lens negative mask (ADR-0055). The router is
    ///         redeployable (in no schema UID), so this is a constructor arg, not a frozen wire.
    ///         `address(0)` ⇒ whiteout disabled: the lens scan serves exactly as before WHITEOUT
    ///         existed (pre-WHITEOUT router redeploys + tests that don't wire one keep prior behavior).
    IWhiteoutResolverForRouter public whiteoutResolver;

    /// @notice The SystemAccount (ADR-0053) — the neutral, code-governed `system` lens. Used as
    ///         the tail of the default-lens chain (ADR-0039): when no `?lenses=` is given, content
    ///         falls back to `system` (the bootstrap scaffolding / official defaults author), not
    ///         the throwaway deployer EOA. The router is a redeployable view (its address is in no
    ///         schema UID), so pointing the fallback here is a view-config change, not a frozen one
    ///         — it does NOT touch the kernel's immutable `DEPLOYER`/owner or the auto-tag path.
    address public systemAccount;

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

    constructor(
        address _indexer,
        address _eas,
        address _edgeResolver,
        address _schemaRegistry,
        bytes32 _dataSchemaUID,
        address _systemAccount,
        address _whiteoutResolver
    ) {
        indexer = IEFSIndexer(_indexer);
        eas = IEAS(_eas);
        edgeResolver = IEdgeResolverForRouter(_edgeResolver);
        schemaRegistry = ISchemaRegistry(_schemaRegistry);
        dataSchemaUID = _dataSchemaUID;
        // ADR-0055: the cross-lens negative mask. Zero = disabled (pre-WHITEOUT router / tests).
        whiteoutResolver = IWhiteoutResolverForRouter(_whiteoutResolver);
        // ADR-0053: the default-lens fallback points at SystemAccount, not the deployer EOA. Falls
        // back to indexer.DEPLOYER() only if a zero address is passed (pre-ADR-0053 deploys / tests
        // that don't wire a SystemAccount), preserving the old behavior in that degenerate case.
        systemAccount = _systemAccount != address(0) ? _systemAccount : indexer.DEPLOYER();
    }

    /// @dev The system-lens address used as the default-lens fallback (ADR-0053 / ADR-0039).
    function _systemLens() private view returns (address) {
        address sa = systemAccount;
        return sa != address(0) ? sa : indexer.DEPLOYER();
    }

    // EIP-6944: Manual Resolve Mode
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @dev Maximum number of lens addresses accepted in a single `?lenses=` query param.
    ///      Prevents crafted URLs from causing unbounded `_parseAddressList` gas in RPC nodes.
    uint256 private constant MAX_LENSES = 20;

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
    ) external view override returns (uint16 statusCode, bytes memory body, KeyValue[] memory headers) {
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

        // Parse params (lenses / caller / chunk) + apply the address-default lens block before the
        // segment walk. The data-resolution path below reads the same `lenses`.
        address[] memory lenses;
        bool lensesExplicit = false;
        address caller = msg.sender; // non-zero if web3:// client sets `from` on eth_call
        string memory chunkIndexStr = "";
        for (uint i = 0; i < params.length; i++) {
            if (_stringsEqual(params[i].key, "lenses")) {
                lenses = _parseAddressList(params[i].value);
                lensesExplicit = true;
            } else if (_stringsEqual(params[i].key, "chunk")) {
                chunkIndexStr = params[i].value;
            } else if (_stringsEqual(params[i].key, "caller")) {
                address[] memory parsed = _parseAddressList(params[i].value);
                if (parsed.length > 0) caller = parsed[0];
            }
        }

        // Address-default lenses: when browsing an address container with no explicit `?lenses=`,
        // default to `[caller, segmentAddr, system]` (matches the data-resolution comment below).
        if (flavor == ContainerFlavor.Address && !lensesExplicit) {
            address segmentAddr = address(uint160(uint256(rawUID)));
            address sys = _systemLens();
            if (caller != address(0) && caller != segmentAddr) {
                lenses = new address[](3);
                lenses[0] = caller;
                lenses[1] = segmentAddr;
                lenses[2] = sys;
            } else {
                lenses = new address[](2);
                lenses[0] = segmentAddr;
                lenses[1] = sys;
            }
        }

        // Build the effective lens stack ONCE (ADR-0031/0039/0053) and reuse it for both the
        // per-segment deep-link whiteout terminal in the walk below and the final-target DATA read
        // (`_findDataAtPath`). Computing it here — rather than recomputing a possibly-different stack
        // inside `_findDataAtPath` — keeps the deep-link 404 (spec/04) and the leaf read on the exact
        // same lens precedence (ADR-0055). An empty stack (viewer removed every lens) means no data.
        address[] memory effLenses = _effectiveLenses(lenses, caller, lensesExplicit);

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

            // ADR-0055 deep-link terminal (spec/04): apply the per-name whiteout RESOLUTION terminal
            // to EACH resolved segment against the SAME effective lens stack — so a deep link into a
            // whited-out folder (e.g. a viewer whiteouts `/dir`; `GET /dir/child.txt`) 404s instead of
            // resolving a lower lens's content. Checked against (currentParent = the segment's parent,
            // targetAnchor = the just-resolved child) BEFORE descending. The final-target check in
            // `_findDataAtPath` below stays as-is (now redundant for the leaf, harmless). Cost is
            // O(segments × lenses), bounded (MAX_LENSES ≤ 20); zero when whiteout is disabled.
            if (_isSegmentWhitedOut(currentParent, targetAnchor, effLenses)) {
                return (404, bytes("Not Found: Path does not exist"), new KeyValue[](0));
            }

            currentParent = targetAnchor;
        }

        // 2. Find DATA via TAG query: resolve lenses → TAG → DATA → MIRROR. An empty effective stack
        //    (viewer removed every lens) returns (0,0) → falls into the no-data branch below, which
        //    still serves the raw schema/attestation JSON fallback for a bare container (resource
        //    length 1), preserving pre-whiteout behavior.
        (bytes32 dataUID, address dataAttester) = _findDataAtPath(targetAnchor, effLenses);
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
            return (404, "Not Found: No data attached or lens unset", new KeyValue[](0));
        }

        // 3. Get best MIRROR for retrieval URI (scoped to the lens attester)
        (string memory uri, bool hadMirrors) = _getBestMirrorURI(dataUID, dataAttester);

        // 4. Get contentType from PROPERTY on DATA, scoped to the lens attester.
        //    Sanitize at the source (ADR-0024): the PROPERTY value is attester-
        //    controlled, and it flows into the `Content-Type` header on BOTH the
        //    on-chain (web3://) and off-chain (message/external-body) branches.
        //    Sanitizing here closes the header-injection hole on the on-chain
        //    branch (the off-chain branch re-sanitizes, which is idempotent).
        string memory contentType = _sanitizeHeaderValue(_getContentType(dataUID, dataAttester));

        // 5. Content Retrieval & Translation
        if (bytes(uri).length == 0) {
            if (hadMirrors) {
                // Mirrors exist but none have a valid URI — data is stored but unresolvable.
                return (500, bytes("Stored mirror URI is invalid"), new KeyValue[](0));
            }
            return (404, bytes("Not Found: No mirror available"), new KeyValue[](0));
        }

        if (_startsWith(uri, "web3://") && _web3UriServesLocally(uri)) {
            // On-chain fetch: the mirror points at an EFSBytesStore (or any
            // contract exposing the chunkCount()/chunkAddress() interface) ON THIS
            // CHAIN (no `:chainId` suffix, or one equal to block.chainid — see
            // _web3UriServesLocally / ADR-0058). We read the SSTORE2 chunks directly
            // via extcodecopy — the efficient, paginated (EIP-7617) path. The store
            // ALSO implements ERC-5219 (resolveMode/request) so a bare web3://<store>
            // resolves in generic clients; the router doesn't need that path —
            // extcodecopy is cheaper and lens-scoped here. See ADR-0057.
            // A web3:// mirror naming a DIFFERENT chain falls through to the
            // off-chain redirect below (the client resolves it cross-chain).

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
                // Empty store (0 chunks) is a valid empty file, not "not found" —
                // parity with EFSBytesStore.request() (ADR-0057/0058). Must precede
                // the bounds check (chunkIdx 0 >= totalChunks 0 would 404 otherwise).
                if (totalChunks == 0) {
                    headers = new KeyValue[](1);
                    headers[0] = KeyValue("Content-Type", contentType);
                    return (200, "", headers);
                }
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
                    // EIP-7617 next-chunk pointer. MUST be a leading-slash relative URL
                    // re-emitting THIS request's path + routing params (lenses/caller),
                    // so the web3protocol-js client round-trips it back to a byte-
                    // identical request() for chunk N+1 — keeping every chunk on the
                    // same lens-resolved DATA/mirror (no cross-lens splice). A bare
                    // "?chunk=" would throw in the client's URL parser. See ADR-0058.
                    headers[1] = KeyValue(
                        "web3-next-chunk",
                        _nextChunkURL(resource, params, chunkIdx + 1)
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

        // Any other non-empty allowlisted scheme (ipfs://, ar://, https://, magnet:,
        // ftp://, s3://, gs://, dat://, rsync://, bittorrent://, and any future
        // MirrorResolver allowlist addition) is served as an external-body redirect.
        // Same-chain web3:// is handled above (extcodecopy); a CROSS-chain web3://
        // mirror (`:chainId` != block.chainid) also reaches here and is delegated as
        // a redirect to the full `web3://<addr>:<chainId>` URL — a web3://-aware
        // client resolves it on the right chain (EIP-6860, ADR-0058). The retrieval
        // is transport-agnostic — we delegate to the client rather than ever
        // returning the raw URI as the response body.
        // Single Content-Type with the actual type embedded as a parameter,
        // avoiding duplicate headers that clients may collapse or mishandle.
        // Sanitize BOTH interpolated values — strip quotes/backslashes/control bytes to prevent header
        // injection (ADR-0024). The URI is attester-controlled (any lens can attest a MIRROR) and, with
        // the widened off-chain allowlist (ftp/s3/gs/dat/rsync/bittorrent — ADR-0023), a stored value
        // containing `"` or control bytes would otherwise break out of the URL="..." quoted-string and
        // inject header parameters into every client served through that lens. A well-formed URI cannot
        // contain those bytes raw (RFC 3986 requires percent-encoding), so sanitizing only ever affects
        // a malformed/hostile URI — degrading it to a broken redirect, never an injection vector.
        string memory safeUri = _sanitizeHeaderValue(uri);
        string memory safeContentType = _sanitizeHeaderValue(contentType);
        headers = new KeyValue[](1);
        headers[0] = KeyValue(
            "Content-Type",
            string(
                abi.encodePacked(
                    'message/external-body; access-type=URL; URL="',
                    safeUri,
                    '"',
                    bytes(safeContentType).length > 0
                        ? string(abi.encodePacked('; content-type="', safeContentType, '"'))
                        : ""
                )
            )
        );
        return (200, bytes(""), headers);
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
        if (count > MAX_LENSES) count = MAX_LENSES;

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

    /// @dev Whether a `web3://` mirror should be served on-chain by THIS router via
    ///      extcodecopy, vs. delegated to the client as a cross-chain redirect.
    ///      Returns true when the URI carries NO `:chainId` suffix (EFS convention:
    ///      the mirror lives on the router's own chain) or the suffix equals
    ///      `block.chainid`. A suffix naming a DIFFERENT chain cannot be
    ///      extcodecopy'd here — the caller falls through to the
    ///      `message/external-body` redirect so a web3://-aware client resolves it
    ///      on the right chain (EIP-6860). See ADR-0058. Malformed/absurd suffixes
    ///      degrade to local-serve (the address parser then 500s a bad address),
    ///      never a revert.
    function _web3UriServesLocally(string memory uri) private view returns (bool) {
        bytes memory u = bytes(uri);
        if (u.length < 49) return true; // too short to carry a suffix; address parser handles it

        // AGENT-NOTE: this offset math (7 + optional 0x/0X, then 40 hex) MUST stay
        // in lockstep with _parseContractFromWeb3URI — both must locate the address
        // identically or the suffix check lands on the wrong byte. Keep them aligned
        // (or extract a shared `_web3AddrEnd` if either ever changes prefix handling).
        uint256 offset = 7; // past "web3://"
        if (u[offset] == "0" && (u[offset + 1] == "x" || u[offset + 1] == "X")) offset += 2;
        uint256 afterAddr = offset + 40;

        // No `:chainId` suffix → mirror is on this chain by convention → serve locally.
        if (afterAddr >= u.length || u[afterAddr] != ":") return true;

        uint256 chainId = 0;
        bool anyDigit = false;
        for (uint256 i = afterAddr + 1; i < u.length; i++) {
            bytes1 c = u[i];
            if (c < "0" || c > "9") break; // stop at a non-digit (e.g. a trailing "/path")
            chainId = chainId * 10 + (uint8(c) - 48);
            anyDigit = true;
            if (chainId > type(uint64).max) return false; // absurd → not this chain (no overflow revert)
        }
        if (!anyDigit) return true; // ":" with no digits → malformed; serve locally
        return chainId == block.chainid;
    }

    /// @dev Produce a lowercased copy of a string's ASCII A–F range plus the `X` used in the
    ///      `0X` prefix. Used to normalize URL-supplied schema/attestation UIDs before alias-anchor
    ///      name lookup — aliases are stored in lowercase hex (see 06_schema_aliases.ts), so
    ///      `/0XABC…` must match `/0xabc…`. Non-hex / non-`X` bytes pass through unchanged;
    ///      cheaper than full-string lowering and there's no need to handle the rest of the ASCII
    ///      table here. Without the `X` branch, `/0X<uid>/…` URLs parsed correctly by the
    ///      top-level classifier (which accepts `0x` and `0X`) would miss lowercase aliases.
    function _lowercaseHex(string memory str) private pure returns (string memory) {
        bytes memory sb = bytes(str);
        bytes memory out = new bytes(sb.length);
        for (uint i = 0; i < sb.length; i++) {
            bytes1 c = sb[i];
            if ((c >= 0x41 && c <= 0x46) || c == 0x58 /* 'X' */) {
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
    ///
    ///      Zero-value fallthrough: a 40-hex all-zero URL (`/0x0000…0000/foo`) parses
    ///      as address(0), fails the `a != address(0)` guard below, and falls through
    ///      to the Anchor branch. Similarly a 64-hex all-zero UID fails the `uid !=
    ///      bytes32(0)` guard. Both yield `(Anchor, bytes32(0))` — deliberately, per
    ///      ADR-0033's zero-address-poisoning rationale: `address(0)` is not a valid
    ///      container (it's EAS's "no recipient" sentinel, not a user), and `bytes32(0)`
    ///      matches the root anchor UID before indexer wiring.
    ///
    ///      Cost note: on the Schema/Attestation branch this does up to two external
    ///      view calls (`schemaRegistry.getSchema` and `eas.getAttestation`), paid on
    ///      every `web3://` request whose first segment is 64-hex. Unavoidable given
    ///      ADR-0030's no-upgrade rule; clients that resolve the same URLs repeatedly
    ///      should cache the classification off-chain. See ADR-0033 Consequences.
    function _classifyTopLevel(string memory segment) private view returns (ContainerFlavor, bytes32) {
        if (bytes(segment).length == 0) return (ContainerFlavor.Anchor, bytes32(0));

        uint256 hexLen = _effectiveHexLength(segment);

        if (hexLen == 40) {
            address a = _parseAddress(segment);
            if (a != address(0)) {
                return (ContainerFlavor.Address, bytes32(uint256(uint160(a))));
            }
            // address(0) → Anchor fallthrough (ADR-0033 zero-address poisoning guard).
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
            // bytes32(0), malformed, or unregistered/non-existent UID → Anchor fallthrough.
        }

        return (ContainerFlavor.Anchor, bytes32(0));
    }

    /// @notice Public wrapper around the URL top-level classifier.
    /// @dev    Exposed so off-chain clients can keep their own classifier byte-identical
    ///         to the on-chain one (ADR-0033). Pure view; can be cached by clients. The
    ///         returned flavor is a uint8-cast enum: 0 = Anchor, 1 = Address, 2 = Schema,
    ///         3 = Attestation (order matches the ContainerFlavor enum declaration).
    function classifyTopLevel(string calldata segment) external view returns (uint8 flavor, bytes32 uid) {
        (ContainerFlavor f, bytes32 u) = _classifyTopLevel(segment);
        return (uint8(f), u);
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

    // ── EIP-7617 next-chunk URL reconstruction (ADR-0058) ─────────────────────

    /// @dev Build the `web3-next-chunk` header value: a leading-slash, percent-
    ///      encoded reconstruction of THIS request's path with all routing params
    ///      preserved and `chunk` set to `nextIdx`:
    ///        /<enc(seg0)>/<enc(seg1)>/…?<key>=<enc(val)>&…&chunk=<nextIdx>
    ///
    ///      Binding spec = the `web3protocol-js` reference client (`src/mode/5219.js`
    ///      getNextChunk): a next-chunk value is rewritten to a fetchable URL only
    ///      if it starts with "/" (→ `web3://<router>:<chainId><value>`); a bare
    ///      "?chunk=" is fed raw to the URL parser and throws. The client then
    ///      decodes each path segment (`decodeURIComponent`) and each query value
    ///      (`URLSearchParams`), so we percent-encode both to round-trip back to the
    ///      EXACT `resource[]`/`params[]` that produced chunk 0. Re-emitting the
    ///      `lenses`/`caller` params (dropping the OLD `chunk`) keeps chunk N+1 on
    ///      the same lens-resolved DATA/mirror — without it a paginated read under
    ///      `?lenses=alice` would re-resolve chunk N+1 under the default chain and
    ///      splice a different attester's bytes (ADR-0013/0031).
    function _nextChunkURL(
        string[] memory resource,
        KeyValue[] memory params,
        uint256 nextIdx
    ) private pure returns (string memory) {
        bytes memory path = "";
        for (uint256 i = 0; i < resource.length; i++) {
            path = abi.encodePacked(path, "/", _percentEncode(resource[i]));
        }
        if (resource.length == 0) path = "/"; // defensive; request() 404s on empty resource

        bytes memory query = abi.encodePacked("?");
        for (uint256 i = 0; i < params.length; i++) {
            if (_stringsEqual(params[i].key, "chunk")) continue; // replaced below
            query = abi.encodePacked(
                query,
                _percentEncode(params[i].key),
                "=",
                _percentEncode(params[i].value),
                "&"
            );
        }
        query = abi.encodePacked(query, "chunk=", _uintToString(nextIdx));

        return string(abi.encodePacked(path, query));
    }

    /// @dev RFC 3986 percent-encoding: leaves the unreserved set (ALPHA / DIGIT /
    ///      "-" "." "_" "~") literal and percent-encodes every other byte (reserved,
    ///      sub-delims, and ≥0x80) with uppercase hex. Encoding a superset of the
    ///      strictly-required bytes is always reversible by the client's
    ///      decodeURIComponent / URLSearchParams decode, so it can never break the
    ///      round-trip; it only prevents a metacharacter in a name/value from
    ///      re-splitting the path or query.
    function _percentEncode(string memory s) private pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory hexChars = "0123456789ABCDEF";

        uint256 outLen = 0;
        for (uint256 i = 0; i < b.length; i++) {
            outLen += _isUnreserved(uint8(b[i])) ? 1 : 3;
        }
        if (outLen == b.length) return s; // nothing to encode — common fast path

        bytes memory out = new bytes(outLen);
        uint256 j = 0;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (_isUnreserved(c)) {
                out[j++] = bytes1(c);
            } else {
                out[j++] = "%";
                out[j++] = hexChars[c >> 4];
                out[j++] = hexChars[c & 0x0f];
            }
        }
        return string(out);
    }

    /// @dev RFC 3986 unreserved set: ALPHA / DIGIT / "-" "." "_" "~".
    function _isUnreserved(uint8 c) private pure returns (bool) {
        return
            (c >= 0x41 && c <= 0x5A) || // A-Z
            (c >= 0x61 && c <= 0x7A) || // a-z
            (c >= 0x30 && c <= 0x39) || // 0-9
            c == 0x2D || // -
            c == 0x2E || // .
            c == 0x5F || // _
            c == 0x7E;   // ~
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
    function _respondSchemaJSON(bytes32 uid) private view returns (uint16, bytes memory, KeyValue[] memory) {
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
    function _respondAttestationJSON(bytes32 uid) private view returns (uint16, bytes memory, KeyValue[] memory) {
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

    // Find DATA at a path anchor via PIN read — file placement is Shape A (cardinality 1).
    // O(1) read per attester: `EdgeResolver.getActivePinTarget(anchor, attester, dataSchema)`.
    // Returns the DATA UID and the winning attester (used to scope mirror + PROPERTY selection).
    //
    // Fallback priority when no ?lenses= is specified:
    //   1. caller (from ?caller= param or msg.sender if non-zero) — user sees their own files
    //   2. SystemAccount — the `system` lens, the neutral system-provided-defaults author
    //      (ADR-0053; replaces the throwaway deployer EOA of ADR-0016/0039).
    //
    // The `system` lens is default-on but USER-REMOVABLE (ADR-0039/0053, specs/overview.md
    // §Lenses). `lensesExplicit` distinguishes "no ?lenses= param" (apply the caller→system
    // fallback above) from "explicit ?lenses= that parsed to zero valid lenses" (the user has
    // removed every lens, including system, so we must return no data — never silently fall
    // back to caller/system). Without this flag an empty `?lenses=` would be indistinguishable
    // from an absent one, violating viewer sovereignty.
    /// @dev Build the effective attester stack from the parsed `lenses` + caller fallback (ADR-0031 /
    ///      ADR-0039 / ADR-0053). Returns an EMPTY array when the user supplied an explicit `?lenses=`
    ///      that parsed to zero valid lenses (every lens, including system, removed): no data, no
    ///      fallback (viewer sovereignty).
    function _effectiveLenses(
        address[] memory lenses,
        address caller,
        bool lensesExplicit
    ) private view returns (address[] memory attesters) {
        if (lenses.length > 0) {
            return lenses;
        }
        if (lensesExplicit) {
            // Explicit `?lenses=` that parsed to zero valid lenses — viewer removed every lens.
            return new address[](0);
        }
        address systemLens = _systemLens();
        if (caller != address(0)) {
            attesters = new address[](2);
            attesters[0] = caller;
            attesters[1] = systemLens;
        } else {
            attesters = new address[](1);
            attesters[0] = systemLens;
        }
    }

    /// @dev DATA resolution at a single (already path-resolved) anchor over a PRECOMPUTED effective
    ///      lens stack (`attesters`). The caller (`request`) builds the stack once via
    ///      `_effectiveLenses` and reuses it for BOTH the per-segment deep-link whiteout terminal
    ///      and this final-target read, so the two never diverge (ADR-0055 spec/04: a deep link into
    ///      a whited folder 404s on the SAME stack the leaf read uses). An empty stack means the
    ///      viewer removed all lenses → no data (viewer sovereignty), so the caller returns early.
    function _findDataAtPath(
        bytes32 targetAnchor,
        address[] memory attesters
    ) private view returns (bytes32, address) {
        // Empty stack — the viewer removed all lenses → no data (viewer sovereignty). Returning (0,0)
        // here lets the caller still serve the raw schema/attestation JSON fallback for a bare
        // container (resource length 1), matching pre-whiteout behavior.
        if (attesters.length == 0) return (bytes32(0), address(0));
        bytes32 dataSchema = indexer.DATA_SCHEMA_UID();

        // File placement is Shape A — a file Anchor holds at most one DATA per attester.
        // Read the active PIN's target in O(1); skip attesters with an empty slot.
        // (Per ADR-0041 the cardinality lives in the schema UID itself.)
        //
        // ADR-0055 negative terminal: within each lens, in precedence order, check the POSITIVE
        // placement PIN FIRST, then the WHITEOUT. (1) A positive PIN serves that lens's DATA (existing
        // behavior; same-lens positive-before-whiteout override). (2) Otherwise, if the lens has an
        // ACTIVE whiteout on this anchor, that is a negative terminal: serve empty (the router's
        // existing not-found path → 404) and STOP — no fall-through to lower lenses, no system gap-fill.
        // A whiteout by Lk is transparent to any lens ABOVE Lk because a higher lens's positive PIN
        // (or its own whiteout) terminates the scan first. `whiteoutResolver == 0` ⇒ skip the whiteout
        // read entirely (disabled).
        IWhiteoutResolverForRouter wr = whiteoutResolver;
        bytes32 parentAnchor = address(wr) != address(0) ? indexer.getParent(targetAnchor) : bytes32(0);
        for (uint256 i = 0; i < attesters.length; i++) {
            bytes32 target = edgeResolver.getActivePinTarget(targetAnchor, attesters[i], dataSchema);
            if (target != bytes32(0)) return (target, attesters[i]);
            // Negative terminal: this lens masks the path. Stop — serve empty, no fall-through.
            if (address(wr) != address(0) && wr.isWhitedOut(parentAnchor, attesters[i], targetAnchor)) {
                return (bytes32(0), address(0));
            }
        }

        return (bytes32(0), address(0));
    }

    /// @dev RESOLUTION-side per-name whiteout terminal (ADR-0055), shared by the per-SEGMENT deep-link
    ///      walk and shaped identically to `EFSFileView._isItemWhitedOutForResolution`: PIN-ONLY
    ///      positive terminal (a folder's visibility TAG is NOT a placement, so it must not un-gate a
    ///      path traversal). Returns true iff, walking `attesters` in precedence order, some lens
    ///      whites out `childAnchor` under `parentAnchor` with no higher-precedence lens re-asserting
    ///      its own placement PIN there first:
    ///        - the FIRST lens with an active placement PIN at `childAnchor` ⇒ visible, return false
    ///          (same-lens positive-before-whiteout; a higher lens's PIN is transparent to a lower
    ///          lens's whiteout — spec/04 deep-link case);
    ///        - else if that lens has an ACTIVE whiteout on `childAnchor` ⇒ negative terminal, return
    ///          true (stop fall-through — the deep link 404s);
    ///        - else continue to the next (lower) lens.
    ///      `whiteoutResolver == 0` (disabled) short-circuits to false before any read — a pre-WHITEOUT
    ///      router redeploy keeps its exact prior traversal behavior (zero cost when disabled).
    function _isSegmentWhitedOut(
        bytes32 parentAnchor,
        bytes32 childAnchor,
        address[] memory attesters
    ) private view returns (bool) {
        IWhiteoutResolverForRouter wr = whiteoutResolver;
        if (address(wr) == address(0)) return false;
        bytes32 dataSchema = indexer.DATA_SCHEMA_UID();
        for (uint256 i = 0; i < attesters.length; i++) {
            address lens = attesters[i];
            // Positive terminal: this lens places its own content here → visible, stop.
            if (edgeResolver.getActivePinTarget(childAnchor, lens, dataSchema) != bytes32(0)) return false;
            // Negative terminal: this lens whites the segment out → 404, stop (no fall-through).
            if (wr.isWhitedOut(parentAnchor, lens, childAnchor)) return true;
        }
        return false; // no lens asserted a positive or a whiteout → transparent.
    }

    // Get the best mirror URI for a DATA attestation, scoped to the lens attester.
    // Only mirrors attached by `attester` are considered — prevents third parties from
    // injecting mirrors onto a DATA that is served under someone else's lens.
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
                true, // reverseOrder
                false // showRevoked — router serves active mirrors (revoked re-skipped below)
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
                        if (candidate == address(0)) continue; // malformed web3:// — skip
                        // Skip a DEAD same-chain store: if this mirror would be served
                        // on-chain here (same chain, see _web3UriServesLocally) but the
                        // target has no code, picking it would 500 — so fall through and
                        // let a good lower-priority mirror (ar://ipfs://https://) from the
                        // same attester serve instead, honoring multi-mirror redundancy
                        // (ADR-0058). A cross-chain web3:// keeps its top priority (it's
                        // client-redirected, not extcodecopy'd here).
                        if (_web3UriServesLocally(uri) && candidate.code.length == 0) continue;
                        return (uri, true); // web3:// is highest — done
                    }
                    bestPriority = priority;
                    best = uri;
                }
            }
        }
        return (best, hadMirrors);
    }

    // Get contentType from PROPERTY on DATA, scoped to the lens attester (ADR-0041,
    // superseding ADR-0035's append-only TAG-based singleton). PROPERTY value bindings
    // are Shape A (cardinality 1) and live on a PIN under `Anchor<PROPERTY>(parent=DATA,
    // name="contentType")`. Cross-attester protection comes from EdgeResolver._activeBySlot
    // being attester-scoped — only the target attester's PIN is considered, so third
    // parties cannot displace the MIME type.
    function _getContentType(bytes32 dataUID, address attester) private view returns (string memory) {
        bytes32 propertySchema = indexer.PROPERTY_SCHEMA_UID();

        // 1. Resolve the "contentType" key anchor under the DATA. Missing key anchor →
        //    no one has ever labeled this DATA's contentType anywhere.
        bytes32 keyAnchor = indexer.resolveAnchor(dataUID, "contentType", propertySchema);
        if (keyAnchor == bytes32(0)) return "application/octet-stream";

        // 2. O(1) read of the attester's active PROPERTY PIN under that key anchor.
        bytes32 propertyUID = edgeResolver.getActivePinTarget(keyAnchor, attester, propertySchema);
        if (propertyUID == bytes32(0)) return "application/octet-stream";

        // 3. Decode the value.
        IEAS.Attestation memory propAtt = eas.getAttestation(propertyUID);
        string memory value = abi.decode(propAtt.data, (string));
        if (bytes(value).length == 0) return "application/octet-stream";
        return value;
    }
}
