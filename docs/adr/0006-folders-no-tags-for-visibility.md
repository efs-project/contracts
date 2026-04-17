# ADR-0006: Folders don't need TAGs for visibility

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0003, ADR-0008

## Context

Early implementations attested a TAG on every folder creation (`TAG(definition = parentUID, applies = true, refUID = newAnchorUID)`). This was symmetric with file placement — but folders are already structurally tracked by EFSIndexer through `ANCHOR.refUID = parentUID`. The TAG was redundant: it cost gas and added entries to `_activeByAAS` that no read function consulted.

## Decision

Folder creation does **not** TAG. Folder membership is established by `ANCHOR.refUID = parentUID` and indexed natively by EFSIndexer (`_children`, `_childrenBySchema`, `_qualifyingFolders`).

EFSFileView's subfolder listing uses these EFSIndexer indices (`getAnchorsBySchemaAndAddressList`), not TagResolver's `_activeByAAS`.

## Consequences

- ~50–100K gas saved per folder creation (one fewer attestation).
- Folder visibility in schema-filtered listings comes from two sources (ADR-0008): the write-time qualifying-folder index (folders containing files), and explicit TAG (for empty folders the user wants visible).
- Empty folders that need to appear in schema-filtered listings can still be explicitly tagged (Source B in `_getQualifyingTaggedFolders`). This is a deliberate user action; the UI doesn't do it automatically.
- Symmetry is lost: files use TAGs, folders don't. Worth documenting in the production client's mental model.
