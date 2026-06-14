// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";

/**
 * @title ListEntryResolver
 * @dev Resolver for the EFS LIST_ENTRY schema (ADR-0044). Write-time enforcement engine.
 *
 *      LIST_ENTRY schema: "bytes32 listUID, bytes32 target" (ADR-0046)
 *      revocable: true (rejected by resolver when LIST.appendOnly == true)
 *
 *      A LIST_ENTRY is pure membership identity. Ordering and free-text labels are
 *      PROPERTYs placed on the (stable) entry UID via the standard PIN pattern (ADR-0046),
 *      not schema fields — so reorder supersedes the order PROPERTY in O(1) without
 *      churning the entry UID, and attached metadata survives.
 *
 *      Storage is "wide" — EntryRecord[] stores identityKey inline so on-chain
 *      consumers iterate membership without per-entry eas.getAttestation(). Mirrors
 *      ADR-0041's TagEntry[] widening for the same block-gas-limit reason.
 *
 *      Per-mode encoding (enforced at write time):
 *        ADDR (1): recipient = address (incl. 0); target must be bytes32(0)
 *        SCHEMA (2): target = attestation UID (must exist, schema must match); recipient = 0
 *        ANY (0):  target = opaque nonzero bytes32 member key; recipient = 0
 */
contract ListEntryResolver is SchemaResolver {
    // ── Errors ──────────────────────────────────────────────────────────────────
    error BadPayload();
    error WrongSchema();
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
        uint8 targetType
    );

    event ListEntryRevoked(
        bytes32 indexed listUID,
        address indexed attester,
        bytes32 indexed identityKey,
        bytes32 entryUID,
        uint8 targetType
    );

    // ── Constants ───────────────────────────────────────────────────────────────
    uint256 private constant EXPECTED_ENTRY_DATA_LEN = 64; // 2 × 32 (ADR-0046: weight removed)
    // The LIST_ENTRY field string — MUST match deploy/09_lists.ts exactly (it's hashed into
    // the schema UID at registration). Used to self-derive this resolver's own LIST_ENTRY
    // schema UID so onAttest/onRevoke can reject attestations from any OTHER schema that an
    // attacker registers pointing at this resolver (which would otherwise bypass write-time
    // enforcement and pollute membership state). See `_listEntrySchemaUID`.
    string private constant LIST_ENTRY_DEFINITION = "bytes32 listUID, bytes32 target";
    bytes32 public immutable LIST_SCHEMA_UID;
    // EAS UID = keccak256(abi.encodePacked(schemaString, resolver, revocable)); the resolver
    // address (this) and revocable (true) are fixed, so we can recompute our own schema UID.
    bytes32 private immutable _listEntrySchemaUID;

    // ── Storage: LIST declaration cache ─────────────────────────────────────────
    struct CachedListDecl {
        bool exists;
        bool allowsDuplicates;
        bool appendOnly;
        uint8 targetType;
        bytes32 targetSchema;
        uint256 maxEntries;
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
    }

    mapping(bytes32 listUID => mapping(address attester => EntryRecord[])) private _entries;

    // O(1) membership + no-dupes counter
    mapping(bytes32 listUID => mapping(bytes32 identityKey => mapping(address attester => uint256)))
        private _entryCount;

    // Swap-and-pop index: entryUID → (position in _entries[list][attester]) + 1
    mapping(bytes32 entryUID => uint256) private _entryPosPlusOne;

    // ── Storage: per-list attester (lens/edition) index ──────────────────────────
    // The set of attesters who have ever contributed an entry to a list — the list's
    // "editions"/lenses. On-chain and append-only (ADR-0009): consensus state that smart
    // contracts and clients enumerate WITHOUT relying on event logs. Membership is never
    // removed on revoke; "active" lenses are those whose getLength(listUID, attester) > 0.
    mapping(bytes32 listUID => address[]) private _listAttesters;
    mapping(bytes32 listUID => mapping(address attester => bool)) private _isListAttester;

    // ── Constructor ─────────────────────────────────────────────────────────────
    constructor(IEAS eas, bytes32 listSchemaUID) SchemaResolver(eas) {
        require(listSchemaUID != bytes32(0), "listSchemaUID is zero");
        LIST_SCHEMA_UID = listSchemaUID;
        _listEntrySchemaUID = keccak256(abi.encodePacked(LIST_ENTRY_DEFINITION, address(this), true));
    }

    // ── Resolver hooks ──────────────────────────────────────────────────────────

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        // Only LIST_ENTRY attestations may mutate membership state. EAS lets anyone register
        // a new schema pointing at this resolver; without this guard such a schema's attests
        // would be processed as entries, bypassing the write-time type/dup/cap enforcement.
        if (a.schema != _listEntrySchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Lifecycle invariants (ADR-0044)
        if (!a.revocable) revert NotRevocable();
        if (a.expirationTime != 0) revert HasExpiration();
        if (a.refUID != bytes32(0)) revert UsesRefUID();

        (bytes32 listUID, bytes32 target) = abi.decode(a.data, (bytes32, bytes32));
        if (listUID == bytes32(0)) revert MissingListUID();

        // Hydrate + cache LIST declaration (LIST is immutable; cache valid forever)
        CachedListDecl memory d = _decl[listUID];
        if (!d.exists) {
            Attestation memory L = _eas.getAttestation(listUID);
            if (L.schema != LIST_SCHEMA_UID) revert NotAList();
            (d.allowsDuplicates, d.appendOnly, d.targetType, d.targetSchema, d.maxEntries) = abi.decode(
                L.data,
                (bool, bool, uint8, bytes32, uint256)
            );
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
        _entries[listUID][a.attester].push(EntryRecord({ entryUID: a.uid, identityKey: identityKey }));
        _entryPosPlusOne[a.uid] = _entries[listUID][a.attester].length;
        _entryCount[listUID][identityKey][a.attester] += 1;

        // Record this attester as a lens/edition of the list (once, append-only).
        if (!_isListAttester[listUID][a.attester]) {
            _isListAttester[listUID][a.attester] = true;
            _listAttesters[listUID].push(a.attester);
        }

        emit ListEntryAttested(listUID, a.attester, identityKey, a.uid, d.targetType);
        return true;
    }

    function onRevoke(Attestation calldata a, uint256) internal override returns (bool) {
        if (a.schema != _listEntrySchemaUID) revert WrongSchema();
        if (a.data.length != EXPECTED_ENTRY_DATA_LEN) revert BadPayload();

        // Idempotency check FIRST — stale revoke (entryUID not indexed) → silent no-op
        uint256 pp1 = _entryPosPlusOne[a.uid];
        if (pp1 == 0) return true;

        (bytes32 listUID, ) = abi.decode(a.data, (bytes32, bytes32));

        CachedListDecl memory d = _decl[listUID];
        // Unreachable in normal EAS flow: the `pp1 == 0` guard above already returned for any
        // entry this resolver never indexed (so onAttest, which populates `_decl[listUID]`,
        // must have run for any entry that reaches here). Kept as a defensive invariant rather
        // than an expected path.
        if (!d.exists) revert UnknownList();

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
        // `len > total - start` (not `start + len > total`): the early `start >= total`
        // return above makes `total - start` underflow-safe, and avoids the `start + len`
        // overflow that would revert a `len = type(uint256).max` "read all" request.
        if (len > total - start) len = total - start;
        EntryRecord[] memory res = new EntryRecord[](len);
        for (uint256 i = 0; i < len; i++) res[i] = arr[start + i];
        return res;
    }

    function getMemberCount(bytes32 listUID, bytes32 identityKey, address attester) external view returns (uint256) {
        return _entryCount[listUID][identityKey][attester];
    }

    /// @notice On-chain, paginated enumeration of a list's lenses/editions: every attester who
    ///         has ever contributed an entry. Append-only — to get only ACTIVE lenses, filter by
    ///         `getLength(listUID, attester) > 0`. Smart-contract and client consumers use this
    ///         instead of event logs (which are not consensus state).
    /// @dev    Paginated (like `getEntries`) so an open-curation list with many distinct attesters
    ///         stays enumerable on-chain — an unbounded `address[]` return is O(N^2) on memory
    ///         expansion and can OOG / time out an `eth_call`. The signature is locked here before
    ///         the mainnet schema freeze (ADR-0044 §8): changing it later mints a new LIST_ENTRY UID.
    function getListAttesters(bytes32 listUID, uint256 start, uint256 len) external view returns (address[] memory) {
        address[] storage arr = _listAttesters[listUID];
        uint256 total = arr.length;
        if (total == 0 || start >= total) return new address[](0);
        // `len > total - start` (not `start + len > total`): the early `start >= total`
        // return above makes `total - start` underflow-safe, and avoids the `start + len`
        // overflow that would revert a `len = type(uint256).max` "read all" request.
        if (len > total - start) len = total - start;
        address[] memory res = new address[](len);
        for (uint256 i = 0; i < len; i++) res[i] = arr[start + i];
        return res;
    }

    function getListAttesterCount(bytes32 listUID) external view returns (uint256) {
        return _listAttesters[listUID].length;
    }
}
