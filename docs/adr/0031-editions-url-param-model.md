# ADR-0031: Editions as URL query param with first-wins fallback

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0003, ADR-0013, ADR-0016

## Context

EFS supports multiple attesters publishing content under the same path system. Viewers need a way to choose **whose content they want to see**. The choice must be:
- Trustless — viewers control which attesters they trust, not the system.
- Composable — multiple attesters can be combined.
- URL-shareable — bookmarkable, postable.

## Decision

The viewer specifies attesters via a URL query parameter:

```
web3://<router>/path/file?editions=alice.eth,0xBob...,carol.eth
```

ENS names are resolved client-side. Addresses are passed through as-is.

**Resolution model: first-attester-wins fallback.** The router tries each attester in order. The first attester with active content at the requested path serves it; later attesters are not consulted.

When no `?editions=` is supplied, fall back to `?caller=` (ADR-0017), then to deployer (ADR-0016).

## Consequences

- **Viewer sovereignty**: every URL explicitly says whose content is being shown. No silent system-curated overrides.
- **Composable curation**: users can build "my edition list" and share URLs.
- **Order matters**: `?editions=alice,bob` and `?editions=bob,alice` may resolve differently. This is a feature (intentional precedence) but needs UX framing — users may expect "merge by newest" semantics.
- **20-edition cap** (ADR-0026) prevents unbounded URL parsing.
- **Future merge semantics** (timestamp-wins, consensus-based, etc.) are not currently supported. Future work — could be a new router function `_findDataAtPathMerge()` alongside the existing `_findDataAtPath()`. See `docs/FUTURE_WORK.md`.
- **No on-chain edition lists**: the URL is the list. A future enhancement could let users register edition lists as Anchors with member PROPERTYs, then reference the list by UID. Not done in v1.
