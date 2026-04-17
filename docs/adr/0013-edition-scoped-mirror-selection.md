# ADR-0013: Edition-scoped mirror selection

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit 8267487, ADR-0012, ADR-0031

## Context

Originally, `_getBestMirrorURI` considered all MIRROR attestations referencing a DATA, regardless of attester. This created a spam vector: a malicious user could attest a `https://` MIRROR pointing at evil.com on someone else's DATA. If their MIRROR happened to be the highest priority (or appear first), the router would serve their URL when a viewer requested the legitimate DATA.

## Decision

`_getBestMirrorURI` only considers MIRRORs whose attester matches the **edition attester** — the address whose TAG resolved the DATA at this path.

Implemented via `getReferencingBySchemaAndAttester(dataUID, mirrorSchema, attester, ...)` — a per-attester index that doesn't scan other attesters' MIRRORs at all.

## Consequences

- **Mirror injection attacks blocked**: third parties cannot override what the legitimate edition attester serves.
- The viewer's `?editions=` parameter implicitly determines which set of MIRRORs is even considered.
- An edition attester can still spam their own MIRRORs — but that's self-DoS, not an external attack.
- Mirrors attested by attesters NOT in `?editions=` are ignored entirely. If you want your mirror to be considered for a DATA, you must be one of the editions the viewer is looking at.
- Per-attester indices in EFSIndexer support this efficiently — no full scan.
