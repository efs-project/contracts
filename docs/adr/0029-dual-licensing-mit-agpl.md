# ADR-0029: Dual licensing — MIT for contracts, AGPL for web client

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)

## Context

Two distinct codebases need licenses suited to their nature:

- **Contracts** are deployed once and immutable on-chain. Restrictive licensing has no enforcement mechanism — anyone can call them, fork them, or reuse the bytecode. The pragmatic choice is maximum permissiveness for adoption.
- **Web client** is the user-facing surface. Closed-source forks would let competitors take the work, polish it for paying customers, and contribute nothing back. AGPL closes that loophole while still allowing legitimate use.

## Decision

- **Contracts (`packages/hardhat/`)**: MIT.
- **Web client (`packages/nextjs/`, external EFS Client repo)**: AGPL recommended.
- The original Scaffold-ETH `LICENCE` (BuidlGuidl) is preserved untouched. A new `LICENSE` (EFS Project) is added at the repo root for EFS-specific code.

## Consequences

- Maximum adoption surface for contracts — anyone can build alternative clients, indexers, or wrappers.
- AGPL on the web client deters closed-source forks while remaining open-source-compatible.
- Dual-license boundary is the package directory — clear and enforceable.
- Future Solidity contributors see MIT and contribute easily; future client contributors see AGPL and understand the implication.
- Note: web client AGPL applies to the production EFS Client (separate repo). The internal devtools UI in `packages/nextjs/` may inherit Scaffold-ETH's license unless explicitly relicensed. Worth clarifying when the production client repo formalizes its license.
