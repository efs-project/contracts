# ADR-0020: `MAX_PAGES = 10` mirror scan cap

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit c548351, ADR-0009, ADR-0015

## Context

The append-only mirror index (`_referencingBySchemaAndAttester`) grows unboundedly. If an attester accumulates thousands of MIRRORs (including revoked ones) for one DATA, scanning the full set on every router request would exceed eth_call gas budgets on RPC gateways.

## Decision

The router pages through the per-attester mirror index in chunks of 50, capped at 10 pages — scanning at most 500 mirrors per `request()`. If the best mirror isn't in the first 500, it's an adversarial or degenerate case.

```solidity
uint256 PAGE = 50;
uint256 MAX_PAGES = 10; // 500 mirrors total
for (uint256 offset = 0; offset < total && pages < MAX_PAGES; offset += PAGE) { ... }
```

Inner early-exit: a valid `web3://` mirror returns immediately (highest priority). Other priorities require finishing the scan to ensure no higher-priority mirror exists in later pages.

## Consequences

- **Bounded gas**: 500 × ~5K gas per mirror ≈ 2.5M gas worst case. Within eth_call budgets.
- **Best mirror always selected for typical use** (handful of mirrors per DATA).
- **At very high mirror counts** (>500 per attester per DATA), some valid mirrors are not considered. Self-inflicted by the attester. Documented in `docs/FUTURE_WORK.md` for revisit if it becomes a real problem.
- The early `return` on valid web3:// is not just an optimization — it's the only correct early-exit. Other priorities can still lose to a higher-priority mirror in a later page.
