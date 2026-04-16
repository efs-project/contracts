# ADR-0019: Non-reverting hex parser

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0026

## Context

The router parses addresses from URL parameters (`?editions=0x...`, `?caller=0x...`) and from web3:// mirror URIs. If parsing reverts on invalid hex characters, a single malformed input bricks the entire request — even when valid fallbacks exist (other editions, lower-priority mirrors).

## Decision

`_hexCharToByte` returns `0xFF` as a sentinel for invalid hex characters instead of reverting. Callers check the sentinel and handle gracefully:
- Malformed `?editions=` address → that address becomes `address(0)` (no results from it; other editions still tried).
- Malformed `web3://` mirror URI → skip and try lower-priority mirrors.
- Malformed `?caller=` → `address(0)` → fall back to deployer (ADR-0016).

## Consequences

- **No DoS via malformed input**: a single bad URL doesn't break the page.
- Failures degrade gracefully instead of catastrophically.
- Slight defensive coding overhead — every caller of `_hexCharToByte` must check the sentinel.
- `address(0)` has no content in the EFS model (no attestations possible), so it's safe as a no-op default.
