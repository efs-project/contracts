# ADR-0050: REDIRECT — first-class canonical / sameAs / symlink edge

**Status:** Proposed
**Date:** 2026-05-31
**Deciders:** James (schema freeze is human-gated)
**Permanence-tier:** Etched (REDIRECT field string) + Durable (resolution algorithm)
**Related:** ADR-0049 (DATA pure identity), ADR-0048 (freeze set + proxy/burn), ADR-0031 (lens-scoped reads)

## Context

Because DATA is pure identity (ADR-0049) and the chain can't verify content, the same file gets multiple DATA UIDs (duplicates). We need a trust-scoped way to say **"B is the same as / redirects to A"** so consumers resolve a duplicate to its canonical — and the same primitive expresses **symlinks** (a path that redirects to another path/DATA). Hardlinks (one DATA pinned at many paths) are already native and untouched.

The design panel split between a PROPERTY convention and a first-class schema. **Decision: first-class schema (Option B).** Rationale (James): a primitive that reroutes *identity* deserves resolver-enforced guards (no self-loops, typed targets) and typed metadata (`kind`) usable as a primitive by EFS contracts, third-party contracts, and clients — not left to client politeness and a stringly-typed UID. It is additive (a new schema orphans nothing), so freezing it now costs nothing against the other 8 and avoids the permanent "resolve both a convention and a later schema" tax.

## Decision

**Freeze a 9th schema, REDIRECT** = `"bytes32 target, uint16 kind"`, **revocable `true`**, resolver = `AliasResolver` (behind a proxy per ADR-0048).

- `refUID` = the **source** (the duplicate DATA for `sameAs`/`supersededBy`; the source path Anchor for `symlink`).
- `target` = the destination DATA or Anchor UID.
- `kind` = a redirect class. **Only `uint16 kind` is frozen; the taxonomy is resolver logic + client convention (upgradeable/versioned), not part of the UID** — so it can evolve. Initial taxonomy: `0=sameAs` (strong, followed), `1=supersededBy` (version replacement, followed), `2=symlink` (path→target, followed one hop), `3=relatedVersion` (weak — discovery hint, **never** auto-followed; the SKOS guard against RDF's "sameAs explosion").
  - **Width = `uint16`, deliberately.** `kind` is a discriminator (an open-ended *relationship vocabulary*), not a counter — so ADR-0047's sizing rule says "narrow." But widening is **free**: `uint8` and `uint16` both pad to one 32-byte ABI word, so the payload and gas are identical; only the frozen field string differs. Since the field is irreversible and the safe choice costs nothing, `uint16` (65,536 kinds) removes any conceivable ceiling while still reading honestly as a bounded discriminator (vs `uint256`, which would misrepresent it as a counter). Contrast `LIST.targetType` (`uint8`): that is a *closed* set of three resolver-backed decode modes, not an open vocabulary — narrow is correct there.

**AliasResolver write-time guards** (correct before burn): `target != 0`; `target != refUID` (no trivial self-loop); per-`kind` type checks (sameAs/supersededBy require source+target both DATA; symlink requires source Anchor, target Anchor-or-DATA; reject targets of the wrong attestation kind). Optional advisory on-chain reverse fan-in (`_aliasesByTarget`) addable as upgradeable logic; default to the off-chain indexer for "what points at me?".

### Write-time guards vs read-time resolution (important)
The resolver enforces **write-time** correctness (direct self-loops, typing). **Multi-hop cycles** (A→B by one attester, B→A by another) and chain-following resolve at **read time** via a shared resolution spec — the resolver can't afford to walk the graph on each write. So a normative **resolution spec + conformance vectors** (Durable, ADR-governed, NOT frozen in a UID) must be pinned before any durable data mints redirects:
- **Lens precedence** (ADR-0031) is the outer key: follow only redirects asserted by attesters in the reader's trusted lens, in priority order.
- **Depth cap** `D_MAX` (≈8; hard ceiling = `MAX_ANCHOR_DEPTH` 32).
- **Cycle rule:** on a detected cycle, resolve to the **lowest UID in the strongly-connected component** (start-independent — every client lands on the same canonical regardless of entry point). Not "last safe node" (entry-dependent, attacker-influenceable).
- **Kind following:** `sameAs`/`supersededBy`/`symlink` followed; `relatedVersion` never auto-followed.
- **Tiebreak:** canonical lexical byte-comparison of UIDs.

### Symlink / hardlink mapping
- **Hardlink** — native, untouched: one DATA UID PINned at many path Anchors. "Same file, many names." No follow, no cycle, no trust question.
- **Symlink** — REDIRECT `kind=2`, source = path Anchor, target = Anchor/DATA. Note (verified): the production `EFSRouter` only reads the DATA-pin slot, so symlink-following is **new resolution logic** (resolver + client), not free via the existing walk.
- **Canonical/dedup** — REDIRECT `kind=0` (`sameAs`), source = duplicate DATA, target = canonical DATA.

## Consequences
- **Easier:** one typed, guard-railed primitive serves dedup-resolution, versioning, and symlinks, consumable on-chain and off; no stringly-typed UID wart; resolver rejects malformed redirects at write time.
- **Harder:** a 9th schema to get right; an `AliasResolver` to build and (eventually) burn; the read-time resolution spec + conformance vectors are real work and must precede durable seed data; redirect-following is new logic in router/clients.
- **Risks (logged):** *confused-deputy* — a trusted-but-careless/compromised lens member's redirect reroutes file identity (larger blast radius than a normal PIN), and the "reuse this existing file?" prompt lends UI authority to an unverifiable hash; mitigation is the client rule **"never silently teleport — show the asserter + one-click ignore,"** unenforceable on-chain, inherent to web-of-trust. *Indexer eclipse-by-omission* — treat the off-chain indexer as an untrusted cache. *Pre-convention tail* — duplicates minted before the resolution spec lands carry no redirect; settle the spec before durable seeding.

## Action items
1. [ ] Freeze REDIRECT `"bytes32 target, uint16 kind"`, revocable=true; build `AliasResolver` (proxy) with write-time guards.
2. [ ] Pin the read-time resolution spec + conformance vectors (depth, cycle=lowest-UID-in-SCC, kind-following, lens precedence) before durable seeding.
3. [ ] Client UX invariant: never silently teleport; show redirect provenance + one-click ignore.
4. [ ] (Later, upgradeable) advisory on-chain reverse fan-in if a contract consumer needs it; else off-chain indexer.
