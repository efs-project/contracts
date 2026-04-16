# ADR-0003: TAG-based file placement instead of refUID

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0001, ADR-0002

## Context

Originally, file placement was implicit: DATA's `refUID` pointed at an Anchor, so DATA was "in" that folder. This coupled file identity to placement and made multi-folder placement and per-attester editions impossible.

## Decision

Files are placed at paths via TAG attestations:

```
TAG(definition = anchorUID, applies = true, refUID = dataUID, attester = msg.sender)
```

- `definition` — the path Anchor where the file appears
- `refUID` — the DATA being placed
- `applies = true/false` — placed or removed (singleton supersession via TagResolver)
- `attester` — who placed it (this is the edition identity)

Removal: a new TAG with `applies = false` (clean) or EAS revocation of the TAG attestation (also clean, but irreversible).

## Consequences

- **Cross-referencing**: same DATA can be TAGged at any number of paths.
- **Per-attester editions**: Alice and Bob can independently TAG the same DATA at the same path; or different DATAs at the same path. The router resolves which to serve via the `?editions=` parameter (ADR-0031).
- **Clean untag semantics**: `applies=false` removes without revoking the historical attestation.
- **Compact index**: `_activeByAttesterAndSchema` (ADR-0007) gives O(1) listings of "what's currently placed here by this attester."
- More attestations per upload (ANCHOR + DATA + MIRROR + TAG vs. just DATA in the old model). Gas cost accepted.
- Folder-level visibility is structural (not TAG-based — see ADR-0006).
