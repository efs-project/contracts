# ADR-0066: `index()` is discovery-only — folder presence is placement-driven

**Status:** Accepted
**Date:** 2026-06-23
**Permanence-tier:** Etched (kernel index semantics — `EFSIndexer` is non-redeployable; the rule constrains what permissionless callers can write into the append-only contributor index)
**Related:** PR #37, ADR-0009 (append-only indices), ADR-0010 (sticky `_containsAttestations`), ADR-0038 (tag-only folder visibility), ADR-0055 (WHITEOUT), ADR-0065 (anchor depth)

## Context

`EFSIndexer` exposes a permissionless `index(uid)` / `indexBatch(uids)` so any attestation — including foreign schemas and EFS schemas the kernel is not the resolver for (WHITEOUT, REDIRECT, …) — can be made **discoverable** through the standard query surface (`getAttestationsBySchema`, `getReferencingAttestations`, `getOutgoingAttestations`, …). This is correct and wanted: every EFS schema should be index-worthy.

The problem was that `index()` did **two** jobs through the shared `_indexGlobal`:

1. **Discovery indexing** — append the UID to the by-schema / by-refUID / by-attester indices. Universal, intended.
2. **Folder-presence propagation** — walk the `_parents` chain from `refUID` to root, setting `_containsAttestations[ancestor][attester]` and pushing each ancestor into `_childrenByAttester[parent][attester]`. This is the **schema-blind** "navigable tree" that `getChildrenByAddressList` / `getDirectoryPageByAddressList` read.

Because (2) fired for **any** attestation whose `refUID` is a path anchor, a permissionless caller could manufacture *positive* folder presence without placing real content:

- index a **negative WHITEOUT** (whose `refUID` is the suppressed anchor) → a purely-negative marker makes its ancestor folders appear as "containing the caller's content" (the PR #37 review finding); or
- index a **junk foreign attestation** pointed at a popular anchor → fake "contributor" presence + permanent `_childrenByAttester` bloat (the 2026-06-17 STRIDE-sweep finding, FUTURE_WORK "`index()` `_containsAttestations` spam filter").

It is self-lens only (`_indexGlobal` keys on `attestation.attester`) and the per-schema listing / router / `getFilesAtPath` are unaffected (they read PIN/TAG, not the schema-blind index), but it is still a real semantic break — a discovery call writing a *placement* signal — and it is sticky past revoke (ADR-0010).

The frozen kernel cannot special-case the WHITEOUT schema UID (WHITEOUT is additive post-freeze; its UID isn't known at the kernel's deploy), so "skip WHITEOUT in `index()`" is not implementable. The right fix is more general anyway.

## Decision

**`index()` / `indexBatch()` are discovery-only. They never propagate schema-blind folder presence.**

`_indexGlobal` takes a `bool propagateFolderPresence`:

- The native `onAttest` path passes **true** (anchor creation builds the creator's navigable tree; DATA/PROPERTY have `refUID == 0`, so the walk is a no-op for them).
- The permissionless `index()` / `indexBatch()` path passes **false**.

Discovery indices — including the **schema-scoped** `_containsSchemaAttestations[refUID][attester][schema]` direct fact — stay universal for every schema. Only the **schema-blind** upward walk (`_containsAttestations` + `_childrenByAttester`) is gated.

**Folder presence is an intentional placement signal**, owned exclusively by:

- `EdgeResolver` PIN/TAG writes → `EFSIndexer.propagateContains` (access-controlled to `edgeResolver` / `sortOverlay`), and
- native anchor creation in `onAttest`.

No schema legitimately needs `index()`-driven propagation — real content placement never flows through `index()` — so "never propagate from `index()`" is both correct and simpler than a per-schema allowlist.

## Consequences

- **`index()` stays universal + safe:** any attestation (WHITEOUT, REDIRECT, foreign) is fully discoverable, but no caller can fake positive folder presence or bloat `_childrenByAttester`. Resolves the PR #37 WHITEOUT-positive-presence finding **and** the general STRIDE spam-filter item in one rule (the latter is now DONE, not deferred).
- **No behavior change for real placement:** PIN/TAG (EdgeResolver) and anchor creation (onAttest) propagate exactly as before. The full suite is unchanged except the one index() test that asserted the old (flawed) propagation, which now asserts the discovery-only invariant.
- **Does not address deep-placement gas:** the legitimate `_propagateContains` walk (EdgeResolver) is still `O(depth)`; the anchor-depth-vs-block-gas tradeoff is a separate decision (ADR-0065 / its follow-up).
- Self-describing intent for a 50-year reader: a discovery index records "this exists / points here"; a placement index records "someone put content here." Conflating them let a discovery call forge placement. This ADR keeps the two indices semantically distinct.

## Alternatives considered

- **Per-schema allowlist on the propagation loop** (PIN/TAG/MIRROR/LIST_ENTRY/REDIRECT) — the originally-tracked mitigation. Rejected as unnecessarily complex: those positive signals already propagate through their own resolver paths, not `index()`, so the correct `index()` answer is "propagate for none," not "enumerate which."
- **Teach the kernel the WHITEOUT schema UID and skip it** — not implementable on the frozen kernel (additive post-freeze UID), and WHITEOUT-specific rather than fixing the general class.
- **Leave it, document "don't index whiteouts"** — relies on every client/helper honoring a social convention; exactly the kind of unenforced promise EFS designs out.
