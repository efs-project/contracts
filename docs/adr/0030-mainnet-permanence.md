# ADR-0030: Mainnet permanence — no upgradeability

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0027

## Context

EFS is intended as a permanent on-chain archive substrate. Upgradeable contracts undermine the credible-neutrality property that makes "permanent" meaningful — anyone with admin keys can change the rules retroactively, censor specific data, or break stored content.

But a fully immutable system has a hard tail risk: a critical bug post-launch means total redeploy with full data loss (every schema UID encodes the resolver address).

## Decision

**Mainnet contracts are permanent. No proxies, no upgradeability, no admin escape hatches.**

- Schema UIDs are baked into EFSIndexer's constructor.
- `wireContracts()` is one-time, deployer-only, no override.
- `setSortsAnchor()`, `setTransportsAnchor()` are one-time, deployer-only, no override.
- No admin-pause, no admin-override, no admin-anything.

Devnet and Sepolia may use upgradeable proxies (TransparentUpgradeableProxy or similar) during the design phase. Production mainnet does not.

The risk mitigation is not "make it upgradeable later" but "make sure the launch version is right":
- Multiple independent code review passes (Claude, Codex, Gemini).
- One external audit pass before mainnet (e.g. Trail of Bits, OpenZeppelin) — see `docs/LAUNCH_CHECKLIST.md`.
- Devnet phase to shake out behavioral surprises with real users.

## Consequences

- **Credibly neutral**: nobody can change the rules after launch. Strong adoption signal for permanent-archive use cases.
- **Tail risk is real and accepted**: a critical post-launch bug means full system redeploy with data loss for early users. The audit and devnet phases are the safety nets.
- **Schema evolution requires re-deploy**: adding a field to ANCHOR/DATA/etc. means a new EFSIndexer with new schema UIDs. Old data lives forever in EAS but is invisible to the new system.
- **Recovery plan documented in `docs/LAUNCH_CHECKLIST.md`** so the dependency graph is known if a bug ever forces a redeploy.
- Contracts that *can* be redeployed independently without data loss: EFSFileView, EFSRouter (no state), comparators (NameSort, TimestampSort). These can be improved post-launch without cascade.
