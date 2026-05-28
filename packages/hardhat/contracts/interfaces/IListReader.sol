// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IListReader {
    struct ListMode {
        bool exists;
        address curator; // LIST.attester
        bool allowsDuplicates;
        bool appendOnly;
        uint8 targetType; // 0=ANY, 1=ADDR, 2=SCHEMA
        bytes32 targetSchema; // nonzero iff targetType==SCHEMA
        uint32 maxEntries;
    }

    struct Entry {
        bytes32 entryUID;
        uint8 targetType; // denormalized from LIST.targetType
        bytes32 identityKey; // recipient(ADDR), UID(SCHEMA), member-key(ANY)
        int256 weight;
    }

    /// Decode LIST attestation directly from EAS. Schema-checked BEFORE data decode.
    /// Works for empty lists. Returns exists=false for non-LIST UIDs.
    function getMode(bytes32 listUID) external view returns (ListMode memory);

    /// Number of active entries for (list, attester). O(1).
    function length(bytes32 listUID, address attester) external view returns (uint256);

    /// Page of active entries (insertion order). No per-entry eas.getAttestation() —
    /// all fields read inline from EntryRecord[]. Pagination is NOT snapshot-isolated.
    function entries(
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) external view returns (Entry[] memory);

    /// O(1) membership check. Compare to 0 explicitly — no isMember bool (ADR-0044 §5).
    /// identityKey: bytes32(uint160(addr)) for ADDR, UID for SCHEMA, member key for ANY.
    function countOf(bytes32 listUID, address attester, bytes32 identityKey) external view returns (uint256);

    // ── Typed accessors (safe-by-construction) ──────────────────────────────────
    // Each requires: LIST_ENTRY schema, entry.attester==lens, active, entryListUID==listUID, mode match.
    // `lens` is the attester whose entries you want to read (same semantics as `attester` in
    // length/entries/countOf). For a single-curator list, lens == getMode().curator.
    // For open-curation lists, pass any contributing attester.

    function targetAsAddress(bytes32 listUID, address lens, bytes32 entryUID) external view returns (address);

    function targetAsUID(bytes32 listUID, address lens, bytes32 entryUID) external view returns (bytes32);

    function targetAsMemberKey(bytes32 listUID, address lens, bytes32 entryUID) external view returns (bytes32);

    // ── Identity-key derivation helpers (pure) ──────────────────────────────────
    function identityKeyForAddress(address a) external pure returns (bytes32);

    function identityKeyForUID(bytes32 uid) external pure returns (bytes32);

    function identityKeyForMemberKey(bytes32 k) external pure returns (bytes32);
}
