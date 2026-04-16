# Architecture Decision Records

ADRs document **decisions** made about EFS — what we chose, why, and what we considered. They are the institutional memory that survives turnover (human or agent).

## Status legend

- **Proposed** — under discussion, not yet acted on.
- **Accepted** — currently in force. Code reflects this decision.
- **Superseded by ADR-NNNN** — replaced by a later decision. The superseded ADR is preserved unmodified for historical context; the link points to the replacement.
- **Rejected** — considered and explicitly chosen against. Preserved so the option isn't reconsidered without learning from the prior thinking.
- **Deprecated** — no longer the right choice but not yet replaced. May indicate a known wart.

## Discipline

ADRs are **immutable** once `Status: Accepted`. To change a decision:
1. Write a new ADR with the new approach.
2. Update the old ADR's `Status` line to `Superseded by ADR-NNNN`. Touch nothing else in the old ADR.
3. The new ADR's Context section explains why the old one was insufficient.

This preserves the chain of reasoning. Future agents can see *why* we tried X, *why* we moved to Y, and *what we learned*.

## Format

Compact, scannable. Aim for one screen per ADR.

```markdown
# ADR-NNNN: Title

**Status:** Accepted
**Date:** YYYY-MM-DD
**Related:** PR #N, ADR-XXXX (if relevant)

## Context
Why this decision was needed. What problem are we solving?

## Decision
What we chose. Specific enough to act on.

## Consequences
What this enables, what it costs, what follow-up work it implies.

## Alternatives considered (optional)
What else we looked at and why it lost.
```

## Index

### Data Model
- [ADR-0001 — Three-layer data model: Paths → Data → Mirrors](./0001-three-layer-data-model.md)
- [ADR-0002 — DATA is standalone and non-revocable](./0002-data-standalone-non-revocable.md)
- [ADR-0003 — TAG-based file placement instead of refUID](./0003-tag-based-placement.md)
- [ADR-0004 — Content dedup via `dataByContentKey`](./0004-content-dedup-via-dataByContentKey.md)
- [ADR-0005 — ContentType moved from DATA to PROPERTY](./0005-content-type-moved-to-property.md)
- [ADR-0006 — Folders don't need TAGs for visibility](./0006-folders-no-tags-for-visibility.md)

### Index Design
- [ADR-0007 — `_activeByAttesterAndSchema`: swap-and-pop compact index](./0007-activeByAttesterAndSchema-swap-and-pop.md)
- [ADR-0008 — Qualifying-folder write-time index](./0008-qualifying-folder-write-time-index.md)
- [ADR-0009 — Append-only indices stay append-only](./0009-append-only-indices.md)
- [ADR-0010 — `_containsAttestations` propagation is one-way (sticky)](./0010-contains-attestations-sticky-propagation.md)

### Transports & Mirrors
- [ADR-0011 — Transport definitions as anchors under `/transports/`](./0011-transport-definitions-as-anchors.md)
- [ADR-0012 — Transport priority order: web3 > ar > ipfs > magnet > https](./0012-transport-priority-order.md)
- [ADR-0013 — Edition-scoped mirror selection](./0013-edition-scoped-mirror-selection.md)
- [ADR-0014 — Edition-scoped PROPERTY lookup](./0014-edition-scoped-property-lookup.md)
- [ADR-0015 — No singleton enforcement for MIRRORs](./0015-no-singleton-mirrors.md)

### Router & Resolution
- [ADR-0016 — Bare web3:// URL fallback: caller → EFS deployer](./0016-bare-web3-url-fallback.md)
- [ADR-0017 — `?caller=` query param for identity](./0017-caller-query-param.md)
- [ADR-0018 — Single `message/external-body` Content-Type header](./0018-single-content-type-header.md)
- [ADR-0019 — Non-reverting hex parser](./0019-non-reverting-hex-parser.md)
- [ADR-0020 — `MAX_PAGES = 10` mirror scan cap](./0020-max-pages-mirror-scan-cap.md)

### Security Limits
- [ADR-0021 — `MAX_ANCHOR_DEPTH = 32`](./0021-max-anchor-depth.md)
- [ADR-0022 — `MAX_URI_LENGTH = 8192` in MirrorResolver](./0022-max-uri-length.md)
- [ADR-0023 — URI scheme allowlist in MirrorResolver](./0023-uri-scheme-allowlist.md)
- [ADR-0024 — Content-Type sanitization](./0024-content-type-sanitization.md)
- [ADR-0025 — Anchor name validation](./0025-anchor-name-validation.md)
- [ADR-0026 — `MAX_EDITIONS = 20`](./0026-max-editions.md)

### Deploy & Infrastructure
- [ADR-0027 — Deploy-before-register pattern](./0027-deploy-before-register.md)
- [ADR-0028 — CI graceful degradation](./0028-ci-graceful-degradation.md)
- [ADR-0029 — Dual licensing: MIT for contracts, AGPL for web client](./0029-dual-licensing-mit-agpl.md)

### Architectural Foundations
- [ADR-0030 — Mainnet permanence (no upgradeability)](./0030-mainnet-permanence.md)
- [ADR-0031 — Editions as URL query param with first-wins fallback](./0031-editions-url-param-model.md)
- [ADR-0032 — EAS as foundational dependency](./0032-eas-as-foundation.md)
