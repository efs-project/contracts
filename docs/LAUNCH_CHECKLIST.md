# Launch Checklist

> **Status: retired v1 checklist.** The April 2026 devnet/mainnet schedule was
> not the plan EFS ultimately followed. Do not use its dates, unchecked items,
> or architecture assumptions to plan current work.

## Current launch posture

- The EAS-based v1 system is deployed to Sepolia. Nine schemas were registered
  and the initial scaffolding was sealed on 2026-06-19; current addresses and
  authority state live in `docs/CHAINS.md`.
- Mainnet has not been deployed and has no active launch date.
- The project is redesigning EFS from scratch as v2. The carrier, identity,
  authority, record, lens, query, privacy, filesystem, SDK, and client
  boundaries are being reconsidered together.
- Existing v1 contracts, deployment tooling, explorer, SDK branch, and client
  are evidence and reference implementations. They are not a mainnet release
  candidate by default.

The active project milestone surface is the planning vault's `Milestones.md`.
The current v2 architecture and sequencing live under
`planning/Designs/efsv2/`.

## Historical v1 outcome

The old checklist mixed three different efforts:

1. an April forked devnet;
2. the later Sepolia deployment and buildathon;
3. a proposed immutable v1 mainnet launch.

Sepolia shipped. The buildathon wound down with low participation. The v1
mainnet launch did not happen, and the v2 redesign superseded the old delivery
plan before its unchecked items were reconciled.

Git history preserves the detailed April checklist. It remains historical
evidence, not an active work queue.

## Gate for a future launch checklist

Create a new dated checklist only after James has explicitly set a launch
milestone and all of the following exist:

- an adopted v2 constitution and support matrix;
- an implementation target with current specs and ADR boundaries;
- a deployment and migration posture;
- explicit security-review and audit requirements;
- a client/SDK release surface;
- honest data-durability, authority, privacy, and operational claims.

Until then, track research and implementation in the planning vault and
repo-local PRs. Do not convert design hypotheses into launch blockers or
calendar commitments.
