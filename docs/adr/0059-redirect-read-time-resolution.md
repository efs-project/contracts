# ADR-0059: REDIRECT read-time resolution rules

**Status:** Proposed
**Date:** 2026-06-20
**Deciders:** James (this pins behavior before durable seeding; human-gated)
**Permanence-tier:** Durable (the resolution algorithm + conformance vectors — ADR-governed, NOT frozen in a UID; the on-chain follower is a redeployable view)
**Related:** ADR-0050 (REDIRECT schema — requires this spec before durable seeding), ADR-0055 (WHITEOUT negative terminal — reserved here), ADR-0031 (lens first-attester-wins), ADR-0021/0058 (depth-cap precedent), ADR-0051 (reads exclude revoked), spec `specs/09-redirect-resolution.md` (the normative algorithm + vectors)

## Context

REDIRECT is a frozen schema (`"bytes32 target, uint16 kind"`, ADR-0050) with `AliasResolver` enforcing **write-time guards only** — no self-loop, per-kind typing (`AliasResolver.sol:161-198`). The resolver deliberately does **not** follow chains, detect multi-hop cycles, cap depth, or apply lens precedence: it cannot afford to graph-walk on every write.

The production read path follows **nothing** today: `EFSRouter._findDataAtPath` (`EFSRouter.sol:889-895`) reads the active placement PIN target in O(1) and returns; `EFSIndexer.resolvePath` (`EFSIndexer.sol:531-533`) is a pure name→anchor map lookup. So REDIRECT-following is *new* read-side logic that must be specified before it can be built — and, critically, before any durable REDIRECT data is seeded on Sepolia. ADR-0050 §"Write-time guards vs read-time resolution" and ADR-0055 §"Pre-freeze reservation" both make this spec a **gate on seeding**: a redirect minted before the rules are fixed carries undefined read behavior, and an ad-hoc suppression convention minted now would harden into a forever-fact that forecloses the clean WHITEOUT schema.

## Decision

Adopt the read-time resolution rules in `specs/09-redirect-resolution.md` as the normative contract for the on-chain navigational follower and every conformant client/indexer:

1. **Following by kind.** `symlink` (2) and `supersededBy` (1) are **navigational** (followed). `sameAs` (0) is **canonicalization-only** (never navigated). `kind ≥ 3` is never auto-followed.
2. **Hop cap `D_MAX = 8`**, hard ceiling **32**. A "hop" is a followed redirect edge — independent of `MAX_ANCHOR_DEPTH = 1024` path descent. Exceeding `D_MAX` stops and returns status `DepthExceeded` surfacing the last node; never reverts.
3. **Cycle handling.** The on-chain follower keeps a **visited-set** within the walk and **stops** on revisit (`CycleStopped`) — catches direct and multi-hop cycles the resolver's `SelfLoop` guard cannot. Separately, `sameAs`-cluster **canonicalization** elects the **lowest UID in the SCC** (start-independent, deterministic) — a **client/indexer** dedup concern; the on-chain navigational follower does NOT run SCC analysis.
4. **Lens precedence (ADR-0031).** A redirect is followable only if its attester is in the active lens set; foreign redirects are invisible. Competing edges resolve first-attester-wins by lens order, ties by lowest redirect UID. A symlink resolves within the same lens scope as the surrounding walk.
5. **Dangling targets.** A target that is missing, revoked, or fails read-time kind-typing → status `Dangling` surfacing the last good node; never reverts.
6. **WHITEOUT negative-terminal reservation (ADR-0055).** The resolution loop reserves a *non-following* terminal ("suppressed/empty in this lens — STOP, no fall-through"). The follower carries a defined-but-unreturned `Suppressed-reserved` status today so the future WHITEOUT schema slots in without restructuring the loop. This spec does NOT implement WHITEOUT.
7. **Seeding ban.** Until the WHITEOUT schema exists, NO durable data may encode whiteout/suppression via any sentinel (reserved REDIRECT kind, `weight < 0` TAG, sentinel PIN, tombstone DATA). A stray reserved-kind REDIRECT is inert/ignored (no on-chain guard per ADR-0055 §3); the ban is the protection.

## Consequences

- **The on-chain follower is a redeployable, stateless view = purely additive.** It adds no kernel storage and is baked into no schema UID, so it can be deployed (and re-deployed) without touching the frozen nine schemas. Its exact landing site (EFSFileView vs EFSRouter vs a dedicated follower) is not frozen here.
- **Clients and off-chain indexers implement the same conformance vectors** (spec §9). On-chain navigation and off-chain dedup converge because both pin the same kind-following, lens-precedence, depth, cycle-stop, and lowest-UID-in-SCC rules.
- **Durable REDIRECT seeding is gated on this ADR's sign-off.** This is the linchpin ADR-0050 and ADR-0055 both name.
- **Read gas is bounded** to `O(D_MAX)` per resolution (≤ 8 hops × per-hop lens scan), independent of path depth.
- **Cost:** the follower, the conformance-vector test suite, and client/indexer parity work are real, and must precede seeding. `supersededBy` default-follow and the follower's landing contract still want maintainer ratification (below).

## Alternatives considered

- **Kernel-side following (resolver walks on write) — REJECTED.** The resolver cannot graph-walk per write (multi-hop cycles span attesters and writes; ADR-0050). Following is inherently a read-time, lens-scoped concern; baking it into the immutable resolver would also freeze the follow rules forever.
- **No hop cap (or path-depth cap reuse) — REJECTED.** An on-chain walk must be bounded; reusing `MAX_ANCHOR_DEPTH = 1024` over-budgets a redirect chain (real chains are short) and conflates two independent budgets. `D_MAX = 8` / ceiling 32 bounds gas while never truncating a legitimate chain.
- **Full Tarjan SCC on-chain for navigation — REJECTED.** SCC analysis is unbounded-in-general and unnecessary for *navigation*: a bounded walk with a visited-set stops cleanly on any cycle. Lowest-UID-in-SCC is needed only for `sameAs` **dedup**, which is a client/indexer concern off the per-read on-chain path.
- **Encode whiteout as a REDIRECT sentinel kind now — REJECTED** (ADR-0055): a *follow* vocabulary used as a *stop* terminal, unenforceable by the frozen resolver, and a forever-fact once seeded. WHITEOUT gets its own schema additively; this spec only reserves the terminal slot.
- **`sameAs` followed navigationally — REJECTED.** Equivalence has no direction or terminal; navigating it teleports reads arbitrarily. Keep equivalence out of the follow path (SKOS discipline, ADR-0050); resolve it by canonicalization instead.
