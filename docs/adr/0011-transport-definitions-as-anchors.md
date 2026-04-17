# ADR-0011: Transport definitions as anchors under `/transports/`

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0001, ADR-0023

## Context

MIRRORs need a way to identify the transport type (web3, ipfs, ar, https, magnet, future ones). Options:
1. Enum field in MIRROR schema — fixed set, requires contract upgrade to add new transports.
2. String field (e.g. "ipfs") — flexible but unstructured, prone to typos and collisions.
3. Reference to a registry contract — adds dependency.
4. Reference to an Anchor — uses the existing path system as a registry.

## Decision

Transport types are Anchors under a system folder `/transports/`:
- `/transports/onchain`
- `/transports/ipfs`
- `/transports/arweave`
- `/transports/magnet`
- `/transports/https`

MIRROR's `transportDefinition` field is the UID of one of these Anchors. MirrorResolver validates ancestry via `_isDescendantOfTransports` (up to 8 levels deep — supports nested like `/transports/ipfs/v2`).

## Consequences

- **Extensible**: new transports are just new Anchor attestations under `/transports/`. No contract upgrade.
- **Self-describing**: the transport anchor itself can carry metadata (PROPERTYs describing the protocol, gateways, etc.).
- **Validatable**: arbitrary anchors (like `/memes/cat.jpg`) can't be used as transport labels — MirrorResolver rejects them.
- The `/transports/` anchor UID is wired into MirrorResolver via `setTransportsAnchor()` (one-time, deployer-only). If misconfigured at deploy, MIRRORs can't be created — caught early in deploy testing.
- 8-level nesting cap on transport definitions. Practically generous; `/transports/ipfs/gateway/us-east/v2` is the kind of pathological depth users won't hit.
