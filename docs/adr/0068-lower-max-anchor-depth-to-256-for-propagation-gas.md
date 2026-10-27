# ADR-0068: Lower `MAX_ANCHOR_DEPTH` from 1024 to 256 (derive the cap from the propagation gas budget)

**Status:** Accepted
**Date:** 2026-06-23
**Permanence-tier:** Etched (kernel depth invariant — bounds the per-placement ancestor walk; a value too high makes legal deep placements unexecutable)
**Related:** ADR-0065 (raised 32 → 1024 — depth value superseded here; its no-name-length-cap decision still holds), ADR-0021 (original `MAX_ANCHOR_DEPTH = 32`), ADR-0048 (proxy-ready resolvers / burn), PR #37 review

## Context

ADR-0065 raised `MAX_ANCHOR_DEPTH` from 32 to 1024, justified by "bounded gas preserved: ~2,100 gas per warm SLOAD per level ⇒ ~2.1M gas worst-case … well under the block limit." **That gas estimate was wrong, and it drove the number.**

The cap bounds the ancestor-chain walk that runs on a content *placement* — `EdgeResolver.onAttest` → `EFSIndexer.propagateContains` → `_propagateContains` (and the symmetric walk in `_indexGlobal`). For a **first-time** placement by a lens at a level not yet flagged for it, each level performs **~4 cold (zero→nonzero) SSTOREs** — `_containsAttestations`, the `_childrenByAttester` array push (length slot + element), and the `_childInChildrenByAttester` dedup flag — at ~22,100 gas each, i.e. **~90k gas/level**, not ~2.1k. (The ~2.1k figure is a *warm SLOAD*, not the cold writes the walk actually does.)

The PR #37 review surfaced the consequence: a fresh lens placing — or hardlinking/moving inherited content — at a deep anchor walks the full depth with no early-break, so at 1024 the worst case is **~92M gas, well over the ~30M block limit → the placement reverts**, even though anchor *creation* (one anchor per tx) succeeded. Deep trees could be *built* (incrementally, each level its own cheap tx) but could **not be cross-lens-placed-into** past roughly depth ~300. That breaks lenses/hardlinks — a core EFS operation — for deep paths.

ADR-0065 itself anticipated this exit: its Alternatives section records that "256 remains a valid conservative fallback if tighter worst-case gas were ever prioritized over completeness." Tighter worst-case gas is now required, not hypothetical.

## Decision

**Lower `MAX_ANCHOR_DEPTH` from 1024 to 256.** Keep everything else ADR-0065 decided: the depth-*counter* form (a path-byte cap does not bound the walk), the single-source-of-truth `public constant` read by all three enforcement sites, and **the no-anchor-name-length-cap decision (ADR-0065 §2) is unchanged.**

256 is derived from the propagation budget, not picked for aesthetics: worst-case first-placement propagation ≈ 256 × ~90k ≈ **~23M gas**, which fits inside a ~30M block with headroom for the rest of the placement tx (the EAS attestation + PIN resolver logic). It is still **8× the original 32** and far beyond any real-world tree (deepest cited ≈ 11 levels), so it rejects nothing legitimate — the mirror-external-filesystems goal of ADR-0065 is preserved while every legal placement stays executable.

## Consequences

- **Every legal placement is now executable in one block**, including a fresh lens hardlinking/moving inherited content at the deepest allowed path. This is the property 1024 silently broke.
- **Free-until-burn, orphans nothing** (same as ADR-0065): `MAX_ANCHOR_DEPTH` is a `constant` in `EFSIndexer` implementation bytecode behind the upgradeable proxy. The proxy address — and therefore the ANCHOR/DATA/PROPERTY schema UIDs — is unchanged, so lowering it is a pre-launch redeploy that keeps all existing anchors valid. (Anchors created between 256 and 1024 deep do not exist yet — pre-launch, no data — so nothing is orphaned.)
- The cap is a *creation-time* and *walk-time* invariant; existing shallow anchors are unaffected. Trees deeper than 256 cannot be created — acceptable, since none are real and the alternative (1024) makes them unplaceable anyway.
- **Lesson folded in:** size an on-chain depth/iteration cap from the *write-side* worst case (cold SSTOREs × depth vs block gas), not from a warm-SLOAD read estimate. The `_propagateContains`/`_indexGlobal` walks are the binding cost, and they write, not read.

## Alternatives considered

- **128.** More headroom (~11.5M worst-case), also gas-safe. Rejected as the headline only because 256 already fits comfortably and stays more generous; 128 remains a fine tighter fallback if block-gas assumptions change.
- **Keep 1024, make propagation lazy/bounded.** Redesign the ancestor walk so a deep placement does partial/lazy propagation and backfills later. Rejected pre-launch: it touches an append-only kernel index (ADR-0009/0010) and adds materially more complexity than lowering a constant, for the sole benefit of supporting trees no real filesystem produces.
- **No cap / path-byte cap.** Already rejected by ADR-0065 for reasons that still hold (an on-chain walk must be bounded; a byte cap doesn't bound iterations).
