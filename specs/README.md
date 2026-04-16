# Specs

Authoritative description of how EFS works today. If specs and code disagree, that's a Tier 2 issue (see `docs/agent-workflow.md`) — surface it; don't guess which is right.

## Index

- **`01-System-Architecture.md`** — high-level vision, kernel/overlay model, the three-layer separation. Read first when orienting on EFS conceptually.
- **`02-Data-Models-and-Schemas.md`** — the six EAS schemas (ANCHOR, DATA, MIRROR, TAG, PROPERTY, SORT_INFO), their fields, resolvers, and how they relate. Required reading for any contract work.
- **`03-Onchain-Indexing-Strategy.md`** — how EFSIndexer maintains lookup indices, the append-only kernel pattern, edition filtering. Read before modifying any index in EFSIndexer or TagResolver.
- **`04-Core-Workflows.md`** — step-by-step execution for common operations (upload a file, browse a directory, etc.). Useful for understanding the full chain of attestations behind any user action.
- **`05-Extensibility-and-Web-UI.md`** — how EFS is meant to be extended; conventions for client interfaces. Read when designing new contracts that integrate with EFS or new client patterns.
- **`06-Lists-and-Collections.md`** — how curated lists, social graphs, and ranked collections compose on top of the kernel + sort overlay. Read for sort-related or list-related work.
- **`07-Sort-Overlay-Architecture.md`** — EFSSortOverlay design: per-parent linked lists, `processItems`, `computeHints`, `ISortFunc` comparators. Required for sort overlay work.
- **`08-Custom-Lists-Design-Notes.md`** — design notes on the distinction between sorts and curated lists. Read for context on list design choices.

## When to update

When code changes alter system behavior visible to consumers (contracts, client UIs, off-chain indexers), update the relevant spec **in the same PR**. Specs lagging behind code is the most common failure mode of this kind of doc.
