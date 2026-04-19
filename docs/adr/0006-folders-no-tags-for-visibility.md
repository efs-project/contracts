# ADR-0006: Folder visibility is tag-only

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0003, ADR-0008, ADR-0010, ADR-0031

> **Revised in place 2026-04-18 during pre-alpha refactor.** The original decision
> ("folders don't need TAGs for visibility") made folder membership dual-sourced:
> a write-time `_qualifyingFolders` index plus an optional TAG. That coupling
> produced ghost folders under revoke (folders with no active content but still
> shown, because the write-time index is append-only and the TAG isn't required).
> Pre-alpha has no deployed data, so we collapsed to a single-source model:
> folders are visible iff at least one edition attester has an active
> `TAG(definition=dataSchemaUID, refUID=folder, applies=true)`. The Decision and
> Consequences below reflect the revised model. The original text is preserved at
> the bottom for historical context.
>
> Permission for in-place edit: confirmed by project owner 2026-04-18.

## Context

A folder is visible in an edition-scoped directory listing only if the reader's edition chain has some reason to consider it "theirs." Pre-refactor, that reason was dual-sourced:

- **Source A**: the `_qualifyingFolders` write-time index — any ancestor of a file-anchor child was added to the parent's qualifying-folder list at attest time, by any attester, forever. Append-only by ADR-0009.
- **Source B**: an explicit `TAG(definition=dataSchemaUID, refUID=folder, applies=true)` by an edition attester — used for the "create empty folder that's visible immediately" case.

Source A was cheap and automatic but had two consequences that became pain:

1. **Ghost folders on revoke.** When every file placement TAG under a folder is revoked, the folder itself stays in `_qualifyingFolders` forever (append-only). UI shows "4 items" but the listing renders empty. Fixing it via de-propagation would cost a reverse walk on every revoke and still miss the case where DATA remains but no one points at it.
2. **Dual source is hard to reason about.** Two paths to visibility means every read has to check both, and every mutation has to consider both. Hides bugs.

Folder visibility is inherently per-edition (who says this is their folder?). The TAG is already the natural per-edition claim. The write-time index was a cheap shortcut that muddied the semantics.

## Decision

Folder visibility is **single-source**: a folder appears in an edition-scoped listing iff at least one edition attester has an active applies=true `TAG(definition=dataSchemaUID, refUID=folder)`.

- Folder creation still does **not** TAG itself implicitly at the kernel layer. Membership via `ANCHOR.refUID = parentUID` remains the structural record (used by non-edition-filtered views and by the `web3://` anchor walk).
- Visibility in edition listings is a separate, per-attester property expressed through TAGs.
- The upload flow (client-side) walks the ancestor chain from the immediate parent up to root exclusive and emits a visibility TAG at every ancestor that the attester hasn't already tagged. That's how intermediate folders become visible in the uploader's edition.
- `CreateItemModal`'s existing empty-folder visibility TAG (attested when creating a folder with no content) becomes the same kind of TAG, emitted by the creator, consistent with the new model.
- Folder deletion: revoke the attester's visibility TAG on the target folder + cascade-revoke the attester's file placement TAGs in the subtree (to prevent orphaned placements discoverable via "which files has this user placed?" queries).

`EFSFileView._getQualifyingTaggedFolders` now reads TagResolver's `_childrenTaggedWith` and filters on active applies=true TAGs by any edition attester. No fallback to `_qualifyingFolders`.

## Consequences

- Ghost-folder bug disappears structurally.
- Upload flow gains an ancestor walk: up to `MAX_ANCHOR_DEPTH=32` reads + up to N writes where N is the number of currently-untagged ancestors. For the steady state (after the first upload into a subtree), the walk exits early because every ancestor is already tagged. First upload into a new subtree costs one extra TAG per generic ancestor.
- Delete cascade is now well-defined: revoke visibility TAG on the root folder + revoke placement TAGs on every file in the subtree. No orphan placements.
- Symmetry with files is partially restored: both files and folder visibility flow through TAGs. Folder *creation* still doesn't require a TAG (the anchor attestation remains the structural record), but folder *visibility* does.
- Client-side logic is concentrated in `CreateItemModal` (upload + ancestor walk) and `FileBrowser` (delete cascade).
- `_qualifyingFolders` storage and ancestor-walk code removed from `EFSIndexer`. `_containsAttestations` is preserved — still used by file-anchor filtering in `getChildrenByAddressList` / `getAnchorsBySchemaAndAddressList`.
- Cross-edition visibility: if Alice uploads `/a/b/file.txt`, her visibility TAG on `/a` and `/b` doesn't make those folders visible to Bob's edition — Bob has to tag them himself. Matches ADR-0031's first-attester-wins edition model.

## Alternatives considered

- **Keep dual-source, add de-propagation.** Reference-count `_qualifyingFolders` entries and walk up on every revoke. Rejected: gas cost at every untag (every file delete), still-complex semantics, and doesn't address "is this my folder" being fundamentally per-edition.
- **Auto-emit visibility TAG on folder creation in the kernel.** Reduces client responsibility but bloats `onAttest` with conditional work and still needs the ancestor walk on deep uploads (the anchor attestation only knows its immediate parent). Rejected for the same reasons auto-tagging generally is — kernel should index, not express edition claims.
- **Skip the upload-time ancestor walk and require the user to tag each ancestor manually.** Rejected as bad UX; nobody wants to tag five folders to see their file show up.

---

## Original decision (superseded in place 2026-04-18)

*Preserved for historical context. No longer in force.*

> Folder creation does **not** TAG. Folder membership is established by `ANCHOR.refUID = parentUID` and indexed natively by EFSIndexer (`_children`, `_childrenBySchema`, `_qualifyingFolders`).
>
> EFSFileView's subfolder listing uses these EFSIndexer indices (`getAnchorsBySchemaAndAddressList`), not TagResolver's `_activeByAAS`.
>
> Consequences (original):
> - ~50–100K gas saved per folder creation (one fewer attestation).
> - Folder visibility in schema-filtered listings comes from two sources (ADR-0008): the write-time qualifying-folder index (folders containing files), and explicit TAG (for empty folders the user wants visible).
> - Empty folders that need to appear in schema-filtered listings can still be explicitly tagged (Source B in `_getQualifyingTaggedFolders`). This is a deliberate user action; the UI doesn't do it automatically.
> - Symmetry is lost: files use TAGs, folders don't. Worth documenting in the production client's mental model.
