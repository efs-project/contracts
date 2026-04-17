# ADR-0012: Transport priority order — web3 > ar > ipfs > magnet > https

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0011, ADR-0013

## Context

When a DATA has multiple MIRRORs, the router must pick one to serve. Priority should reflect: permanence, content-addressability, gateway availability, and decentralization properties.

## Decision

Priority (highest first) hardcoded in EFSRouter's `_getBestMirrorURI`:

| Priority | Transport | Rationale |
|----------|-----------|-----------|
| 0 | `web3://` | On-chain, permanent, content-addressed by smart contract address. |
| 1 | `ar://` | Permanent (Arweave's economic model), content-addressed, no active maintenance needed. |
| 2 | `ipfs://` | Content-addressed, but requires active pinning — pins lapse. |
| 3 | `magnet:` | Content-addressed peer-to-peer, but no gateway fallback — depends on swarm health. |
| 4 | `https://` | Mutable, centralized. Last resort. |

## Consequences

- A DATA with both `web3://` and `https://` mirrors always serves the on-chain version.
- Adding `ar://` to a DATA improves resolution quality without removing existing mirrors.
- Hardcoded priority means new transports require contract change to rank — even though new transports themselves don't (ADR-0011). Deferred enhancement: per-transport priority as a PROPERTY on the transport anchor. See `docs/FUTURE_WORK.md`.
- Within a priority bucket, the router serves the first valid one found (paged with `MAX_PAGES` cap, ADR-0020).
- HTTPS at priority 4 (not 3) reflects the project's strong preference for content-addressed transports. May surprise users; documented in client UI.
