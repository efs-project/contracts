// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title EFSBytesStore — production on-chain byte store for EFS `web3://` content
/// @notice Holds an ordered list of SSTORE2 chunk contracts (each runtime is
///         `0x00 || chunkBytes`, the SSTORE2 STOP-opcode convention) and exposes
///         the bytes two ways:
///
///         1. **Chunk interface** — `chunkCount()` / `chunkAddress(i)`. The
///            `EFSRouter` uses this with `extcodecopy` for an efficient,
///            paginated (EIP-7617) on-chain read of the winning lens's mirror.
///
///         2. **ERC-5219 resource** — `resolveMode() == "5219"` +
///            `request(...)` serves the file one chunk per call with EIP-7617
///            pagination (a `web3-next-chunk` header chains the chunks), returning
///            each chunk's raw bytes with a `Content-Type` header, so
///            `web3://<EFSBytesStore>` resolves to the exact file in ANY standard
///            web3:// client (EIP-4804 / ERC-6860 / ERC-5219 — `web3protocol`,
///            w3link, eth.limo, evm-browser) with no EFS-specific code on the
///            reader, at any file size (per-chunk reads stay under eth_call caps).
///
///         Replaces the prototype `MockChunkedFile`. See ADR-0057.
///
///         Freeze-safety: this is a per-file deployable helper. Its address is
///         never hashed into a schema UID — it is only ever the target of a
///         `web3://` MIRROR string (ADR-0049). Deploying or re-shaping it touches
///         nothing in the frozen schema set.
contract EFSBytesStore {
    struct KeyValue {
        string key;
        string value;
    }

    address[] private _chunks;

    /// @dev MIME type returned by the ERC-5219 `request()` path. The router path
    ///      ignores this and uses the lens-scoped `contentType` PROPERTY instead;
    ///      this is for generic clients that hold a bare `web3://<store>` URL.
    string private _contentType;

    /// @param chunks       Ordered SSTORE2 chunk contract addresses (each runtime
    ///                     is `0x00 || chunkBytes`).
    /// @param contentType_ MIME type for the ERC-5219 path. Empty => served as
    ///                     `application/octet-stream` (ADR-0018 fallback).
    ///                     Trailing underscore avoids shadowing `contentType()`.
    constructor(address[] memory chunks, string memory contentType_) {
        for (uint256 i = 0; i < chunks.length; i++) {
            _chunks.push(chunks[i]);
        }
        _contentType = contentType_;
    }

    // ── Chunk interface (router extcodecopy path) ─────────────────────────────

    function chunkCount() external view returns (uint256) {
        return _chunks.length;
    }

    function chunkAddress(uint256 index) external view returns (address) {
        return _chunks[index];
    }

    /// @notice The MIME type this store reports for its content (ERC-5219 path).
    function contentType() external view returns (string memory) {
        return _contentType;
    }

    // ── ERC-5219 resource (generic web3:// client path) ───────────────────────

    /// @notice EIP-6944 / ERC-5219 manual resolve mode marker.
    function resolveMode() external pure returns (bytes32) {
        return "5219";
    }

    /// @notice ERC-5219 request handler with EIP-7617 chunk pagination. Returns the
    ///         bytes of a SINGLE chunk (chunk 0 by default), plus a `web3-next-chunk`
    ///         header pointing at the next chunk when more remain. A standard web3://
    ///         client walks that header chain and concatenates the chunk bodies into
    ///         the whole file; a single-chunk store returns the whole file in one call
    ///         with no next header. Per-chunk reads (~24KB) keep every response under
    ///         node `eth_call` return-size/gas caps, so arbitrarily large files
    ///         resolve via a bare `web3://<store>` — the whole point of pagination.
    /// @dev    Return shape `(uint16 statusCode, bytes body, KeyValue[] headers)` —
    ///         the de-facto tuple decoded by the `web3protocol-js` reference client
    ///         (`src/mode/5219.js`: `[{uint16},{bytes},{tuple[]}]`, body enqueued as
    ///         raw bytes; binary-safe, no base64/UTF-8 transform). Mirrors
    ///         `EFSRouter`'s web3:// branch (per-chunk extcodecopy, `chunk` param,
    ///         `web3-next-chunk` header). See ADR-0057.
    ///
    ///         `resource` (path segments) is ignored — a byte store is a single file
    ///         addressed by the contract itself, so any sub-path resolves to the
    ///         file; pathing lives in the EFS router/anchor layer, not the store.
    ///         `params` is read ONLY for the `chunk` index.
    ///
    ///         The `web3-next-chunk` value is `/?chunk=<n>` (LEADING SLASH). The
    ///         reference client only rewrites a relative next-chunk value into a
    ///         fetchable URL when it starts with `/` (`5219.js` getNextChunk); a bare
    ///         `?chunk=<n>` is fed raw to the URL parser and throws. The leading-slash
    ///         form round-trips back as `request([], [("chunk","<n>")])`.
    function request(
        string[] memory /* resource */,
        KeyValue[] memory params
    ) external view returns (uint16 statusCode, bytes memory body, KeyValue[] memory headers) {
        uint256 count = _chunks.length;
        string memory ct = bytes(_contentType).length == 0 ? "application/octet-stream" : _contentType;

        // Empty store = a valid empty file: 200 with an empty body, no next chunk.
        if (count == 0) {
            headers = new KeyValue[](1);
            headers[0] = KeyValue("Content-Type", ct);
            return (200, "", headers);
        }

        uint256 index = _chunkIndexFromParams(params);

        // Explicit out-of-bounds index. A conformant client never asks for this (it
        // only follows advertised next-chunk links), and a garbage `chunk` string
        // parses to 0 — so this fires only on an explicit decimal >= count. Matches
        // the router's "Chunk out of bounds" 404.
        if (index >= count) {
            return (404, bytes("Chunk out of bounds"), new KeyValue[](0));
        }

        // No-code chunk = corrupt/incomplete store: fail loudly rather than serve a
        // truncated 200, matching the router's "Storage contract has no code" 500.
        // (A 1-byte STOP-only chunk is a valid empty payload; size == 1 is allowed.)
        address chunk = _chunks[index];
        uint256 size;
        assembly {
            size := extcodesize(chunk)
        }
        if (size == 0) {
            return (500, bytes("Chunk contract has no code"), new KeyValue[](0));
        }

        body = _readChunk(chunk, size);

        if (index + 1 < count) {
            headers = new KeyValue[](2);
            headers[0] = KeyValue("Content-Type", ct);
            headers[1] = KeyValue("web3-next-chunk", _nextChunkValue(index + 1));
        } else {
            headers = new KeyValue[](1);
            headers[0] = KeyValue("Content-Type", ct);
        }

        return (200, body, headers);
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /// @dev Read one chunk's payload. The runtime is `0x00 || data` (SSTORE2
    ///      convention), so we skip the leading STOP byte: copy `size - 1` bytes from
    ///      code offset 1. A STOP-only chunk (`size == 1`) yields empty bytes. Caller
    ///      has already ruled out `size == 0` (no-code 500). Memory-safe: `new
    ///      bytes(len)` allocates exactly the data region the extcodecopy fills.
    function _readChunk(address chunk, uint256 size) private view returns (bytes memory out) {
        if (size > 1) {
            uint256 len = size - 1;
            out = new bytes(len);
            assembly {
                extcodecopy(chunk, add(out, 0x20), 1, len)
            }
        }
    }

    /// @dev Find the `chunk` param and parse its decimal value. Non-reverting: an
    ///      absent key, empty value, or non-digit garbage all yield 0 — so a bare
    ///      `web3://<store>` (no `?chunk=`) serves chunk 0. Mirrors
    ///      `EFSRouter._parseUint`; self-contained (no shared base with the router).
    function _chunkIndexFromParams(KeyValue[] memory params) private pure returns (uint256) {
        bytes32 wantKey = keccak256(bytes("chunk"));
        for (uint256 i = 0; i < params.length; i++) {
            if (keccak256(bytes(params[i].key)) == wantKey) {
                return _parseUint(params[i].value);
            }
        }
        return 0;
    }

    /// @dev Decimal string → uint256, non-reverting (any non-digit byte or empty → 0).
    function _parseUint(string memory str) private pure returns (uint256 result) {
        bytes memory b = bytes(str);
        if (b.length == 0) return 0;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c < 48 || c > 57) return 0;
            result = result * 10 + (c - 48);
        }
    }

    /// @dev The `web3-next-chunk` header value for next index `n` — `/?chunk=<n>`
    ///      (leading slash; see the `request` dev note on the reference client).
    function _nextChunkValue(uint256 n) private pure returns (string memory) {
        return string(abi.encodePacked("/?chunk=", _uintToString(n)));
    }

    /// @dev uint256 → decimal string.
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
}
