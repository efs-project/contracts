# ADR-0027: Deploy-before-register pattern

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** PR #8 commit 91f56aa

## Context

EAS schemas are registered with a resolver address baked into the schema UID hash. Originally, the deploy script registered schemas first (using a *predicted* future resolver address) and then deployed the resolver at the predicted address. This was fragile:

- A failed transaction between registration and deployment shifted the nonce, breaking the prediction.
- A concurrent transaction (rare but possible) could insert and shift the deployment to a different address.
- The mismatch wasn't always caught — schemas would silently point at a dead address.

## Decision

Deploy resolvers **first**, then register schemas with the actual resolver address.

For MirrorResolver, this is straightforward — deploy MirrorResolver, get its address, register MIRROR schema with that address.

For TagResolver and EFSIndexer (which reference each other), the script still uses nonce prediction for the bidirectional dependency, but with a **post-deploy assertion** that the predicted address matches the actual deployed address.

## Consequences

- **Eliminates nonce-prediction fragility** for resolvers that don't have circular dependencies.
- Deploy script aborts loudly on address mismatch instead of producing a broken system.
- Slightly more complex deploy ordering (was: register all schemas, then deploy. Now: alternate between deploys and registrations).
- Mainnet deploy is one-shot — this pattern is the only safe approach for production.
