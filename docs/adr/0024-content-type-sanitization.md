# ADR-0024: Content-Type sanitization

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit c548351, ADR-0014, ADR-0018

## Context

The single Content-Type header (ADR-0018) embeds the user-supplied contentType as a quoted parameter:

```
Content-Type: message/external-body; ...; content-type="<value>"
```

If `<value>` contains `"`, `\`, or control characters (including CRLF), it could break out of the quoted context and inject extra headers. PROPERTY values are user-supplied, so this is a real attack surface.

## Decision

EFSRouter's `_sanitizeHeaderValue` strips:
- `"` (would break the quoted context)
- `\` (would enable backslash escapes)
- All control chars `< 0x20` (CR, LF, tab, NUL — CRLF is the classic header-injection vector)

Two-pass implementation: count safe bytes, then build the sanitized string. Skip allocation entirely if nothing needs stripping (common case).

## Consequences

- **Header injection blocked**: an attester can't inject extra HTTP headers via PROPERTY contentType.
- Strips legitimate-but-rare characters (e.g. `\` in obscure MIME parameter values). Acceptable — modern MIME types don't use these.
- Defense-in-depth: gateways should also sanitize, but the router doesn't trust them to.
