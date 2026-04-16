# ADR-0018: Single `message/external-body` Content-Type header

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commits 81e7eaf, c548351

## Context

For external transports (ipfs://, ar://, https://, magnet:), the router needs to communicate two things to the client: the redirect URL, and the actual content type behind it. The original implementation sent two `Content-Type` headers:

```
Content-Type: message/external-body; access-type=URL; URL="ipfs://..."
Content-Type: image/png
```

HTTP clients handle duplicate headers inconsistently — some take the first, some concatenate, some reject. The behavior wasn't reliable across the gateway ecosystem.

## Decision

Single `Content-Type` header with the inner type as a quoted parameter:

```
Content-Type: message/external-body; access-type=URL; URL="ipfs://..."; content-type="image/png"
```

The inner `contentType` is sanitized (`_sanitizeHeaderValue`, ADR-0024) to strip quotes and control chars before embedding.

## Consequences

- **Single header**, no client-side ambiguity.
- Not strictly RFC 2046 (the spec puts the inner Content-Type in the message body after a blank line, not as a quoted parameter). Practical compromise — `web3://` gateways aren't strict MIME parsers.
- The quoted parameter is escapable via `_sanitizeHeaderValue` — header injection prevented.
- If a future strict-MIME client misinterprets, fallback to `application/octet-stream` is the safe outcome (the URL still works).
