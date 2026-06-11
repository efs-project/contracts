# ADR-0051: Reads exclude revoked (and superseded) by default; full history is opt-in

**Status:** Proposed
**Date:** 2026-06-10
**Related:** ADR-0009 (append-only indices), ADR-0013/0014 (lens-scoped reads), ADR-0031 (first-wins resolution), ADR-0036 (cursor pagination), ADR-0052 (PROPERTY non-revocable interned value). Lands with the schema-freeze PR.

## Context

EAS revocation does not erase an attestation — it sets a flag; the bytes persist on-chain forever (the cypherpunk "data is forever" stance, also enforced by EFS's append-only indices, ADR-0009). EFS already exploits this unevenly: the kernel's active-edge sets exclude revoked entries by construction, and ADR-0009 says append-only listing indices keep revoked entries while *"readers filter on iteration."* But there was no single, stated rule for what a read **returns by default** across every surface (kernel reads, view contracts, the router, the future SDK). Without one, each consumer reinvents the filter, and some surfaces leak revoked items.

We want a mental model that lets a user **"delete"** something (a placement, a mirror, a value they no longer trust) without contradicting permanent, credibly-neutral archival.

## Decision

**Every EFS read excludes revoked and superseded attestations by default. A consumer that wants them passes an explicit opt-in (`includeRevoked` or equivalent).**

This is a two-layer model — keep the layers distinct:

- **Storage = tombstone.** Immutable, append-only (ADR-0009). Nothing is ever erased or compacted.
- **Default read = "deleted."** Revoked items are skipped in loops, absent from listings, not served by the router. "Superseded" — e.g. a cardinality-1 PIN replaced by re-attestation at the same slot (ADR-0041) — is likewise absent: the default view shows each attester's **current** claims.
- **Opt-in read = full history.** `includeRevoked: true` surfaces the tombstones, including the revocation record itself.

Scope and properties:
- The filter is **per-attester / per-lens.** In EAS you can only revoke your *own* attestations, so "default-hidden" is always the author withdrawing their own claim — consistent with viewer sovereignty (ADR-0013/0014/0031). You can never hide someone else's claim from their lens.
- **Credible neutrality is preserved.** Because (a) only the author can revoke, and (b) the withdrawal is itself a permanent, opt-in-visible record, a publisher can retract a claim from the default view but **cannot silently revise the past** — an auditor can always reconstruct what was published and that it was withdrawn.
- Applies to: EFSIndexer read helpers, the view contracts (EFSFileView, ListReader), EFSRouter resolution (already active-only), and the SDK read layer (which owns this default for clients — see the EFS SDK boundary).

## Consequences

- **Enables.** "Delete" / "untrust" as a first-class, intuitive default everywhere, with no loss of the immutable record. Unifies a previously ad-hoc behavior into one rule consumers can rely on.
- **Costs.** Read paths over append-only arrays iterate-then-filter (already the ADR-0009 reality; hot paths stay O(1) via the active-edge sets). View functions that should expose history grow an `includeRevoked` parameter — an additive API change.
- **Implies.** This is **upgradeable read/logic, not frozen schema shape** — it does not touch any of the nine schema UIDs. It operates on the revocable schemas (PIN, TAG, MIRROR, LIST_ENTRY, REDIRECT); PROPERTY is non-revocable interned content (ADR-0052), so its *value* is never hidden — but its revocable **binding PIN** is, which is how a property is removed from the default view (revoke the PIN, and `getActivePinTarget` stops returning it).
- **Follow-up.** Audit each view surface to confirm the default holds and add `includeRevoked` where a consumer needs the historical set; the SDK adopts the same default in its read layer.

## Alternatives considered

- **Return everything; let consumers filter.** Rejected: pushes the same filter into every client, leaks revoked items by default, and makes "delete" feel broken. The safe default is the hidden one.
- **Hard-delete on revoke (compact the index).** Rejected: violates ADR-0009 and the immutability/credible-neutrality guarantee; makes silent revision possible. Tombstone + default-hide gives the same UX without the cost.
