// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { IListReader } from "./interfaces/IListReader.sol";
import { ListEntryResolver } from "./ListEntryResolver.sol";

/**
 * @title ListReader
 * @dev Stateless view contract over ListEntryResolver + EAS. Redeployable without
 *      changing any schema UID (address not baked into any schema). ADR-0044 §5.
 *
 *      getMode() reads LIST attestation directly from EAS (schema-check BEFORE decode).
 *      entries() reads EntryRecord[] from resolver storage — zero per-entry EAS calls.
 *      Typed accessors are safe-by-construction: validate schema, lens, active, listUID, mode.
 */
contract ListReader is IListReader {
    IEAS public immutable eas;
    ListEntryResolver public immutable resolver;
    bytes32 public immutable LIST_SCHEMA_UID;
    bytes32 public immutable LIST_ENTRY_SCHEMA_UID;

    constructor(IEAS _eas, ListEntryResolver _resolver, bytes32 listSchemaUID, bytes32 listEntrySchemaUID) {
        require(address(_eas) != address(0), "eas is zero");
        require(address(_resolver) != address(0), "resolver is zero");
        require(listSchemaUID != bytes32(0), "listSchemaUID is zero");
        require(listEntrySchemaUID != bytes32(0), "listEntrySchemaUID is zero");
        eas = _eas;
        resolver = _resolver;
        LIST_SCHEMA_UID = listSchemaUID;
        LIST_ENTRY_SCHEMA_UID = listEntrySchemaUID;
    }

    // ── IListReader implementation ───────────────────────────────────────────────

    function getMode(bytes32 listUID) external view override returns (ListMode memory m) {
        Attestation memory L = eas.getAttestation(listUID);
        // Schema-check BEFORE data decode (closes SF2 — prevents fake-mode attack)
        if (L.uid == bytes32(0) || L.schema != LIST_SCHEMA_UID) {
            return m; // exists=false (zero struct)
        }
        (m.allowsDuplicates, m.appendOnly, m.targetType, m.targetSchema, m.maxEntries) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        m.exists = true;
        m.curator = L.attester;
    }

    function length(bytes32 listUID, address attester) external view override returns (uint256) {
        return resolver.getLength(listUID, attester);
    }

    function entries(
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) external view override returns (Entry[] memory) {
        // Need targetType from LIST for denormalization
        Attestation memory L = eas.getAttestation(listUID);
        uint8 targetType = 0;
        if (L.uid != bytes32(0) && L.schema == LIST_SCHEMA_UID) {
            (,, targetType,,) = abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        }

        ListEntryResolver.EntryRecord[] memory raw = resolver.getEntries(listUID, attester, start, len);
        Entry[] memory res = new Entry[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            res[i] = Entry({
                entryUID: raw[i].entryUID,
                targetType: targetType,
                identityKey: raw[i].identityKey,
                weight: raw[i].weight
            });
        }
        return res;
    }

    function countOf(bytes32 listUID, address attester, bytes32 identityKey) external view override returns (uint256) {
        return resolver.getMemberCount(listUID, identityKey, attester);
    }

    // ── Typed accessors ──────────────────────────────────────────────────────────
    // `lens` is the attester whose entries you want to read.
    // For a single-curator list this equals getMode().curator.
    // For an open-curation list, pass any contributing attester.
    // Mode is checked before entry validation to fail cheaply on wrong-type calls.

    function targetAsAddress(
        bytes32 listUID,
        address lens,
        bytes32 entryUID
    ) external view override returns (address) {
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 1, "not ADDR-typed list");
        Attestation memory e = _validateEntry(listUID, lens, entryUID);
        return e.recipient;
    }

    function targetAsUID(
        bytes32 listUID,
        address lens,
        bytes32 entryUID
    ) external view override returns (bytes32) {
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 2, "not SCHEMA-typed list");
        Attestation memory e = _validateEntry(listUID, lens, entryUID);
        (, bytes32 target,) = abi.decode(e.data, (bytes32, bytes32, int256));
        return target;
    }

    function targetAsMemberKey(
        bytes32 listUID,
        address lens,
        bytes32 entryUID
    ) external view override returns (bytes32) {
        (, , uint8 mode) = _getListMode(listUID);
        require(mode == 0, "not ANY-typed list");
        Attestation memory e = _validateEntry(listUID, lens, entryUID);
        (, bytes32 target,) = abi.decode(e.data, (bytes32, bytes32, int256));
        return target;
    }

    // ── Identity-key helpers ─────────────────────────────────────────────────────

    function identityKeyForAddress(address a) external pure override returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function identityKeyForUID(bytes32 uid) external pure override returns (bytes32) {
        return uid;
    }

    function identityKeyForMemberKey(bytes32 k) external pure override returns (bytes32) {
        return k;
    }

    // ── Internal helpers ─────────────────────────────────────────────────────────

    /// Validates a single LIST_ENTRY attestation. Reverts unless:
    /// 1. schema == LIST_ENTRY_SCHEMA_UID
    /// 2. attester == lens (trusted lens)
    /// 3. revocationTime == 0 (active)
    /// 4. decoded entryListUID == listUID (belongs to this list)
    function _validateEntry(
        bytes32 listUID,
        address lens,
        bytes32 entryUID
    ) internal view returns (Attestation memory e) {
        e = eas.getAttestation(entryUID);
        require(e.schema == LIST_ENTRY_SCHEMA_UID, "not a list entry");
        require(e.attester == lens, "wrong lens");
        require(e.revocationTime == 0, "entry revoked");
        (bytes32 entryListUID,,) = abi.decode(e.data, (bytes32, bytes32, int256));
        require(entryListUID == listUID, "entry not in this list");
    }

    /// Read targetType from LIST attestation.
    function _getListMode(bytes32 listUID) internal view returns (bool, bool, uint8) {
        Attestation memory L = eas.getAttestation(listUID);
        require(L.uid != bytes32(0) && L.schema == LIST_SCHEMA_UID, "not a list");
        (bool allowsDups, bool appendOnly, uint8 targetType,,) =
            abi.decode(L.data, (bool, bool, uint8, bytes32, uint32));
        return (allowsDups, appendOnly, targetType);
    }
}
