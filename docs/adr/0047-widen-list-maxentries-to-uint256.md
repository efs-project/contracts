# ADR-0047: Widen `LIST.maxEntries` from `uint32` to `uint256`

**Status:** Accepted
**Date:** 2026-05-31
**Permanence-tier:** Etched (changes the LIST EAS schema field string → new LIST schema UID)
**Related:** ADR-0044 (LIST/LIST_ENTRY schemas — defines the original field string), ADR-0037 (pinned-fork determinism), PR #20

## Context

ADR-0044 defined the LIST schema's cap field as `uint32 maxEntries`, capping a list at **4,294,967,295** members. That is an "IPv4-class" ceiling — a bound that looks enormous until a real use case walks past it:

- Asia's population ≈ **4.7 billion** > `uint32` max.
- World population ≈ **8.1 billion** > `uint32` max.

A "citizens of Asia", "all humans", or any planet-scale allowlist literally cannot declare its true cap under `uint32`. (The cap is a *declaration* — such a list is not filled entry-by-entry on-chain — but the declared bound must still be expressible, and off-chain / L2 / future consumers read it.)

The fix is essentially free and is only possible **before the schemas are frozen with real data**:

- EAS attestation data is **ABI-encoded into 32-byte words**. `uint32` and `uint256` both occupy exactly one 32-byte slot, so the LIST record stays **160 bytes** either way (`EXPECTED_LIST_DATA_LEN` unchanged). No calldata or attestation-storage growth.
- Resolver addresses are nonce-CREATE (ADR-0037) and **bytecode-independent**, so widening the field does **not** move any resolver address — only the LIST schema UID changes.

This is pre-mainnet, pre-real-data devnet; the schema UID change costs nothing now and would be impossible post-freeze.

## Decision

Change the LIST schema field `maxEntries` from **`uint32`** to **`uint256`**.

New LIST field string:

```
bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries
```

`LIST_ENTRY` is unchanged. This supersedes **only** the width of the `maxEntries` field in ADR-0044; every other part of ADR-0044's LIST schema (the other four fields, the modes, the resolver behavior) stays in force.

We chose `uint256` over `uint64`: the field occupies a full 32-byte word regardless, so capping it below `uint256` is an artificial limit with zero storage benefit. Match the slot; never revisit.

## Consequences

- **New `LIST_SCHEMA_UID`** (the field string hashes into the UID). Regenerated `deployedContracts.ts` (ABI-only diff: `uint32`→`uint256` in the `ListAttested` event and `getMode`/`ListMode` outputs). Resolver addresses unchanged. `LIST_ENTRY_SCHEMA_UID` unchanged.
- **Zero on-chain bloat** (ABI 32-byte-word padding). The `CachedListDecl` struct field widens to `uint256` (one extra resolver-storage slot per cached list at most — upgradeable resolver state, negligible).
- **Clients parse `maxEntries` as `bigint`** (viem decodes `uint256` as `bigint`, not `number`); the debug UI's create forms parse the input with `BigInt(...)` and drop the old `uint32` ceiling check.
- **Codifies a sizing principle** for the schema-freeze pass: schema fields that **count real-world entities** (people, bytes, items) need wide types (the IPv4 lesson); **discriminator / enum / flag** fields (`targetType`, the bools) are naturally bounded and stay narrow. Audit all nine EFS schemas through this lens before freeze — `DATA.size` (`uint64`) and `TAG`/`PIN` weight (`int256`) already follow it; `maxEntries` was the lone outlier.

## Alternatives considered

- **`uint64`** — covers any conceivable count (1.8×10¹⁹). Rejected only because `uint256` is the *same* 32-byte cost and removes the question entirely.
- **Leave `uint32`, document the limit** — rejected: it's a real, reachable ceiling for a credibly-neutral public file system that explicitly invites planet-scale curation, and the fix is free pre-freeze.
