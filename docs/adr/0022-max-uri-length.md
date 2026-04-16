# ADR-0022: `MAX_URI_LENGTH = 8192` in MirrorResolver

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)
**Related:** ADR-0011, ADR-0023

## Context

MIRROR attestations carry a URI string. Without a cap, an attacker could attest a multi-megabyte URI, inflating EAS storage cost and bloating router calldata when the URI is later read.

## Decision

`uint256 public constant MAX_URI_LENGTH = 8192;` enforced in MirrorResolver's `onAttest`.

## Consequences

- Prevents storage griefing via gigantic URIs.
- 8KB is generous — typical `ipfs://Qm...`, `ar://...`, `https://...`, `magnet:` URIs are well under 1KB.
- Magnet URIs with long trackers list can be larger but still well under 8KB in practice.
- If an exotic transport ever needs longer URIs, that's a design discussion (probably a Tier 2 question per AGENTS.md).
