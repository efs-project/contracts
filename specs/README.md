# Specs

Authoritative description of how EFS works today. If specs and code disagree, that's a Tier 2 issue (see `docs/agent-workflow.md`) — surface it; don't guess which is right.

## Index

- **`overview.md`** — **EFS at a glance.** One-screen canonical reference: three-layer model, nine schemas, core contracts, load-bearing invariants. Start here for any non-trivial task. Auto-loaded at session start.
- **`01-System-Architecture.md`** — high-level vision, kernel/overlay model, the three-layer separation. Read first when orienting on EFS conceptually.
- **`02-Data-Models-and-Schemas.md`** — the EAS schemas (ANCHOR, DATA, MIRROR, PIN, TAG, PROPERTY, LIST, LIST_ENTRY, REDIRECT — plus SORT_INFO, which is deferred / not in the Sepolia freeze set), their fields, resolvers, and how they relate. Required reading for any contract work.
- **`03-Onchain-Indexing-Strategy.md`** — how EFSIndexer maintains lookup indices, the append-only kernel pattern, lens filtering. Read before modifying any index in EFSIndexer or EdgeResolver.
- **`04-Core-Workflows.md`** — step-by-step execution for common operations (upload a file, browse a directory, etc.). Useful for understanding the full chain of attestations behind any user action.
- **`05-Extensibility-and-Web-UI.md`** — how EFS is meant to be extended; conventions for client interfaces. Read when designing new contracts that integrate with EFS or new client patterns.
- **`06-Lists-and-Collections.md`** — the `LIST` + `LIST_ENTRY` curated-collection primitive (ADR-0044, ADR-0046): write-time shape enforcement, per-attester lenses, order/label as PIN-bound PROPERTYs. Authoritative for list-related work.
- **`07-Sort-Overlay-Architecture.md`** — EFSSortOverlay design: per-parent linked lists, `processItems`, `computeHints`, `ISortFunc` comparators. Required for sort overlay work.
- **`08-Custom-Lists-Design-Notes.md`** — **historical design notes** (pre-ADR-0044/0046) exploring the rejected positional-anchor list model. Superseded by the `LIST`/`LIST_ENTRY` primitive in `06`; retained for the sorts-vs-curation reasoning only. Not the implemented model.
- **`09-redirect-resolution.md`** — REDIRECT read-time resolution (ADR-0050/0059): symlink-only following (supersededBy is a non-followed terminal; path=newest/UID=exact), the D_MAX hop cap, cycle-stop, lens precedence, the dangling contract, the WHITEOUT negative-terminal reservation, the reference follower algorithm, and conformance vectors. **Accepted** — gates durable REDIRECT seeding.
- **`10-file-metadata-encoding.md`** — canonical string format for the reserved-key file-stat PROPERTYs (`contentHash`, `size`, `cid`): multibase-multihash (sha2-256 canonical, sharing the IPFS CID digest) + CID, the closed reserved-key registry, verification semantics, and conformance vectors (ADR-0049/0060). **Accepted** — gates durable file-metadata seeding.

When code changes alter system behavior visible to consumers (contracts, client UIs, off-chain indexers), update the relevant spec **in the same PR**. Specs lagging behind code is the most common failure mode of this kind of doc.
