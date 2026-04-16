# ADR-0021: `MAX_ANCHOR_DEPTH = 32`

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0008, ADR-0010

## Context

Several functions walk the ancestor chain: `propagateContains`, the qualifying-folder index, depth validation on Anchor creation. Without a cap, a malicious user could create a deeply nested chain and trigger expensive gas consumption on subsequent operations.

## Decision

`uint256 public constant MAX_ANCHOR_DEPTH = 32;`

Enforced at:
- Anchor creation (`onAttest`): rejects with `AnchorTooDeep()` if creation would exceed depth 32.
- `_propagateContains`: breaks the loop after MAX_ANCHOR_DEPTH iterations as defense-in-depth (creation cap should make this unreachable).
- `_qualifyingFolders` walk: same defense-in-depth.

## Consequences

- Bounded gas on all ancestor-walking operations: ~32 × 2,100 gas per warm SLOAD = ~67K worst case.
- Practical filesystem depth: 32 levels is generous (most file systems show signs of pathology well before this).
- An attacker can't create a chain deeper than 32 — gas griefing via depth is impossible.
- If real users ever need deeper trees, the constant can be raised in a future EFS version (mainnet permanence ADR-0030 means it can't be raised in the deployed contract — they'd have to re-attest under a new EFS).
