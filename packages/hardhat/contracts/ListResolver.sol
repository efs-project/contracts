// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IEAS, Attestation } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { EFSUpgradeableResolver } from "./base/EFSUpgradeableResolver.sol";

/**
 * @title ListResolver
 * @dev Resolver for the EFS LIST schema (ADR-0044). Validates field shape at attest time.
 *      Maintains no state — all enforcement state lives in ListEntryResolver.
 *
 *      LIST schema: "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries"
 *      revocable: false (LIST is permanent — identity of a list, like DATA)
 *
 *      Upgradeable (ADR-0048): runs behind an ERC1967 proxy whose ADDRESS is the EAS resolver
 *      baked into the LIST schema UID. Stateless pure validation — no per-deployment config or
 *      owner, so initialize() is empty; only the impl's _disableInitializers() (in the base
 *      constructor) is load-bearing, locking the implementation against direct initialization.
 */
contract ListResolver is EFSUpgradeableResolver {
    uint256 private constant EXPECTED_LIST_DATA_LEN = 160; // 5 × 32

    // The LIST field string — FROZEN (ADR-0044) and MUST match the deploy registration exactly (it is
    // hashed into the LIST schema UID). Used to self-derive this resolver's own LIST schema UID so
    // onAttest can reject attestations from any OTHER schema an attacker registers against this
    // resolver — which would otherwise pass the shape checks and emit ListAttested (polluting
    // event/RPC list discovery with fake lists that ListReader/ListEntryResolver later reject).
    string private constant LIST_DEFINITION =
        "bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries";

    event ListAttested(
        bytes32 indexed listUID,
        address indexed attester,
        bool allowsDuplicates,
        bool appendOnly,
        uint8 indexed targetType,
        bytes32 targetSchema,
        uint256 maxEntries
    );

    constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

    /// @notice One-time per-deployment initialization, run behind the proxy.
    /// @dev Guarded by `initializer` — callable exactly once per proxy. ListResolver is pure
    ///      validation with no config or owner, so this is intentionally empty; it exists only
    ///      to consume the proxy's one-shot initializer slot symmetrically with the other EFS
    ///      resolvers.
    function initialize() external initializer {}

    function onAttest(Attestation calldata a, uint256) internal override returns (bool) {
        // Foreign-schema guard (matches AliasResolver/ListEntryResolver/MirrorResolver/EdgeResolver):
        // EAS invokes this resolver for ANY schema registered against it. Only the canonical LIST
        // schema may pass — else a foreign 5-word non-revocable schema would clear the shape checks
        // below and emit ListAttested. Self-derived: address(this) under the proxy delegatecall IS the
        // resolver baked into the LIST schema UID; LIST is non-revocable (the `false`). Derived inline
        // (no stored config) — LIST attestations are infrequent, so the keccak cost is negligible.
        require(a.schema == keccak256(abi.encodePacked(LIST_DEFINITION, address(this), false)), "wrong LIST schema");
        require(a.data.length == EXPECTED_LIST_DATA_LEN, "bad LIST payload");
        require(!a.revocable, "LIST must be non-revocable");
        require(a.expirationTime == 0, "LIST must not expire");
        require(a.refUID == bytes32(0), "LIST must be free-floating");
        require(a.recipient == address(0), "LIST must not be directed");

        (bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries) = abi
            .decode(a.data, (bool, bool, uint8, bytes32, uint256));

        require(targetType <= 2, "invalid targetType");

        if (targetType == 2 /* SCHEMA */) {
            require(targetSchema != bytes32(0), "SCHEMA mode requires targetSchema");
        } else {
            require(targetSchema == bytes32(0), "non-SCHEMA mode must have zero targetSchema");
        }

        // Reject the only unbounded combination: append-only + duplicates-allowed + uncapped
        if (appendOnly && allowsDuplicates) {
            require(maxEntries != 0, "appendOnly+allowsDuplicates requires maxEntries cap");
        }

        emit ListAttested(a.uid, a.attester, allowsDuplicates, appendOnly, targetType, targetSchema, maxEntries);
        return true;
    }

    // onRevoke is unreachable — LIST is non-revocable. Implemented to satisfy abstract base.
    function onRevoke(Attestation calldata, uint256) internal override returns (bool) {
        return true;
    }
}
