# ADR-0017: `?caller=` query param for identity

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0016

## Context

ERC-5219 `request()` is called via `eth_call`. In that context, `msg.sender` is unreliable:
- Public RPC nodes typically use `address(0)`.
- Some clients use the gateway's address.
- Wallet-aware clients might use the connected wallet, but inconsistently.

To make "default to my own files" work, the router needs a reliable signal of who's asking.

## Decision

The router accepts a `?caller=<address>` query parameter. Web3:// clients (especially the production EFS Client UI) pass the connected wallet address explicitly. The router uses it for the editions fallback (ADR-0016) and any other identity-dependent behavior.

`msg.sender` is no longer trusted for identity decisions.

## Consequences

- **Reliable identity** in eth_call contexts.
- Trivially spoofable (anyone can put any address in `?caller=`) — but that's fine, since it's just a hint for "whose default view to show," not an authentication mechanism. Real authentication comes from `?editions=` (the viewer explicitly chooses what to trust).
- Production client must pass `?caller=` consistently for the UX to feel right.
- Existing `web3://` libraries / w3link.io don't pass this by default — until they do, bookmarked URLs may surface deployer content rather than the user's own.
