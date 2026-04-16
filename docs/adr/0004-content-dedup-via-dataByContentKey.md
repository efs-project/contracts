# ADR-0004: Content dedup via `dataByContentKey`

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0001, ADR-0002

## Context

DATA is content-addressed (`bytes32 contentHash`). Without dedup, every user uploading the same image creates a new DATA attestation, wasting gas and fragmenting metadata.

## Decision

EFSIndexer maintains `mapping(bytes32 => bytes32) public dataByContentKey`. The first DATA attestation for a given `contentHash` becomes canonical. Subsequent uploads of the same content discover the canonical DATA and skip creating a new one — only a new TAG is needed to place it at the desired path.

## Consequences

- Storage savings: identical content costs one DATA attestation total across all users.
- Metadata accumulates on the canonical DATA — PROPERTYs (contentType), MIRRORs (alternative transports), all visible from any path it's TAGged at.
- Race condition: two users uploading the same content simultaneously will both attempt to be canonical; the second loses gracefully (sees the canonical UID and reuses it).
- Content collisions theoretically possible but practically impossible at SHA256 strength — accepted.
- The Toolbar must check `dataByContentKey` before creating a new DATA. Documented in upload flow.
- Dedup is by content alone; doesn't account for filename or contentType — those are PROPERTYs and accumulate across all users of the canonical DATA.
