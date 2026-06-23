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

This preserves the chain of reasoning. Future agents can see _why_ we tried X, _why_ we moved to Y, and _what we learned_.

### Partial supersession / amendment (Status-line note)

When a later ADR changes only _part_ of an earlier decision (e.g. ADR-0049 moved DATA's fields out but left "standalone + non-revocable" intact; ADR-0050 amended ADR-0048's freeze count from 8 to 9 schemas), record it as a **parenthetical on the old ADR's Status or Related line only** — e.g. `Accepted (superseded in part by ADR-0049 — …; standalone + non-revocable still hold)`. The body stays untouched; the new ADR's Context explains the amendment. This is the house pattern (human-approved 2026-06-11): the Status line is the ADR's one mutable slot, so a reader landing on the old ADR sees immediately which parts still bind without the historical record being rewritten. Do **not** route these through a separate tombstone log — the pointer belongs on the document itself.

### Grace period for retroactive ADRs

ADRs marked `formalized retroactively` capture a decision made _before_ the ADR was written, so the first readers may catch prose-level errors (wrong cross-reference, miscounted schemas, stale function name, inaccurate gas estimate) that don't reflect the decision itself.

For the first **30 days** after a retroactive ADR's write-up date, **prose-accuracy corrections may be made in place** — fix the wording, commit with a message explaining the correction, add a short note at the bottom of the ADR if the correction is substantive (e.g. "Correction 2026-05-01: gas estimate was off by 1 SSTORE; real cost is two.").

After 30 days, or for any change that modifies the actual decision or its consequences, supersession is required.

**In-place corrections are never allowed for:** the `Decision` section's content, the `Consequences` semantics, or the `Alternatives considered` arguments. Those are the historical record.

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
- [ADR-0003 — TAG-based file placement instead of refUID](./0003-tag-based-placement.md) _(Placement principle intact; `applies: bool` field semantics superseded by ADR-0041 — see Decision §weight)_
- [ADR-0004 — Content dedup via `dataByContentKey`](./0004-content-dedup-via-dataByContentKey.md)
- [ADR-0005 — ContentType moved from DATA to PROPERTY](./0005-content-type-moved-to-property.md)
- [ADR-0006 — Folders don't need TAGs for visibility](./0006-folders-no-tags-for-visibility.md) _(Superseded by ADR-0038)_
- [ADR-0038 — Tag-only folder visibility (single-source)](./0038-tag-only-folder-visibility.md)
- [ADR-0049 — DATA is pure identity; hash and size are data, not identity](./0049-file-content-identity-hash-as-data.md)
- [ADR-0050 — REDIRECT: first-class canonical / sameAs / symlink edge](./0050-redirect-canonical-symlink-schema.md)
- [ADR-0052 — PROPERTY is non-revocable (interned shared value)](./0052-property-is-non-revocable.md)
- [ADR-0064 — `contentHash`/`size`/`cid` self-describing encoding (multibase-multihash + CID)](./0064-content-hash-self-describing-encoding.md) _(Accepted — sha2-256 canonical so `contentHash` shares the IPFS CID digest; keccak-256 optional alternate)_

### Index Design

- [ADR-0007 — `_activeByAttesterAndSchema`: swap-and-pop compact index](./0007-activeByAttesterAndSchema-swap-and-pop.md) _(Swap-and-pop decision intact; array element type widened from `bytes32` to `TagEntry { tagUID, weight }` per ADR-0041)_
- [ADR-0008 — Qualifying-folder write-time index](./0008-qualifying-folder-write-time-index.md)
- [ADR-0009 — Append-only indices stay append-only](./0009-append-only-indices.md)
- [ADR-0010 — `_containsAttestations` propagation is one-way (sticky)](./0010-contains-attestations-sticky-propagation.md)
- [ADR-0066 — `index()` is discovery-only; folder presence is placement-driven](./0066-index-discovery-only-no-folder-presence.md)

### Transports & Mirrors

- [ADR-0011 — Transport definitions as anchors under `/transports/`](./0011-transport-definitions-as-anchors.md)
- [ADR-0012 — Transport priority order: web3 > ar > ipfs > magnet > https](./0012-transport-priority-order.md)
- [ADR-0013 — Lens-scoped mirror selection](./0013-lens-scoped-mirror-selection.md)
- [ADR-0014 — Lens-scoped PROPERTY lookup](./0014-lens-scoped-property-lookup.md)
- [ADR-0015 — No singleton enforcement for MIRRORs](./0015-no-singleton-mirrors.md)
- [ADR-0063 — `data:` inline-mirror transport for small files](./0063-data-uri-inline-mirror-transport.md)

### Router & Resolution

- [ADR-0016 — Bare web3:// URL fallback: caller → EFS deployer](./0016-bare-web3-url-fallback.md)
- [ADR-0017 — `?caller=` query param for identity](./0017-caller-query-param.md)
- [ADR-0018 — Single `message/external-body` Content-Type header](./0018-single-content-type-header.md)
- [ADR-0019 — Non-reverting hex parser](./0019-non-reverting-hex-parser.md)
- [ADR-0020 — `MAX_PAGES = 10` mirror scan cap](./0020-max-pages-mirror-scan-cap.md)
- [ADR-0057 — Production ERC-5219 on-chain byte store (EFSBytesStore)](./0057-production-erc5219-bytes-store.md)
- [ADR-0058 — Harden the EFSRouter web3:// serving path (pagination round-trip, parity, sanitization)](./0058-router-web3-serving-hardening.md)
- [ADR-0059 — web3:// reads depend on extcodecopy; EOF/EVM-evolution survival posture](./0059-extcodecopy-eof-survival-posture.md)
- [ADR-0060 — Multi-chain web3:// addressing: per-chain ENS subdomains + movable default](./0060-multichain-web3-ens-addressing.md) _(Proposed)_
- [ADR-0067 — REDIRECT read-time resolution rules](./0067-redirect-read-time-resolution.md) _(Accepted — symlink-only following (supersededBy is a non-followed terminal; path=newest/UID=exact), D_MAX=16/ceiling 32, cycle-stop, lowest-UID-in-SCC canonicalization, lens precedence, WHITEOUT negative-terminal reservation + seeding ban; gates durable REDIRECT seeding)_

### Security Limits

- [ADR-0021 — `MAX_ANCHOR_DEPTH = 32`](./0021-max-anchor-depth.md) _(Superseded by ADR-0065 — raised to 1024)_
- [ADR-0022 — `MAX_URI_LENGTH = 8192` in MirrorResolver](./0022-max-uri-length.md)
- [ADR-0065 — Raise `MAX_ANCHOR_DEPTH` to 1024; no anchor-name length cap](./0065-raise-max-anchor-depth-and-no-name-length-cap.md)
- [ADR-0023 — URI scheme allowlist in MirrorResolver](./0023-uri-scheme-allowlist.md)
- [ADR-0024 — Content-Type sanitization](./0024-content-type-sanitization.md)
- [ADR-0025 — Anchor name validation](./0025-anchor-name-validation.md)
- [ADR-0026 — `MAX_LENSES = 20`](./0026-max-lenses.md)

### Deploy & Infrastructure

- [ADR-0027 — Deploy-before-register pattern](./0027-deploy-before-register.md)
- [ADR-0028 — CI graceful degradation](./0028-ci-graceful-degradation.md)
- [ADR-0029 — MIT license for EFS contracts (web client license deferred)](./0029-dual-licensing-mit-agpl.md)
- [ADR-0037 — Pinned Sepolia fork for cross-environment determinism](./0037-pinned-sepolia-fork.md)
- [ADR-0048 — Sepolia freeze set + proxy-ready resolvers (burn to immutable)](./0048-sepolia-freeze-set-and-proxy-ready-resolvers.md)
- [ADR-0061 — deployedContracts.ts is multi-chain; generation merges per-chain](./0061-multichain-deployedcontracts-merge.md)
- [ADR-0062 — Devnet gets its own chainId (26001993), distinct from the local fork](./0062-devnet-own-chainid.md) _(supersedes ADR-0037 in part)_

### Architectural Foundations

- [ADR-0030 — Mainnet permanence (no upgradeability)](./0030-mainnet-permanence.md)
- [ADR-0031 — Lenses as URL query param with first-wins fallback](./0031-lenses-url-param-model.md)
- [ADR-0032 — EAS as foundational dependency](./0032-eas-as-foundation.md)
- [ADR-0053 — SystemAccount: the neutral system write-identity](./0053-system-account-write-identity.md)

### Navigation & Containers

- [ADR-0033 — Root containers and schema alias anchors](./0033-root-containers-and-schema-alias-anchors.md)
- [ADR-0034 — `name` PROPERTY as display-name fallback](./0034-display-name-property-convention.md)
- [ADR-0035 — PROPERTY as free-floating value placed via TAG](./0035-property-free-floating-and-tag-placed.md) _(Superseded by ADR-0041)_
- [ADR-0039 — Default lenses priority chain](./0039-default-lenses-priority-chain.md)
- [ADR-0041 — PIN/TAG schema split for cardinality, with weighted edges](./0041-pin-tag-schema-split-for-cardinality.md)
- [ADR-0043 — Rename "editions" to "lenses"](./0043-rename-editions-to-lenses.md)
- [ADR-0055 — WHITEOUT: cross-lens negative masking (overlay deletion)](./0055-whiteout-cross-lens-negative-mask.md) _(Accepted — dedicated schema, additive post-freeze; NOT a REDIRECT kind / TAG weight<0. Pre-freeze: reserve the negative-terminal concept; `kind >= 3` stays open per ADR-0050.)_

### Lists & Collections

- [ADR-0044 — LIST + LIST_ENTRY schemas for curated, shape-enforced collections](./0044-list-and-list-entry-schemas.md) _(LIST_ENTRY shape partly revised by ADR-0046; LIST `maxEntries` widened by ADR-0047)_
- [ADR-0046 — LIST_ENTRY as pure membership identity; order + label as PROPERTYs](./0046-list-entry-pure-identity-order-as-property.md)
- [ADR-0047 — Widen `LIST.maxEntries` from `uint32` to `uint256`](./0047-widen-list-maxentries-to-uint256.md)
- [ADR-0045 — EFS Edge Constraint Callbacks](./0045-efs-edge-constraint-callbacks.md) _(Deferred — wrong abstraction per round-17 external review; superseded in spirit by ADR-0044's purpose-built schema approach. Renumbered from 0043 to avoid colliding with main's editions→lenses rename.)_

### View APIs

- [ADR-0036 — Opaque-cursor pagination for multi-source views](./0036-opaque-cursor-pagination.md)
- [ADR-0051 — Reads exclude revoked (and superseded) by default; full history is opt-in](./0051-reads-exclude-revoked-by-default.md)
- [ADR-0054 — View-layer tag-exclusion directory filter](./0054-view-layer-tag-exclusion-filter.md) _(extends ADR-0042 into the view layer; kernel stays weight-neutral)_

### Frontend / Static Export

- [ADR-0040 — Read dynamic route params from `usePathname`, not `useParams`, in static-exported dynamic routes](./0040-static-export-usepathname-over-useparams.md)
- [ADR-0042 — Effective TAG as a client-layer weight filter for descriptive labels](./0042-effective-tag-weight-filter.md) _(Extended into the view layer by ADR-0054 — the same `weight >= threshold` projection is now also available on-chain via `EFSFileView.getDirectoryPageFiltered`; the kernel still never interprets weight)_
