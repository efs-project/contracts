# ADR-0062: Raise `MAX_ANCHOR_DEPTH` to 1024; do not cap anchor-name length

**Status:** Accepted
**Date:** 2026-06-20
**Related:** ADR-0021 (superseded), ADR-0025 (anchor name validation), ADR-0030 (mainnet permanence), ADR-0048 (proxy-ready resolvers / burn), ADR-0056 (kernel-minimal, client owns presentation/safety), `docs/FS_OPERATIONS_AUDIT.md`

## Context

`MAX_ANCHOR_DEPTH = 32` (ADR-0021) capped folder nesting at 32 absolute levels, enforced as a hard `AnchorTooDeep()` revert at anchor creation plus two defense-in-depth `break`s in the read-side ancestor walks. The pre-launch filesystem-operations audit (`docs/FS_OPERATIONS_AUDIT.md`) and a dedicated OS/filesystem depth survey (2026-06-20) found 32 to be **anomalously low and in conflict with EFS's mirror-external-filesystems goal**:

- **No modern filesystem imposes an explicit directory-depth cap.** ext4, XFS, Btrfs, ZFS, APFS, NTFS: none. Depth is bounded only *emergently* by path-length conventions — Linux `PATH_MAX` 4096 B ⇒ ~2048 levels of minimal components; Windows long-path mode 32,767 chars ⇒ ~16,000 levels; macOS 1024 B. The only confirmed hard depth cap in the wild is ISO 9660's 8 levels (a 1988 CD-ROM format, since lifted by extensions).
- A hard *creation* cap at 32 would **reject deep trees every real OS legally holds**, breaking EFS's ability to mirror external/machine-generated/date-partitioned (`/yyyy/mm/dd/hh`)/content-sharded archives.
- The cap's *only* purpose is anti-grief gas-bounding on the ancestor-chain walks (`_propagateContains`, `_indexGlobal`, creation-time depth check) — all linear in depth, amortized-O(1) in steady state via early-break. That purpose does not require a number as low as 32.

A second, separate question surfaced from the same audit: should anchor-name **length** be capped (proposed `MAX_ANCHOR_NAME_LENGTH ≈ 255`, matching the near-universal OS per-component limit)? `_isValidAnchorName` (ADR-0025) validates name *content* but not *length*.

## Decision

**1. Raise `MAX_ANCHOR_DEPTH` from 32 to 1024.** Keep the depth-*counter* form (a path-byte-length cap would not bound the walks — 2048 single-character components are still 2048 iterations). 1024 is ~90× the deepest tree ever observed in the wild (worst-cited `node_modules` ≈ 11 levels), so no real archival/machine-generated/mirrored tree will ever hit it, while a cap still exists so on-chain depth is never unbounded. Single source of truth: the `public constant`; all three enforcement sites read it.

**2. Do NOT cap anchor-name length.** Anchor names stay length-unbounded at the kernel.

## Consequences

### Depth
- Bounded gas preserved: ~2,100 gas per warm SLOAD per level ⇒ ~2.1M gas worst-case to create a fresh 1024-deep chain — a one-time cost **self-paid by whoever creates the deep chain**, well under the block limit; steady-state ancestor walks stay O(1) via early-break on an already-flagged ancestor.
- EFS can now mirror essentially any real-world tree by absolute path without hitting the cap.
- **This is a free-until-burn change**, not a frozen-schema change: `MAX_ANCHOR_DEPTH` is a `constant` in `EFSIndexer` implementation bytecode behind the upgradeable proxy. The proxy address (and therefore the ANCHOR/DATA/PROPERTY schema UIDs) is unchanged, so raising it **orphans nothing** — old shallow anchors stay valid, newly-allowed deep anchors simply become creatable. After burn it is fixed forever; doing it now (pre-launch redeploy) is simply the cheapest moment.

### No name-length cap
A cap is **not required for correctness**, and the reasons to add one are weak enough to reject:
- **A natural ceiling already exists.** Name validation (`_isValidAnchorName`) and the mapping-key hash are O(name length), and calldata costs 16 gas/byte — so a name large enough to matter (hundreds of KB+) exceeds block gas at creation and reverts on its own. Absurd names are physically self-limited and self-paid.
- **Lens-scoping neutralizes the grief vector.** Directory listings are lens-scoped: a maliciously huge name only burdens viewers who *explicitly trust its creator* (viewer sovereignty), never the general public. There is no public-good griefing surface.
- **Presentation is a client concern.** Clients must truncate/escape names for display anyway — the same kernel-minimal / client-owns-presentation principle as ADR-0056 (render safety) and ADR-0034 (display-name overlay). The kernel storing a long string is not the kernel endorsing how it renders.
- **Generosity is future-proofing.** Long names can be legitimate Schelling points — SHA-256 hex (64), CIDs (~46–59), structured/descriptive identifiers — and capping forecloses uses we can't foresee. A 255 cap would match OS *per-component* limits, but EFS is not obligated to adopt them and a too-tight cap risks rejecting a legitimate future name.

The one real tradeoff: a name >255 bytes cannot round-trip *out* to a conventional OS filesystem (a mirror-export tool would hash or truncate it). This is a client/export concern, not a kernel constraint — and mirror-*in* from a real OS never produces a >255 name in the first place, so legitimate mirroring is unaffected.

If a purely defensive backstop against permanent non-revocable bloat is ever wanted, the generous option is to reuse `MAX_URI_LENGTH = 8192` (ADR-0022) as a symmetric name ceiling — 32× the OS norm, so still never rejecting anything real. We deliberately do **not** add it now.

## Alternatives considered

- **Depth 128 / 256.** Rejected as the headline: only ~4–8× the cap, still rejects legal Windows-long-path trees, reintroducing the mirror-rejection problem. 256 remains a valid conservative fallback if tighter worst-case gas were ever prioritized over completeness.
- **Replace the depth cap with a path-byte-length cap (à la `PATH_MAX`).** Rejected: it models real-OS behavior but does *not* bound the EFS ancestor walks (the actual gas concern), since many short components still mean many iterations.
- **No depth cap at all.** Rejected: an on-chain system cannot have an unbounded ancestor walk — gas would be the only limit and a pathological chain could load cost onto sibling operations. A high cap (1024) keeps a clean, predictable creation-time invariant.
- **Cap anchor names at 255 (OS per-component norm).** Rejected per the reasoning above — not required for correctness, no public grief surface, and forecloses legitimate long-name uses.
