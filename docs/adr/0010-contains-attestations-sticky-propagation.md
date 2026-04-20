# ADR-0010: `_containsAttestations` propagation is one-way (sticky)

**Status:** Accepted (scope narrowed 2026-04-18; see clarification below)
**Date:** 2026-04-16 (formalized retroactively, with partial de-propagation added in PR #8)
**Related:** ADR-0006 (revised 2026-04-18), ADR-0008 (superseded in place), ADR-0009

> **Clarification 2026-04-18.** `_containsAttestations` remains in force but its
> scope is narrower than the original ADR implied. After the tag-only
> folder-visibility refactor (ADR-0006 revised), this index is **no longer a
> source of folder visibility** in edition-scoped directory listings. It is used
> only to filter file-anchor children in `getChildrenByAddressList` /
> `getAnchorsBySchemaAndAddressList` / `containsSchemaAttestations`. Folder
> visibility in edition listings comes exclusively from an active applies=true
> `TAG(definition=dataSchemaUID, refUID=folder)` by an edition attester.
>
> The sticky-on-revoke property described below still holds — it's just no
> longer user-visible in the "does this folder appear" sense (that's per-TAG
> now, and TAGs are revocable).
>
> Permission for in-place edit: confirmed by project owner 2026-04-18.

## Context

When a TAG places content at a path, EFSIndexer needs to remember which ancestor folders contain content for which attesters — this powers edition-filtered directory listings ("show me only folders Alice has touched"). The natural index is `_containsAttestations[anchor][attester] = bool`.

The flag must be **set** when content arrives. The question: when content is removed (untag, revoke), should the flag be **cleared**?

Full clearing requires reference counting across the tree (an ancestor stays flagged until ALL its descendants are unflagged for that attester). Reference counting at every untag is expensive in gas and complex in code.

## Decision

Propagation is **one-way (sticky)** with a partial exception:

- **Set on TAG**: `propagateContains` walks the ancestor chain (bounded by `MAX_ANCHOR_DEPTH`) flagging each ancestor.
- **Clear on untag**: `clearContains` clears only the **immediate folder** flag (not ancestors), and only when the `_activeTotalByDefAndAttester` counter for that (definition, attester) hits zero. The immediate-folder clear is sufficient for accurate subfolder listing because `getDirectoryPageByAddressList` checks the direct child's flag.
- **Ancestor flags remain sticky.** A folder that once contained content for an attester appears in their parent's edition view forever, even if all content is removed.

## Consequences

- **No false negatives**: a folder with content always appears in its attester's edition view. Discoverability is preserved.
- **False positives possible**: an empty folder may appear in a parent's edition view if it ever had content. Cosmetic noise, not a correctness issue.
- Cheap writes on revocation/untag (one SSTORE for the immediate clear).
- Off-chain UIs can paper over false positives with a cross-check (does the folder have any active children?).
- Full reference-counted de-propagation is deferred to `docs/FUTURE_WORK.md`. The cost-benefit doesn't justify it pre-launch.
