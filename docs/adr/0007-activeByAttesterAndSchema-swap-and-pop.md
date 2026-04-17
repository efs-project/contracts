# ADR-0007: `_activeByAttesterAndSchema` — swap-and-pop compact index

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0003

## Context

Folder listings need to answer: "what's currently TAGged at this path by this attester, with this target schema?" The naive approach (scan all TAGs, filter by `applies=true`) is O(N) per query. With append-only indices (ADR-0009), we can't simply remove revoked entries from the array.

But TAGs have singleton semantics (one active state per `(attester, target, definition)` triple), so we can maintain a separate compact index that only holds *currently-active* targets.

## Decision

`mapping(definition => attester => schema => targets[])` plus a position index `_activeByAASIndex`. On TAG state changes:

- `applies = false → true`: push target to array; record position+1 in index (0 = absent sentinel).
- `applies = true → false`: swap last element into vacated slot, pop, delete index entry.

The array is always exactly the set of currently-active targets. No revoked entries to skip.

## Consequences

- O(1) insert and O(1) remove via swap-and-pop.
- O(1) "is this target currently active?" via the position index.
- O(pageSize) listing — no scan of revoked entries.
- **Order is not chronological after removals** — the swap moves a later element into an earlier slot. So "newest by timestamp" requires scanning all entries and comparing `eas.getAttestation(uid).time` (currently capped at first 50 in the router; see ADR-0020).
- Index is per `(attester, schema, definition)` triple — querying across all attesters requires iterating the attesters array.
