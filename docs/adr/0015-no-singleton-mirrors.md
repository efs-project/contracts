# ADR-0015: No singleton enforcement for MIRRORs

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0012, ADR-0013

## Context

TAGs are singletons per `(attester, target, definition)` triple — one active state at a time, supersession enforced. Should MIRRORs follow the same pattern? An attester wanting to update their `ipfs://` mirror could either revoke the old one and attest a new one (two transactions), or just attest a new one (singleton supersession).

## Decision

Multiple MIRRORs per `(transport, attester, dataUID)` are allowed. No singleton enforcement.

## Consequences

- Simpler attest flow: one transaction to add a new mirror.
- Revoking is optional — old mirrors stay until explicitly revoked. Revoked mirrors are skipped by `_getBestMirrorURI` (ADR-0009 + isRevoked filter).
- Multiple active mirrors of the same transport type: the router picks by priority, then iteration order within the per-attester index. Deterministic but not necessarily "newest wins."
- If an attester accumulates many obsolete `https://` mirrors, the scan cap (`MAX_PAGES = 10`, ADR-0020) eventually starts missing them — but they're equivalent priority anyway, so impact is minimal.
- Trade-off: no clean "rotate to a new gateway" UX — old URLs remain serveable until manually revoked. Consider client-side tooling for bulk revocation.
