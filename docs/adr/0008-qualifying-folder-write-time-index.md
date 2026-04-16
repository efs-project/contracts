# ADR-0008: Qualifying-folder write-time index

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commits 279a2a2, 8ada426, ADR-0006

## Context

`_getQualifyingTaggedFolders` originally scanned all generic subfolders under a parent, checking each for files of the requested schema. This was O(N_total_subfolders) per directory listing — fine for small directories, catastrophic for ones with thousands of subfolders. Capping the scan at 500 was the first attempted fix, but silently truncated results.

## Decision

EFSIndexer maintains a write-time index:

```
mapping(parent => contentSchema => attester => folderUIDs[]) _qualifyingFolders
mapping(parent => contentSchema => attester => folder => bool) _hasQualifyingFolder
```

When an ANCHOR with `anchorSchema != 0` (a file-typed anchor) is created inside a generic folder, the indexer walks up the ancestor chain (bounded by `MAX_ANCHOR_DEPTH = 32`) and records each ancestor folder under its parent's qualifying list. The dedup guard ensures each `(ancestor, schema, attester, folder)` tuple is recorded exactly once.

Reading is O(M_qualifying) where M is the number of folders that actually contain matching content — independent of total subfolder count.

## Consequences

- Schema-filtered directory listings scale to any directory size (no silent cap).
- One extra SSTORE per ancestor on first file creation in a deep tree (~32 max). Amortized O(1) for repeat uploads (the dedup guard short-circuits).
- `_anchorSchemaOf[uid]` cache (one SSTORE per ANCHOR creation) enables O(1) parent-type checks without re-decoding EAS attestation data.
- Sticky semantics: a folder that once contained matching content stays in the qualifying index even if all content is removed. Consistent with `_containsAttestations` (ADR-0010). UI may want to cross-check with `containsAttestations()` to hide empty folders.
- Source B (explicit TAG of empty folders) remains as a separate path so users can opt empty folders into visibility.
