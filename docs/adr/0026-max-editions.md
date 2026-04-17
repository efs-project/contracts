# ADR-0026: `MAX_EDITIONS = 20`

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commits f687b57, 01e6c87

## Context

The `?editions=` URL parameter accepts a comma-separated list of addresses. Without a cap, a crafted URL with thousands of addresses causes:
- Unbounded gas in `_findDataAtPath` (one TAG-index lookup per attester).
- Memory allocation proportional to the address count.
- Potential array OOB if parsing logic doesn't match allocation size.

## Decision

`uint256 public constant MAX_EDITIONS = 20;` enforced in `_parseAddressList`. Excess addresses are silently truncated (the array is allocated at MAX_EDITIONS size and the parser breaks out of the loop once the array is full).

## Consequences

- **Gas-bounded URL parsing** even on adversarial input.
- 20 editions is generous for typical use (most users follow a handful of curators).
- Silent truncation > revert: a 25-address URL still works, with the first 20 honored. A revert would block the entire request.
- Power users wanting >20 editions need a different mechanism. See `docs/FUTURE_WORK.md` (potential: edition list as an Anchor with member PROPERTYs, allowing arbitrary list length on-chain).
