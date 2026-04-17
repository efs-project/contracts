# ADR-0014: Edition-scoped PROPERTY lookup

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit 298438e, ADR-0005, ADR-0013

## Context

`_getContentType` reads PROPERTY attestations on a DATA to find the contentType. Same vulnerability class as MIRROR injection (ADR-0013): a malicious user could attest `PROPERTY(key="contentType", value="text/html")` on someone else's DATA, hoping a viewer fetches it and a renderer interprets the bytes as HTML — a stored XSS vector.

## Decision

`_getContentType` is scoped to the edition attester (the address whose TAG resolved the DATA), using `getReferencingBySchemaAndAttester` for the per-attester PROPERTY index.

## Consequences

- **MIME-type injection blocked**: attackers can't poison contentType to trigger XSS in clients that respect server-supplied MIME types.
- Consistent with mirror scoping (ADR-0013): everything served alongside a DATA comes from the same trust scope.
- An edition attester is responsible for their own contentType claims. Off-chain clients can sniff content as a defense in depth, but the router serves whatever PROPERTY the trusted attester set.
- If an attester attaches no contentType PROPERTY: fall back to `application/octet-stream` (the safe default — clients render as a download, not as live content).
