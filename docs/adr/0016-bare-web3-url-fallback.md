# ADR-0016: Bare `web3://` URL fallback — caller → EFS deployer

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0017, ADR-0031

## Context

When a user navigates to `web3://<router>/path/file` with no `?editions=` parameter, the router needs to know whose content to serve. Three options:

1. Return 404 — user must always specify editions.
2. Show "all editions" — aggregate across every attester. No clear precedence; potentially huge result.
3. Pick a sensible default attester.

Option 3 is best for UX (URL works without setup), but who?

## Decision

Two-step fallback when `?editions=` is absent:

1. Use `?caller=<address>` if present — the wallet address of the person making the request (passed by web3:// clients that have one).
2. Else use `indexer.DEPLOYER()` — the address that deployed EFS, treated as the "system content" curator.

`msg.sender` is unreliable in `eth_call` contexts (often `address(0)` or the gateway's address), so it's not used.

## Consequences

- **Bookmarkable URLs work**: `web3://<router>/file` resolves to *something*, not 404.
- Users see their own files by default when they specify `?caller=`.
- System-curated content (deployer's attestations) is the global default — gives the project a place to surface canonical content.
- "Public view" (genuinely all-editions aggregation) is deferred. See `docs/FUTURE_WORK.md`. The current model still respects user sovereignty: nobody sees foreign content unless they explicitly opt in via `?editions=`.
- The deployer becomes a quasi-special address — their content has higher visibility by default. Consider whether this should remain post-launch or be transferred to a multisig/community curator.
