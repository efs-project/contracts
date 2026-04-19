# ADR-0008: Qualifying-folder write-time index (removed)

**Status:** Superseded in place by the tag-only folder-visibility refactor (2026-04-18). See ADR-0006 revised.
**Date:** 2026-04-16
**Related:** PR #8 commits 279a2a2, 8ada426, ADR-0006, ADR-0010

> **Revised in place 2026-04-18 during pre-alpha refactor.** The write-time
> `_qualifyingFolders` / `_hasQualifyingFolder` indices and their `onAttest`
> ancestor walk have been **removed** from `EFSIndexer`. Folder visibility is now
> single-source (explicit TAG only). See the revised ADR-0006 for the new model.
> The original decision is preserved at the bottom for historical context.
>
> Permission for in-place edit: confirmed by project owner 2026-04-18.

## Current state (2026-04-18 onward)

`EFSFileView.getDirectoryPageBySchemaAndAddressList` paginates `TagResolver._childrenTaggedWith[parent][dataSchemaUID]` via opaque cursor ([ADR-0036](./0036-opaque-cursor-pagination.md)) and filters for active applies=true TAGs by any edition attester. No write-time index. No ancestor walk in `EFSIndexer.onAttest`. The earlier `_getQualifyingTaggedFolders` helper that pre-materialized the whole folder set has been removed along with its `MAX_TAGGED_FOLDERS = 10000` silent-truncation cap.

The ancestor walk has moved to the client (`CreateItemModal` on file upload), where it emits visibility TAGs at each generic ancestor the attester hasn't already claimed. This keeps kernel gas costs predictable and makes the "is this my folder" claim a per-attester, revocable statement rather than an append-only write-time index.

### Consequences of the removal

- Ghost-folder bug fixed (folders don't stay visible after the last file is revoked, because the visibility TAG can itself be revoked).
- `EFSIndexer.onAttest` is simpler: no ancestor walk on every file-anchor creation.
- Uploader pays extra gas for the ancestor walk — up to `MAX_ANCHOR_DEPTH - 1` TAG attestations on the first upload into a new subtree, near-zero thereafter (walk exits fast once ancestors are already tagged).
- `_containsAttestations` is preserved. It's still used by `getChildrenByAddressList` / `getAnchorsBySchemaAndAddressList` to filter file-anchor children, not folders.
- The write-time dedup map `_hasQualifyingFolder` and the storage array `_qualifyingFolders` are both removed from contract storage. `getQualifyingFolders` / `getQualifyingFolderCount` view functions are gone.

---

## Original decision (superseded in place 2026-04-18)

*Preserved for historical context. No longer in force.*

> ### Context
>
> `_getQualifyingTaggedFolders` originally scanned all generic subfolders under a parent, checking each for files of the requested schema. This was O(N_total_subfolders) per directory listing — fine for small directories, catastrophic for ones with thousands of subfolders. Capping the scan at 500 was the first attempted fix, but silently truncated results.
>
> ### Decision
>
> EFSIndexer maintains a write-time index:
>
> ```
> mapping(parent => contentSchema => attester => folderUIDs[]) _qualifyingFolders
> mapping(parent => contentSchema => attester => folder => bool) _hasQualifyingFolder
> ```
>
> When an ANCHOR with `anchorSchema != 0` (a file-typed anchor) is created inside a generic folder, the indexer walks up the ancestor chain (bounded by `MAX_ANCHOR_DEPTH = 32`) and records each ancestor folder under its parent's qualifying list. The dedup guard ensures each `(ancestor, schema, attester, folder)` tuple is recorded exactly once.
>
> Reading is O(M_qualifying) where M is the number of folders that actually contain matching content — independent of total subfolder count.
>
> ### Consequences (original)
>
> - Schema-filtered directory listings scale to any directory size (no silent cap).
> - Two SSTOREs per ancestor on first file creation in a deep tree (~32 max) — one to push the folder UID into `_qualifyingFolders`, one to set the `_hasQualifyingFolder` dedup bool. Amortized O(1) for repeat uploads (the dedup guard short-circuits).
> - `_anchorSchemaOf[uid]` cache (one SSTORE per ANCHOR creation) enables O(1) parent-type checks without re-decoding EAS attestation data.
> - Sticky semantics: a folder that once contained matching content stays in the qualifying index even if all content is removed. Consistent with `_containsAttestations` (ADR-0010). UI may want to cross-check with `containsAttestations()` to hide empty folders.
> - Source B (explicit TAG of empty folders) remains as a separate path so users can opt empty folders into visibility.
