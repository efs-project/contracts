# ADR-0038: Tag-only folder visibility (single-source)

**Status:** Accepted
**Date:** 2026-04-19
**Related:** ADR-0003, ADR-0006 (superseded), ADR-0008, ADR-0009, ADR-0010, ADR-0031, ADR-0036

## Context

[ADR-0006](./0006-folders-no-tags-for-visibility.md) was revised in place on 2026-04-18 to change folder-visibility semantics from dual-source (write-time `_qualifyingFolders` index OR explicit TAG) to single-source (TAG only). That was a decision change, not a prose-accuracy correction, and the project's ADR discipline is explicit: **in-place edits are never allowed for the Decision section's content, the Consequences semantics, or the Alternatives considered arguments.** A later 2026-04-19 correction compounded the in-place drift by adding a "Correction" section addressing an obsolete Consequences bullet after ADR-0036 had already rewritten the relevant view.

A PR-review comment on #9 flagged both edits as violating the discipline. The right mechanism is a fresh ADR that supersedes ADR-0006. This ADR collects the current authoritative state — the same decision ADR-0006's revised body already described — so that:

- ADR-0006 remains in the repo with its original (pre-2026-04-18) Decision unmodified and `Status: Superseded by ADR-0038`.
- Future agents reading this ADR see one clean record rather than a chain of in-place revisions.
- The grace-period norm (prose-accuracy edits within 30 days of write-up) is preserved without erosion.

EFS is pre-ship; no deployed data relies on the older dual-source semantics.

## Decision

Folder visibility in a lens-scoped directory listing is **single-source**: a folder appears iff at least one lens attester has an active (existing and not revoked) `TAG(definition=dataSchemaUID, refUID=folder)`.

### What this means concretely

- **Folder creation** is unchanged: it's an ANCHOR attestation whose `refUID` points at the parent folder. That ANCHOR is the structural membership record, consumed by non-lens-filtered views (anchor walk, `getDirectoryPage`) and by the `web3://` router's path walk.
- **Lens visibility** is a separate, per-attester claim, expressed through a TAG. The kernel does not emit this TAG implicitly — clients do.
- **Upload flow** (client-side): after placing a file at `/a/b/file.txt`, the client walks the ancestor chain `/a/b → /a` (stopping at root exclusive). For each ancestor that the uploader has not already actively tagged with `(definition=dataSchemaUID)`, the client emits a visibility TAG. Weight defaults to 1 by convention; the kernel does not interpret weight. Steady-state cost: zero (walk exits on the first hit). First upload into a new subtree: one extra TAG per generic ancestor.
- **Empty-folder visibility** (the `CreateItemModal` "make an empty folder that's visible immediately" case): the creator emits the same visibility TAG as the upload flow. Same mechanism, no special case.
- **Folder deletion**: revoke the attester's visibility TAG on the target folder, then cascade-revoke the attester's file-placement PINs in the subtree. No orphan placements.
- **Cross-lens**: Alice's visibility TAG on `/a` does not make `/a` visible to Bob's lens. Bob must tag it himself. Matches ADR-0031 first-attester-wins.

### View wiring

`EFSFileView` schema-filtered directory reads consume `EdgeResolver._childrenWithEdge[parent][dataSchemaUID]` and filter on active (existing and not revoked) TAGs by any lens attester via `hasActiveTagFromAny`. The old `_getQualifyingTaggedFolders` helper, the `MAX_TAGGED_FOLDERS = 10000` cap, and the dual-source `_qualifyingFolders` fallback are all removed. The schema-filtered walker is now the opaque-cursor paginator from ADR-0036, so there is no silent truncation at any fan-out size.

### Kernel storage

`_qualifyingFolders` is removed from `EFSIndexer`. `_containsAttestations` is preserved — it still governs file-anchor filtering in `getChildrenByAddressList` and `getAnchorsBySchemaAndAddressList` (ADR-0010).

## Consequences

- **Ghost folders on revoke disappear structurally.** A folder with no active placement or visibility TAG is not in the listing — the listing reflects active TAGs, and active TAGs are what drives inclusion.
- **Single source of truth for lens visibility.** One index to read, one index to mutate. Future indexing work doesn't have to keep two stores consistent.
- **Upload cost.** Best case (steady state, subtree already tagged): zero extra attestations beyond the file itself. Worst case (first upload into a fresh `/a/b/c/…/z/`): up to `MAX_ANCHOR_DEPTH = 32` visibility TAGs. Each is a cheap TAG (~50k gas) against a single `onAttest` hook. Acceptable — archival-grade uploads were never commodity-cheap.
- **Delete cascade is now well-defined.** Revoke the visibility TAG on the root of the delete target + revoke placement TAGs on every file in the subtree. No per-attester orphan placements.
- **Client responsibility.** The ancestor-walk visibility emitter lives in client code (`CreateItemModal` and equivalent in the production Vite/Lit client). Two clients must stay consistent on the rule "walk up to root exclusive, emit if not-already-actively-tagged."
- **Symmetry with files is partial.** Files and folder *visibility* both flow through TAGs. Folder *creation* still does not require a TAG — the ANCHOR attestation is the structural record. This is intentional: folder existence is a fact about the structure (and can't be unseen by any lens); folder visibility is a lens-scoped claim.
- **No silent truncation at any fan-out size** (ADR-0036 paginator). Previously `MAX_TAGGED_FOLDERS = 10000` was a gas-ceiling cap that quietly dropped folders past 10k; with opaque-cursor pagination the walker processes whatever exists across as many paginated calls as needed.
- **Kernel shrinks.** `_qualifyingFolders` storage and the ancestor-walk code in EFSIndexer's `onAttest` go away. Net reduction in kernel complexity.

## Alternatives considered

- **Keep dual-source, add de-propagation.** Reference-count `_qualifyingFolders` entries and walk up on every revoke. Rejected: gas cost at every untag (every file delete), still-complex semantics, and doesn't address "is this my folder" being fundamentally per-lens.
- **Auto-emit visibility TAG on folder creation in the kernel.** Reduces client responsibility but bloats `onAttest` with conditional work and still needs the ancestor walk on deep uploads (the anchor attestation only knows its immediate parent). Rejected for the same reasons auto-tagging generally is — the kernel should index, not express lens claims.
- **Skip the upload-time ancestor walk and require the user to tag each ancestor manually.** Rejected as bad UX; nobody wants to tag five folders to see their file show up.
- **Edit ADR-0006 in place (the status quo before this ADR).** Rejected on repeat: the ADR discipline treats Decision content as historical record. Two rounds of in-place edits on the same ADR crossed the threshold where supersession is clearly the right form.

## Relationship to superseded ADRs

- **ADR-0006 (Superseded by this ADR).** Original decision: folders visible via either a write-time qualifying-folder index OR an explicit TAG. Its Status line is updated to `Superseded by ADR-0038`; its body is not touched.
- **ADR-0008 (`_qualifyingFolders` write-time index).** The index itself is removed by this ADR. ADR-0008 is left as-is for historical reasoning — nobody reading current code should expect `_qualifyingFolders` to exist.
- **ADR-0010 (`_containsAttestations` sticky propagation).** Unchanged. Still governs file-anchor filtering.
- **ADR-0036 (Opaque-cursor pagination).** Provides the read path for the single-source model at any fan-out; eliminates the `MAX_TAGGED_FOLDERS` cap noted in ADR-0006's 2026-04-19 correction.

---

*Prose-accuracy corrections 2026-04-22 (within 30-day grace window): (1) `TagResolver._childrenTaggedWith` updated to `EdgeResolver._childrenWithEdge` — contract was renamed per ADR-0041's implementation. (2) "file-placement TAGs" updated to "file-placement PINs" in the Folder deletion bullet — file placement is now PIN (cardinality 1) per ADR-0041. (3) An earlier version of this note replaced `applies=true` language with `weight > 0` / `weight=1`; this was itself incorrect — ADR-0041 §4 explicitly rejected the "negative weight = supersede" coupling. Activity is existence/revoke only: a TAG is active iff it exists and has not been EAS-revoked; weight is opaque metadata the kernel does not interpret. All `"weight > 0"` and `"weight > 0 = active"` phrases updated to `"existing and not revoked"` accordingly. The core decision (TAG-only folder visibility via explicit TAG per attester) is unchanged.*
