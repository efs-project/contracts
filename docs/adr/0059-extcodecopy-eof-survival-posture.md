# ADR-0059: web3:// on-chain reads depend on extcodecopy — EOF/EVM-evolution survival posture

**Status:** Proposed
**Date:** 2026-06-20
**Related:** ADR-0057 (EFSBytesStore), ADR-0058 (router web3:// hardening), ADR-0011/0012 (transports), ADR-0049 (DATA pure identity), ADR-0030 (mainnet permanence); `docs/FUTURE_WORK.md` "SSTORE2 / extcodecopy evolution ADR"
**Permanence-tier:** Durable (documents a posture over Etched contracts; no code change)

## Context

EFS's `web3://` on-chain content path stores file bytes as SSTORE2 chunks (each a contract whose runtime is `0x00 || data`) and reads them back with **`EXTCODECOPY`** — both in `EFSBytesStore._readChunk` and `EFSRouter`'s web3:// branch. This is the one storage assumption with **no on-chain escape hatch**: once a mainnet contract is deployed it cannot be upgraded (ADR-0030), so if a future EVM hard fork changed or removed `EXTCODECOPY`/`EXTCODESIZE` semantics — most plausibly under **EOF** (EVM Object Format), which deprecates code-introspection opcodes (`EXTCODECOPY`, `EXTCODESIZE`, `CODECOPY`) for EOF-format accounts — the on-chain read of already-stored content could break, with no way to patch the deployed reader.

This is not a today-bug; SSTORE2 + extcodecopy is sound on current and all near-term EVM versions, and EOF (a) is not scheduled with code-introspection removal that affects *legacy* (non-EOF) deployed code in a breaking way, and (b) historically preserves legacy-account behavior. But for a 50-year archival system the assumption must be written down, with the survival argument and the operational mitigation, so a future maintainer inherits the reasoning instead of discovering the coupling cold.

## Decision

**Keep extcodecopy-based on-chain reads** (it is the correct, gas-efficient mechanism today; there is no better primitive for reading SSTORE2 bytes), and record the survival posture rather than over-engineering an abstraction now:

1. **Redundancy is the mitigation, not contract upgradeability.** EFS's permanence guarantee for any single file rests on **multiple mirrors across transports** (ADR-0012: `web3:// > ar:// > ipfs:// > magnet: > https://`). A file with a `web3://` mirror **and** at least one off-chain mirror (ar:///ipfs://) survives an extcodecopy regression: the router/client simply falls through to the next mirror. The lens-scoped mirror selection already does this fall-through (and ADR-0058 fixed it to also skip a *dead* web3:// store), so the redundancy is real at serve time.
2. **A `web3://`-only file (no second mirror) is the at-risk case.** It is the one configuration with no escape hatch under a hostile EVM change. The write path / SDK SHOULD encourage (not silently allow) a second durable mirror for content meant to outlive EVM evolution. (Operational guidance; tracked as an SDK/upload-flow follow-up, not a contract constraint.)
3. **New transport schemes are permissionless.** `/transports/*` are anchors (ADR-0011), so a future, EOF-safe on-chain storage scheme can be added as a new transport and attested as an additional mirror on existing DATA — without touching any frozen contract. The escape hatch for the *system* (vs. a single already-deployed reader) is "add a new transport + re-mirror," which requires no upgrade.
4. **Router is redeployable; the bucket is not the binding surface.** `EFSRouter` can be redeployed against a new read primitive if ever needed (its address is not in any schema UID); `EFSBytesStore` is a per-file helper (ADR-0057) — new files use a new reader, old files rely on mirror redundancy (point 1).

## Consequences

- The coupling is now documented: a 50-year reader knows the web3:// read depends on legacy `EXTCODECOPY` and that **multi-mirror redundancy** — not contract upgradeability — is the survival mechanism.
- **Operational implication:** content intended to be maximally durable should not be `web3://`-only. This argues for an SDK/upload-flow nudge to attach ≥1 off-chain mirror alongside a web3:// mirror (follow-up).
- No code change. The redundancy mechanism already exists; this ADR makes the assumption and mitigation explicit and supersedes the `docs/FUTURE_WORK.md` "SSTORE2 / extcodecopy evolution ADR [document-now]" item.

## Alternatives considered

- **Abstract the read behind an upgradeable indirection now.** Rejected — speculative complexity on an Etched surface for a hypothetical EVM change, against the "minimum irreversible assumptions, not minimum code, but no speculative abstraction" framing. Redundancy across transports is the simpler, already-present hedge.
- **Mandate ≥2 mirrors in the MIRROR resolver (on-chain).** Rejected — over-constrains a frozen contract; a single-mirror file is a legitimate (if less durable) choice, and the resolver shouldn't encode durability policy. Belongs as SDK/client guidance.
