# ADR-0028: CI graceful degradation

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)

## Context

Local development uses `yarn fork` which forks Sepolia and gives access to the deployed EAS contracts. CI uses `yarn chain` (a plain hardhat node with no EAS contracts) for speed. Deploy steps that depend on EAS — particularly attestation-creating steps like `setTransportsAnchor` — would revert on the bare CI node.

## Decision

Deploy scripts guard EAS-dependent steps with capability checks. For example, `setTransportsAnchor` is guarded against a zero-UID transport anchor — if the transports anchor wasn't created (because EAS isn't available), the call is skipped instead of reverting.

CI deploy completes successfully with reduced state; full functionality requires the Sepolia fork.

## Consequences

- **CI is fast** — no Sepolia fork required for compile + unit-test runs.
- Deploy scripts work in two modes: full (with EAS) and minimal (without). Reduces "works locally, breaks in CI" surprises.
- Some end-to-end tests (router, transports, e2e) still require the fork — these run locally or on a dedicated integration job.
- Risk: a deploy step might silently degrade in CI when it should fail. Mitigation: explicit logging when degradation kicks in.
