// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListEntryResolver
 * @dev Resolver for the EFS LIST_ENTRY schema (ADR-0044). Write-time enforcement engine.
 *
 *      LIST_ENTRY schema: "bytes32 listUID, bytes32 target, int256 weight"
 *      revocable: true (rejected by resolver when LIST.appendOnly == true)
 *
 *      Storage is "wide" — EntryRecord[] stores identityKey+weight inline so on-chain
 *      consumers iterate without per-entry eas.getAttestation(). Mirrors ADR-0041's
 *      TagEntry[] widening for the same block-gas-limit reason.
 *
 *      Per-mode encoding (enforced at write time):
 *        ADDR (1): recipient = address (incl. 0); target must be bytes32(0)
 *        SCHEMA (2): target = attestation UID (must exist, schema must match); recipient = 0
 *        ANY (0):  target = opaque nonzero bytes32 member key; recipient = 0
 */
contract ListEntryResolver is SchemaResolver {
    // ── Errors ──────────────────────────────────────────────────────────────────
    error BadPayload();
    error NotRevocable();
    error HasExpiration();
    error UsesRefUID();
    error MissingListUID();
    error NotAList();
    error BadAddrMode();
    error BadRecipient();
    error BadSchemaTarget();
    error TargetMissing();
    error TargetSchemaMismatch();
    error BadAnyTarget();
    error DuplicateIdentity();
    error ListFull();
    error ListIsAppendOnly();
    error UnknownList();

    // ── Events ──────────────────────────────────────────────────────────────────
    event ListEntryAttested(
        bytes32 indexed listUID,
        address indexed attester,
        bytes32 indexed identityKey,
        bytes32 entryUID,
        uint8 targetType,
        int256 weight
    );

    event ListEntryRevoked(
        bytes32 indexed listUID,
        address indexed attester,
        bytes32 indexed identityKey,
        bytes32 entryUID,
        uint8 targetType
    );

    // ── Constants ───────────────────────────────────────────────────────────────
    uint256 private constant EXPECTED_ENTRY_DATA_LEN = 96; // 3 × 32
    bytes32 public immutable LIST_SCHEMA_UID;

    // ── Storage: LIST declaration cache ─────────────────────────────────────────
    struct CachedListDecl {
        bool exists;
        bool allowsDuplicates;
        bool appendOnly;
        uint8 targetType;
        bytes32 targetSchema;
        uint32 maxEntries;
    }

    // LIST is non-revocable → cache is valid forever after first touch
    mapping(bytes32 listUID => CachedListDecl) private _decl;

    // ── Storage: Wide entry records ──────────────────────────────────────────────
    // identityKey semantics:
    //   ADDR:   bytes32(uint256(uint160(recipient)))  ← zero if address(0), valid
    //   SCHEMA: target (the attestation UID)
    //   ANY:    target (the opaque member key, nonzero)
    struct EntryRecord {
        bytes32 entryUID;
        bytes32 identityKey;
        int256 weight;
    }

    mapping(bytes32 listUID => mapping(address attester => EntryRecord[])) private _entries;

    // O(1) membership + no-dupes counter
    mapping(bytes32 listUID => mapping(bytes32 identityKey => mapping(address attester => uint256))) private _entryCount;

    // Swap-and-pop index: entryUID → (position in _entries[list][attester]) + 1
    mapping(bytes32 entryUID => uint256) private _entryPosPlusOne;

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(IEAS eas, bytes32 listSchemaUID) SchemaResolver(eas) {
        require(listSchemaUID != bytes32(0), "listSchemaUID is zero");
        LIST_SCHEMA_UID = listSchemaUID;
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Lifecycle invariants (ADR-0044)
        if (!a.revocable) revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();
        if (a.refUID != bytes32(0)) revert UsesRefUID();

        (bytes32 listUID, bytes32 target, int256 weight) = abi.decode(a.data, (bytes32, bytes32, int256));
        if (listUID == bytes32(0)) revert MissingListUID();

        // Hydrate + cache LIST declaration (LIST is immutable; cache valid forever)
        CachedListDecl memory d = _decl[listUID];
        if (!d.exists) {
            Attestation memory L = _eas.getAttestation(listUID);
            if (L.schema != LIST_SCHEMA_UID) revert NotAList();
            // LIST schema: "string name, bool allowsDuplicates, bool appendOnly, uint8 targetType,
            //               bytes32 targetSchema, uint32 maxEntries"
            (, d.allowsDuplicates, d.appendOnly, d.targetType, d.targetSchema, d.maxEntries) =
                abi.decode(L.data, (string, bool, bool, uint8, bytes32, uint32));
            d.exists = true;
            _decl[listUID] = d;
        }

        // Per-mode encoding + identity-key derivation
        bytes32 identityKey;

        if (d.targetType == 1 /* ADDR */) {
            if (target != bytes32(0)) revert BadAddrMode(); // address lives in recipient
            // address(0) is a valid ADDR entry — identityKey = bytes32(0) is permitted
            identityKey = bytes32(uint256(uint160(a.recipient)));
        } else if (d.targetType == 2 /* SCHEMA */) {
            if (a.recipient != address(0)) revert BadRecipient();
            if (target == bytes32(0)) revert BadSchemaTarget();
            Attestation memory t = _eas.getAttestation(target);
            if (t.uid == bytes32(0)) revert TargetMissing();
            if (t.schema != d.targetSchema) revert TargetSchemaMismatch();
            // No revocation check — entries are immune to target lifecycle (ADR-0044)
            identityKey = target;
        } else {
            /* ANY (0) */
            if (a.recipient != address(0)) revert BadRecipient();
            if (target == bytes32(0)) revert BadAnyTarget(); // must be nonzero member key
            identityKey = target;
        }

        // No-duplicates enforcement (per-attester lens)
        if (!d.allowsDuplicates) {
            if (_entryCount[listUID][identityKey][a.attester] != 0) revert DuplicateIdentity();
        }

        // Cap enforcement (per-attester)
        if (d.maxEntries != 0) {
            if (_entries[listUID][a.attester].length >= d.maxEntries) revert ListFull();
        }

        // Append wide record + index
        _entries[listUID][a.attester].push(EntryRecord({ entryUID: a.uid, identityKey: identityKey, weight: weight }));
        _entryPosPlusOne[a.uid] = _entries[listUID][a.attester].length;
        _entryCount[listUID][identityKey][a.attester] += 1;

        emit ListEntryAttested(listUID, a.attester, identityKey, a.uid, d.targetType, weight);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Idempotency check FIRST — stale revoke (entryUID not indexed) → silent no-op
        uint256 pp1 = _entryPosPlusOne[a.uid];
        if (pp1 == 0) return true;

        (bytes32 listUID,,) = abi.decode(a.data, (bytes32, bytes32, int256));

        CachedListDecl memory d = _decl[listUID];
        if (!d.exists) revert UnknownList(); // should never fire — onAttest ran first

        // Append-only: reject revocation entirely
        if (d.appendOnly) revert ListIsAppendOnly();

        // Swap-and-pop. Read identityKey inline from array record — no side map needed.
        uint256 idx = pp1 - 1;
        EntryRecord[] storage arr = _entries[listUID][a.attester];
        bytes32 identityKey = arr[idx].identityKey;
        uint256 last = arr.length - 1;
        if (idx != last) {
            arr[idx] = arr[last];
            _entryPosPlusOne[arr[idx].entryUID] = idx + 1;
        }
        arr.pop();
        delete _entryPosPlusOne[a.uid];
        _entryCount[listUID][identityKey][a.attester] -= 1;

        emit ListEntryRevoked(listUID, a.attester, identityKey, a.uid, d.targetType);
        return true;
    }

    // ── View functions (used by ListReader) ─────────────────────────────────────

    function getLength(bytes32 listUID, address attester) external view returns (uint256) {
        return _entries[listUID][attester].length;
    }

    function getEntries(
        bytes32 listUID,
        address attester,
        uint256 start,
        uint256 len
    ) external view returns (EntryRecord[] memory) {
        EntryRecord[] storage arr = _entries[listUID][attester];
        uint256 total = arr.length;
        if (total == 0 || start >= total) return new EntryRecord[](0);
        if (start + len > total) len = total - start;
        EntryRecord[] memory res = new EntryRecord[](len);
        for (uint256 i = 0; i < len; i++) res[i] = arr[start + i];
        return res;
    }

    function getMemberCount(bytes32 listUID, bytes32 identityKey, address attester) external view returns (uint256) {
        return _entryCount[listUID][identityKey][attester];
    }
}
