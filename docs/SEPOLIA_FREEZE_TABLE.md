# Sepolia frozen-UID table (sign-off gate)

> **Human gate (ADR-0048).** James signs off on this table **before** any schema is registered on Sepolia. Once registered with data, each row's shape is permanent: changing a field string, type, `revocable`, or the resolver address orphans that schema's data.
>
> `UID = keccak256(abi.encodePacked(fieldString, resolverAddress, revocable))`. The resolver address below is the **proxy** (never the implementation). Addresses are filled after the CREATE2 proxies are deployed (ADR-0048 deploy step 2); UIDs are computed off-chain in step 3.

## The 8 schemas to freeze

| # | Schema | Field string (exact) | revocable | Resolver (proxy) | Schema UID |
|---|---|---|---|---|---|
| 1 | ANCHOR | `string name, bytes32 schemaUID` | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 2 | PROPERTY | `string value` | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 3 | DATA | `bytes32 contentHash, uint64 size` | `false` | EFSIndexer proxy `0x…TBD` | `0x…TBD` |
| 4 | PIN | `bytes32 definition` | `true` | EdgeResolver proxy `0x…TBD` | `0x…TBD` |
| 5 | TAG | `bytes32 definition, int256 weight` | `true` | EdgeResolver proxy `0x…TBD` | `0x…TBD` |
| 6 | MIRROR | `bytes32 transportDefinition, string uri` | `true` | MirrorResolver proxy `0x…TBD` | `0x…TBD` |
| 7 | LIST | `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries` | `false` | ListResolver proxy `0x…TBD` | `0x…TBD` |
| 8 | LIST_ENTRY | `bytes32 listUID, bytes32 target` | `true` | ListEntryResolver proxy `0x…TBD` | `0x…TBD` |

## Explicitly NOT frozen now (addable later, no orphaning)

- **SORT_INFO** — deferred with its `EFSSortOverlay` resolver.
- **BLOB** — dropped (redundant with DATA+MIRROR; unvalidated).
- **NAMING** — dropped (schema-name tooling; `SchemaNameIndex` not deployed).
- **EVENT/TRANSITION** — not yet designed; the one real schema gap, additive (separate proposal).

## Pre-registration verification (all must pass before registering)

- [ ] Each resolver address above is a **proxy**, not an implementation.
- [ ] Each proxy's `initialize(...)` is locked (second call reverts).
- [ ] `ListEntryResolver` self-derived UID (`keccak256(LIST_ENTRY_DEFINITION, address(this), true)`) equals row 8's UID.
- [ ] Field strings byte-for-byte match the registered schemas.
- [ ] Upgrade admin = James's controlled key (not burned/renounced/throwaway).

## Sign-off

- [ ] **James** — frozen-UID table approved for Sepolia registration. Date: ________
