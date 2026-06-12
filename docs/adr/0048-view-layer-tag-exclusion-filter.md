# ADR-0048: View-layer tag-exclusion directory filter

**Status:** Accepted
**Date:** 2026-06-12
**Related:** ADR-0042 (extends), ADR-0041 (TAG/weight), ADR-0038 (folder visibility), ADR-0036 (opaque cursor), specs/02-Data-Models-and-Schemas.md §TAG

## Context

ADR-0042 defined the **effective TAG** projection (`weight >= 0`) and placed it
**only** in the client (`FileBrowser.resolveTagSet`). Its core, correct decision
is that the **kernel must stay weight-neutral** — the kernel never interprets the
sign or magnitude of a TAG's `int256 weight` (ADR-0041 §4). But ADR-0042's framing
("the convention lives entirely in client code; no new contract function")
overlooked **on-chain consumers**: a contract that wants a directory listing with
`nsfw`/`system` items filtered out has no view to call — it must list, then loop
and check every item's tags itself (an N+1). The explorer client suffers the same
shape: it lists a page, then runs a separate global tag scan to hide items.

The gap is the *consumer-facing read API*, not the kernel. The fix must preserve
ADR-0042's kernel-neutrality while giving consumers a single filtered read whose
threshold is **chosen by the caller**, not baked into any immutable contract.

## Decision

Add a **view-layer** tag-exclusion filter. Two additions, both honoring
kernel weight-neutrality:

1. **`EdgeResolver.getActiveTagWeight(address attester, bytes32 target, bytes32 definition, bytes32 targetSchema) → (bool exists, int256 weight)`** —
   a pure O(1) view over the *existing* `_activeByAAS` / `_activeByAASIndex`
   storage (no new state, no index change, no write path touched). It returns the
   raw stored weight without interpreting it. This is the one kernel-contract
   (EdgeResolver) ABI addition; EdgeResolver is wired into EFSIndexer, so this is a
   near-Etched surface and is the load-bearing item to review.

2. **`EFSFileView.getDirectoryPageFiltered(bytes32 parent, bytes32 schema, address[] lenses, bytes32 excludeTagDef, int256 minWeight, bytes cursor, uint256 maxItems) → DirectoryPage`** —
   the existing `getDirectoryPageBySchemaAndAddressList` plus a per-item exclusion
   predicate: skip an item if **any** lens has an active TAG `excludeTagDef` on it
   with `weight >= minWeight`. The `weight >= minWeight` comparison happens in the
   **view layer** (EFSFileView is stateless and redeployable — *not* Etched). The
   threshold is a **caller argument**: ADR-0042's `weight >= 0` becomes the
   conventional default a caller passes (`minWeight = 0`), not a hard-coded rule.

**Tag-target asymmetry (load-bearing).** A descriptive-label TAG targets:
- a **file** item's **DATA UID** (reached via the placement PIN
  `getActivePinTarget(itemAnchor, lens, dataSchemaUID)`), bucket `dataSchemaUID`;
- a **folder** item's **ANCHOR UID**, bucket `ANCHOR_SCHEMA_UID`.

The filter must resolve a file item to its DATA before testing the tag (this
mirrors the client's `resolveTagSet`/`matchesUID` dual-bucket union). Testing
`excludeTagDef` against a file's anchor UID is the wrong target and silently
excludes nothing.

**Bounding.** `maxItems` counts post-filter result slots (an excluded item
advances the walker but consumes no slot — like a revoked/out-of-lens entry). The
existing phase-0 scan budget is retained; a **phase-1 scan budget** is added so a
page that is 100%-excluded under the lens cannot loop the whole source in one
call (it returns a non-empty cursor when the budget is hit before `maxItems`). The
opaque cursor format (ADR-0036) is unchanged — exclusion is a stateless predicate
on already-walked positions, identical to revocation skips.

**Scope: single exclude tag for v1.** One `(excludeTagDef, minWeight)` per call.
A multi-tag variant is deferred (EFSFileView is redeployable, so it can ship later
with zero migration); different policies (`system` always-on vs `nsfw` user-toggle)
don't share a threshold anyway, so single-tag keeps each call honest about "one
policy per call."

## Consequences

- **Extends ADR-0042, does not supersede it.** 0042 stays the canonical rule for
  the client filter and the meaning of `weight >= 0`. This ADR generalizes that to
  "any caller-chosen threshold, evaluated in the view layer." Kernel
  weight-neutrality (ADR-0041 §4) is preserved — the kernel only gains a read.
- **On-chain consumers get a single filtered read** instead of an N+1. The
  explorer can later replace its client-side global tag scan with one
  `getDirectoryPageFiltered` call (a follow-up; not required by this ADR).
- **LIST items pass through unfiltered in v1.** `_isItemExcluded` classifies
  two-way (`anchorType == 0` ⇒ folder via the ANCHOR bucket, else ⇒ file via the
  DATA-by-PIN path). A LIST anchor (`anchorType = LIST_SCHEMA_UID`, non-zero) hits
  the file branch, where `getActivePinTarget(listAnchor, lens, dataSchemaUID)`
  resolves no DATA, so a LIST is never excluded. This is an intentional divergence
  from the client's three-way (folder/file/list) model: v1 scopes exclusion to
  file/folder descriptive labels. A three-way classifier that also filters LIST
  items can ship later in a redeployable view with zero migration.
- **Cost is relocated, not removed.** Filtering is inherently O(items × lenses)
  because a TAG is a per-attester edge — the view does the loop with O(1) reads
  (`getActivePinTarget`, `getActiveTagWeight`), bounded by the scan budgets and
  the `MAX_ATTESTERS_PER_QUERY` cap. It is a win for contract consumers (one call,
  no round-trips); for the browser it is roughly a wash vs. looping in JS.
- **One near-Etched addition** (`EdgeResolver.getActiveTagWeight`). It is a pure
  view over existing storage — no storage layout change, no write-path change — so
  it does not alter any append-only invariant (ADR-0009) or schema field. It does
  change EdgeResolver's bytecode; on the pinned fork its nonce-CREATE address is
  unchanged, so PIN/TAG schema UIDs are preserved, but `deployedContracts.ts` must
  be regenerated for the new ABI.

## Alternatives considered

- **Existence-only filter (`hasActiveTagFromAny`, ignore weight).** Bounded and
  needs no kernel change, but cannot honor a threshold — `minWeight` would be a
  lie, and a `weight < 0` suppressed tag would still exclude. Rejected: the whole
  point is caller-chosen weight policy (ADR-0042).
- **View scans each lens's TAG list per item (no kernel reader).** O(lenses ×
  tagsPerLens) per item — unbounded, DoS-prone. Rejected in favor of the O(1)
  `getActiveTagWeight` reader.
- **Bake the threshold into the kernel / a new field.** Violates ADR-0041 §4 and
  ADR-0042's kernel-neutrality; immutable and wrong for a viewer-relative policy.
- **Multi-tag array in v1.** Multiplies per-item cost and needs parallel
  per-tag thresholds + extra cursor/budget logic for one dominant caller.
  Deferred (redeployable view → zero-migration later).
