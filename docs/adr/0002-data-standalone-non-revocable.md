# ADR-0002: DATA is standalone and non-revocable

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0001, ADR-0003

## Context

Previously DATA attestations were attached to a parent Anchor via `refUID` and were revocable. This meant:
- DATA had a single parent path (couldn't be shared).
- Revoking DATA implicitly removed the file from its location.
- Two users with the same content created two distinct DATA attestations.

The three-layer model (ADR-0001) requires DATA to be referenceable from any number of paths.

## Decision

DATA attestations have:
- `refUID = 0x0` (no parent)
- `revocable = false` (permanent)

Placement at a path is done via TAG (ADR-0003). Removal from a path is done by revoking or untagging the TAG, not by touching DATA.

## Consequences

- DATA can be referenced (TAGged) at any number of paths.
- `dataByContentKey` content dedup works — first DATA per `contentHash` is canonical (ADR-0004).
- Non-revocability is philosophically aligned: "these bytes exist" is a fact, not a claim that should be retractable. Removal from a folder is a separate concern.
- Metadata (PROPERTYs, MIRRORs) accumulates on the canonical DATA and is visible from all paths.
- Cannot "delete a file" in the EAS sense — only untag it from all paths. Acceptable: orphaned DATA is invisible without a TAG anchoring it.
