# ADR-0042: Effective TAG as a client-layer weight filter for descriptive labels

**Status:** Accepted
**Date:** 2026-04-22
**Related:** ADR-0041, ADR-0038, specs/02-Data-Models-and-Schemas.md §TAG

## Context

ADR-0041 established two concepts:

1. **Active TAG** (kernel semantic) — a TAG is active if and only if it exists on-chain and has not been EAS-revoked. Weight is opaque metadata at the kernel level; the kernel does not interpret sign or magnitude. `weight = 0`, `weight = -999` — all are active.
2. **`int256 weight`** — a per-entry value exposed to consumers for sorting, scoring, and ranking. No kernel enforcement on value range or semantics.

During the PIN/TAG schema split, the plan document initially proposed `weight ≤ 0 = supersede` (i.e., negative weights would mark a TAG as inactive). ADR-0041 §4 explicitly rejected this because:

- It would create a shadow `applies=false` at the client level, undermining the clean removal-via-revoke model.
- It breaks the use case where weight is a score or vote and legitimate scores may be negative.
- Smart-contract consumers have no agreed convention; "weight ≤ 0 = dead" requires EFS-specific decoding that downstream subgraph indexers would have to know about.

However, there remains a practical UI use case for *suppression without full revocation*: a content filter (e.g. `#nsfw`) where an attester wants to tag something with a signal strength that can be negative ("this barely qualifies") without revoking the tag and thus losing the history or the negative score. A reader who wants a clean "is this tagged or not?" answer needs a projection rule.

## Decision

Define **effective TAG** as a higher-layer, client-only projection:

> An active TAG is **effective** for the explorer's descriptive-label include/exclude filter if and only if its `weight >= 0`.

This projection is applied **only** in `FileBrowser.resolveTagSet` — the code path that builds the set of targets for the tag-filter drawer and the `?tags=` URL parameter. No other path uses this projection:

- `hasActiveTagFromAny` (kernel helper) — unchanged; uses active-only (existence/revoke).
- Folder visibility (ADR-0038) — unchanged; all active TAGs contribute regardless of weight.
- `EFSSortOverlay` / SORT_INFO — weight is used as a sort key; no sign-based filtering.
- `getActiveTagEntries` / `getActiveTags` — return all active entries; no filtering.

**Implementation**: `resolveTagSet` switches from the per-target `getTargetsByDefinition` + `getActiveEdgeUID` traversal to a per-attester `getActiveTagEntries` + `getActiveTargetsByAttesterAndSchema` parallel-page traversal, filtering to `entries[i].weight >= 0n` before adding to the effective target set.

**Weight = 0 is effective.** Only strictly-negative weights (`weight < 0`) are suppressed.

## Consequences

- **Negative-weight TAGs remain active on-chain.** They are not revoked. They remain visible to `getActiveTagEntries` callers, available for aggregation, scoring, and any future higher-layer projection. Revocation is still the only way to truly remove a TAG.
- **The kernel is unchanged.** No new contract function, no new resolver logic. The convention lives entirely in client code.
- **Suppression is reviewer-relative.** If Alice tags something with `weight = -1` and Bob tags the same thing with `weight = 1`, the item IS in the effective set (Bob's tag passes the filter). The filter asks "does any viewed attester have an effective TAG?" — same question as before but now scoped to `weight >= 0`.
- **Subgraph indexers see all active TAGs.** The convention is not machine-readable at the EAS layer; it is a UI-level projection. External consumers who want to apply the same projection must implement `weight >= 0` themselves — documented here as the canonical rule.
- **Traversal changes from global to per-attester.** The old path enumerates the global target universe first (`getTargetsByDefinition`) then checks per-attester activity. The new path enumerates per-attester TAG entries and resolves targets. Performance is comparable for small sets; the new path is better for large global target counts with few per-attester entries.

## Vocabulary

| Term | Meaning |
|---|---|
| `active TAG` | Unrevoked TAG edge — kernel semantic (ADR-0041 §4). Used in AGENTS.md invariants, contract comments, and anywhere kernel behavior is described. |
| `effective TAG` | Active TAG with `weight >= 0` — client-layer convention (this ADR). Used only in the explorer tag-filter path and this ADR. |
| `suppressed TAG` | Active TAG with `weight < 0` — treated as if not tagged for include/exclude filter purposes; still active on-chain. |

Do not call suppressed TAGs "inactive" in shared contract or resolver code — they are active from the kernel's perspective.

## Alternatives considered

- **Revoke negative-weight TAGs immediately.** Rejected — forces a transaction for every "soft-suppression" and destroys the negative-score use case entirely.
- **Add `applies: bool` back to TAG.** Rejected — ADR-0041 removed it. It would be a new EAS schema UID (schema strings are immutable), breaking backwards compatibility.
- **Always use raw `active TAG` for the filter.** Rejected — the UI then has no way to express "tagged but suppressed" without full revocation. The client-layer convention costs nothing on-chain.
- **Use a separate "suppression" schema.** Rejected — overkill for a UI preference; adds on-chain state for a decision that should live in the viewer's rendering layer.
