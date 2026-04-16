# ADR-0023: URI scheme allowlist in MirrorResolver

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit e523335, ADR-0012

## Context

Without scheme validation, a MIRROR with `javascript:alert(1)` or `data:text/html,<script>...</script>` could be attested. The router doesn't execute URIs (it just stores and returns them), but off-chain clients that render mirror URIs in `<a href="...">` or similar contexts would be vulnerable to XSS.

## Decision

MirrorResolver's `onAttest` rejects URIs not starting with one of:
- `web3://`
- `ipfs://`
- `ar://`
- `https://`
- `magnet:`

Implemented via `_isAllowedScheme` which checks the prefix against the allowlist.

## Consequences

- **XSS via mirror URI eliminated**: `javascript:`, `data:`, `ftp:`, and any other scheme can't even be attested.
- Adding a new transport requires both an allowlist update (ADR-0023) and a priority decision (ADR-0012). Both are on-chain code changes.
- Case-sensitive — `Web3://` would be rejected. Acceptable: schemes are canonical lowercase per RFC 3986.
- `http://` (no S) is intentionally not allowed — encourages TLS-only links.
