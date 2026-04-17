# ADR-0032: EAS as foundational dependency

**Status:** Accepted
**Date:** 2026-04-16 (formalized retroactively)

## Context

EFS could have been built as a standalone primitive (custom storage contracts, custom revocation logic, custom event indices) or as a layer on top of an existing attestation infrastructure. The choice determines the project's strategic exposure.

EAS (Ethereum Attestation Service) provides:
- A standardized attestation primitive across the EVM ecosystem.
- Schema registry with deterministic UIDs.
- Resolver hook architecture (`onAttest`, `onRevoke`) — exactly the extension point EFS needs.
- Existing cross-tool support (block explorers, indexers, dashboards).

## Decision

EFS is built as a layer on EAS. All EFS data is EAS attestations. The six EFS schemas (ANCHOR, DATA, MIRROR, TAG, PROPERTY, SORT_INFO) are registered in the EAS SchemaRegistry and use EAS attestation flow.

The EFS contracts (EFSIndexer, TagResolver, MirrorResolver, EFSSortOverlay) are EAS resolvers — they hook into EAS via the resolver pattern.

## Consequences

- **Inherited tooling**: any EAS-aware tool (easscan.org, easexplorer, etc.) can read EFS data.
- **Inherited audit surface**: EAS's security properties become EFS's security properties. EAS has been audited and battle-tested; this is a strength.
- **Strategic dependency**: EFS's fate is yoked to EAS's. If EAS is deprecated, replaced, or significantly changes incentives, EFS either follows or forks.
- **Deployment dependency**: EAS must be deployed on every chain where EFS deploys. Currently OK (EAS is on most major chains); future chains require coordination.
- **EAS attestations cost more than raw storage**: EFS pays for EAS's flexibility with per-attestation gas overhead. Accepted as the cost of standardization.
- **Cannot extend EAS schemas**: if EFS needs a field EAS schemas don't natively support (e.g. structured metadata), it goes into PROPERTY (ADR-0005) — works but adds attestations.

This is a strategic bet. The team accepts it as the right one for v1.
