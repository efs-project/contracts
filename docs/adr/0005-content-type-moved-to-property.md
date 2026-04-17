# ADR-0005: ContentType moved from DATA to PROPERTY

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0001, ADR-0014

## Context

The old DATA schema embedded `contentType` as a field. This:
- Bloated DATA (a frequently-attested record).
- Made contentType immutable (DATA is non-revocable).
- Coupled identity to a piece of metadata that's a hint, not part of identity.

## Decision

DATA schema is `bytes32 contentHash, uint64 size`. ContentType is a separate PROPERTY attestation:

```
PROPERTY(key = "contentType", value = "image/jpeg", refUID = dataUID, attester = msg.sender)
```

The router's `_getContentType` reads PROPERTYs on the DATA, scoped to the edition attester (ADR-0014), and returns the value or `application/octet-stream` as fallback.

## Consequences

- DATA stays minimal. Per-attester contentType becomes possible (Alice may have a different correct contentType than Bob — rare but possible).
- ContentType can be revoked or superseded without touching DATA.
- One extra attestation per upload (the PROPERTY). Acceptable cost.
- Default `application/octet-stream` is the safe fallback when no PROPERTY exists.
- Other metadata (e.g. previousVersion, fileMode) follows the same pattern via PROPERTY.
