# ADR-0025: Anchor name validation

**Status:** Accepted
**Date:** 2026-04-16
**Related:** PR #8 commit f687b57

## Context

Anchor names are path segments in `web3://` URIs. The original `TopicResolver.sol` enforced `isValidIriComponentForStorage` which rejected empty names, null bytes, and 18 IRI-unsafe characters. This validation was lost in the refactor to EFSIndexer, allowing arbitrary names including:
- Empty strings (invisible folders)
- `.` and `..` (confuses off-chain clients)
- `/`, `:`, `#`, `?`, `&`, `%`, `=`, `@`, `\` (break URI parsing)
- Null bytes and control chars (storage and rendering issues)

## Decision

EFSIndexer's `_isValidAnchorName` rejects:
- Empty strings
- `.` and `..` (reserved names)
- NUL (`0x00`)
- Space (`0x20`)
- The IRI-unsafe set: `/`, `:`, `#`, `?`, `&`, `%`, `=`, `@`, `\` (and other RFC 3986 reserved bytes)

Called from `onAttest` for the ANCHOR schema. Mirrors the original `TopicResolver` rules.

## Consequences

- **`web3://` URI construction is reliable**: no unescaped reserved characters break path parsing.
- Off-chain clients (file browsers, indexers) don't have to handle pathological names like `..`.
- Users who try to create folders with `/` in the name see an early revert — better UX than a broken URL later.
- Length cap (255 bytes) is not currently enforced. Acceptable for now; can be added if storage cost becomes a concern.
- High-bit/Unicode bytes pass through unchanged — non-ASCII filenames work, percent-encoded as needed by the URI layer.
