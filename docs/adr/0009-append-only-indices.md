# ADR-0009: Append-only indices stay append-only

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0007, ADR-0010

## Context

Most kernel indices in EFSIndexer (`_referencingAttestations`, `_taggedTargets`, `_tagDefinitions`, `_children`, `_childrenBySchema`, `_childrenByAttester`) are arrays. When an attestation is revoked, the question is whether to remove it from these arrays.

Removal options:
1. Search-and-remove: O(N) scan, expensive.
2. Swap-and-pop: O(1) but breaks chronological order, requires position index per array.
3. Mark-and-skip: O(1) write (set `_isRevoked[uid] = true`), readers filter on iteration.

## Decision

Kernel indices are append-only. Revocation only sets `_isRevoked[uid] = true`. Readers must check `isRevoked()` if they want active-only results, or pass `showRevoked = false` to indexer functions that filter for them.

The exception is `_activeByAAS` in TagResolver (ADR-0007), which uses swap-and-pop because TAG singleton semantics make it tractable.

## Consequences

- Cheap writes — one SSTORE for revocation regardless of how many indices the attestation appears in.
- No storage refund edge cases (deleting a slot from an array involves swap or zero-write — the gas accounting is fragile in some EVM versions).
- Readers pay the filtering cost. `_sliceUIDsFiltered` and similar helpers do this efficiently.
- **Indices grow monotonically** — over many years with frequent revocations, arrays may contain mostly revoked entries. The `maxTraversal` caps in some functions limit the read-time damage. Off-chain indexers (The Graph) can present cleaner views.
- Future consideration: garbage collection (compaction) is a future possibility but not on the roadmap. See `docs/FUTURE_WORK.md`.
