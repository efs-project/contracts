# ADR-0001: Three-layer data model — Paths → Data → Mirrors

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** PR #8 (transports), ADR-0002, ADR-0003

## Context

The original EFS design folded three concerns into a single attestation: a path (what folder is this in?), the data (what bytes?), and the retrieval URI (how do I fetch them?). This made it impossible to:

- Reference the same content from multiple paths.
- Support multiple transports (web3://, ipfs://, ar://, etc.) for the same content.
- Deduplicate identical content across users.
- Update a retrieval URI without re-attesting the file identity.

## Decision

Separate into three layers with explicit relationships:

- **Anchors** — paths/Schelling points. Hierarchical (`refUID` to parent). Permanent and non-revocable.
- **DATA** — file identity. Standalone (`refUID = 0x0`), non-revocable. Schema: `bytes32 contentHash, uint64 size`.
- **MIRRORs** — retrieval URIs. Reference DATA via `refUID`. Schema: `bytes32 transportDefinition, string uri`. Revocable.

Files are placed at paths via TAG attestations (see ADR-0003). Content metadata (contentType, etc.) attaches as PROPERTY attestations on DATA.

## Consequences

- Same content can live at any number of paths (via TAGs) without duplicating storage.
- New transports become Anchors under `/transports/` with no contract change (ADR-0011).
- Content addressability falls out for free (`dataByContentKey`, ADR-0004).
- Retrieval URIs can be updated by attesting new MIRRORs and revoking old ones, leaving file identity untouched.
- Users now think in three concepts instead of one — needs careful UX framing in the production client.
- Increases attestation count per file upload (ANCHOR + DATA + MIRROR + TAG, plus optional PROPERTY) — gas trade-off accepted as the cost of separation.
