# ADR-0029: MIT license for EFS contracts (web client license deferred)

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)

## Context

Contracts are deployed once and immutable on-chain. Restrictive licensing has no enforcement mechanism — anyone can call them, fork them, or reuse the bytecode. The pragmatic choice is maximum permissiveness for adoption.

The web client's licensing raises different considerations: the user-facing surface may warrant copyleft terms (AGPL) to deter closed-source forks. That decision has not been made yet; the production EFS Client lives in a separate repository whose license will be set there.

## Decision

- **Contracts (`packages/hardhat/`)**: MIT. Implemented via `LICENSE` at the repo root.
- **Scaffold-ETH base**: the original BuidlGuidl `LICENCE` file (also MIT) is preserved untouched for attribution.
- **Web client license**: **deferred.** The production EFS Client is a separate repo; its license is not set by this ADR. The internal devtools UI in `packages/nextjs/` inherits Scaffold-ETH's MIT license by default.
- AGPL for the web client is a **working recommendation, not an applied license**. When the production client repo formalizes its license, a follow-up ADR should record the final choice.

## Consequences

- Maximum adoption surface for contracts — anyone can build alternative clients, indexers, or wrappers without friction.
- **Both license files at the repo root are MIT today. No AGPL text exists in this repo.** Any claim that AGPL already applies would be inaccurate.
- The web-client-AGPL plan remains an open question. See `docs/QUESTIONS.md` when formalizing the production client repo.
- Future Solidity contributors see MIT and contribute easily. Future client contributors will see whatever the production client repo sets.

## Alternatives considered

- AGPL throughout: rejected for contracts (unenforceable on-chain; also deters integration tooling).
- MIT throughout (current state): acceptable default until the production client repo launches; may be superseded if AGPL is adopted there.
