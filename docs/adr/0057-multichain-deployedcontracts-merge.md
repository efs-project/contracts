# ADR-0057: deployedContracts.ts is multi-chain; generation merges per-chain

**Status:** Accepted
**Date:** 2026-06-20
**Related:** ADR-0037 (pinned Sepolia fork), ADR-0028 (CI graceful degradation)

## Context

`packages/nextjs/contracts/deployedContracts.ts` is the committed cross-environment
coordination unit (ADR-0037). It is no longer single-chain: it now carries a block
per chain — `31337` (the pinned hardhat Sepolia fork, regenerated on every deploy)
and `11155111` (the **real** Sepolia deployment frozen by `record Sepolia freeze`).
Mainnet (`1`) and other real networks will add their own blocks over time.

`generateTsAbis` (the last deploy step) rebuilt the file by reading every
`deployments/<network>/` dir and **overwriting** the whole file. But a `yarn deploy`
targets exactly one network, so its `deployments/` dir holds only that chain. The
overwrite therefore **silently deleted every chain the current deploy didn't touch**:

- A local fork deploy (`31337`) wrote a `31337`-only file, wiping the frozen
  `11155111` Sepolia block.
- This is unrecoverable from a fork: a real-testnet deployment cannot be reproduced
  by a fork deploy (different chain, real ETH, frozen addresses).

Two downstream failures followed. (1) `deploy-pin-check` — which does a localhost fork
deploy and diffs the *whole* file — has been failing since the Sepolia-freeze commit,
because a fork deploy can never reproduce the `11155111` block; the failure was masked
by `continue-on-error` (ADR-0028). (2) The committed file drifted *internally*: a later
Sepolia deploy regenerated `11155111`'s `EFSFileView` ABI (adding `getDataMirrorsAllAttesters`,
the lens-scoped reader) but left `31337` stale, because `31337` was regenerated from a
stale `deployments/localhost` in the same run.

## Decision

`generateTsAbis` **merges per-chain** instead of overwriting. It reads the existing
committed `deployedContracts.ts`, then lets freshly-deployed chains override only their
own block; chains absent from the current deploy pass through verbatim:

```
allContractsData = { ...existingChains, ...deployedChains }   // per-chain key merge
```

`deployedChains` is restricted to the **active network** (`deployments/<hre.network.name>`),
not every `deployments/<net>` dir on disk. Otherwise a stale leftover dir (e.g. a developer's
old `deployments/sepolia` from a prior real deploy) would land in `deployedChains` and override
the committed frozen block with whatever local state it holds — a silent drift a fresh CI
checkout couldn't catch. With the restriction, a single-network deploy regenerates only its own
block; every other chain is preserved from the committed file.

`deploy-pin-check` is **unchanged**: it still does a localhost fork deploy and diffs the
whole file. With merge semantics the diff is correct again — `31337` is regenerated
deterministically (the ADR-0037 guarantee), and frozen real-network blocks are preserved
identically, so they contribute no spurious diff.

The existing file is read by extracting its object literal and `eval`-ing it. The input is
this repo's own committed, self-generated source (not user/network data); it holds only
JSON-compatible values, so the `eval` → `JSON.stringify` round-trip is lossless and
byte-stable. `eval` runs only in the deploy/CI toolchain, never at app runtime. (`JSON.parse`
can't read the unquoted numeric keys + `as const`; importing the module is circular via the
nextjs `~~/…` path alias.)

## Consequences

- **Multi-chain safe.** Adding mainnet later is just another preserved block — no further
  generator or CI change. A single-network deploy can never again wipe another chain.
- **The pin still holds.** `31337` stays byte-deterministic; `deploy-pin-check` regains its
  meaning across all chains with no job edit.
- **Real-network blocks are preserved, not re-verified.** CI cannot re-derive a real testnet/
  mainnet deployment without redeploying it, so the check guards those blocks against the
  *automated* clobber footgun only. A *manual* edit to a frozen block is caught by human PR
  review (it shows as a diff in the author's commit), not by this check — an accepted boundary.
- One-time fix-up: this change ships with `31337`'s `EFSFileView` ABI regenerated to current
  (the `getDataMirrorsAllAttesters` drift), with `11155111` preserved byte-identical.

## Alternatives considered

- **Scope `deploy-pin-check` to the `31337` block only.** Smaller change, but leaves every
  real-network block unguarded against the clobber footgun — and that risk grows with each
  chain added. Rejected: treats the symptom (the check) not the cause (overwrite generation).
- **Move Sepolia addresses out of `deployedContracts.ts` into `externalContracts.ts`.** Breaks
  the ADR-0037 freeze pattern and the devnet/client consumers that read `deployedContracts.ts`
  as the single source of truth. Rejected.
