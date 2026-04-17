# EFS at a glance

One-screen summary of current architecture. This is the **canonical quick reference**: if code changes any of this, update here in the same PR.

For depth, see the numbered specs. For historical reasoning (why we chose X over Y), see `docs/adr/`.

## Three-layer model

**Anchors** (paths) → **DATA** (content identity, content-hashed) → **MIRRORs** (retrieval URIs)

**TAG** attestations place DATA at paths. Content-addressed dedup and multi-attester "editions" fall out of this separation.

## Six EAS schemas

| Schema | Revocable | Purpose |
|---|---|---|
| ANCHOR | no | Paths. Hierarchical (refUID = parent). |
| DATA | no | Content identity (contentHash + size). Standalone (refUID = 0x0). |
| MIRROR | yes | Retrieval URI for a DATA. |
| TAG | yes | Places a DATA at a path. Singleton per (attester, target, definition). |
| PROPERTY | yes | Key/value metadata on any attestation. |
| SORT_INFO | yes | Sort overlay declaration. |

Full fields and resolver wiring: `02-Data-Models-and-Schemas.md`.

## Core contracts

| Contract | Role | State | Redeployable |
|---|---|---|---|
| EFSIndexer | Append-only kernel. All indices, path resolution, revocation tracking. | Yes (heavy) | No — schema UIDs encode its address |
| EFSRouter | `web3://` URI resolution (ERC-5219). Edition-scoped content serving. | No | Yes (URIs change) |
| EFSFileView | Directory listing views over EFSIndexer. | No | Yes — fully stateless |
| TagResolver | TAG schema hook. Singleton placement via `_activeByAAS`. | Yes | No — wired into EFSIndexer |
| MirrorResolver | MIRROR schema hook. URI allowlist + transport ancestry. | Minimal | No — wired into EFSIndexer |
| EFSSortOverlay | Per-parent sorted linked lists. Overlay on EFSIndexer. | Yes | No — wired into EFSIndexer |

"Not redeployable" means its address is baked into schema UIDs. Replacing it breaks every attestation under those schemas.

## Load-bearing invariants

Breaking these is painful or impossible to reverse:

- **Append-only indices** (`03-Onchain-Indexing-Strategy.md`). Revocation sets a flag; never mutate or compact existing entries.
- **Schema UIDs are immutable.** The UID hashes the field string; any field change produces a new schema.
- **Edition-scoped reads.** Mirrors and PROPERTYs on DATA are filtered to the edition attester at read time — cross-attester injection is blocked by design.
- **Mainnet contracts are permanent.** No upgrades, no admin override, no migrations. Devnet is upgradeable; mainnet is not.

## Where to go next

- **"How does X actually work?"** → the corresponding numbered spec (see this directory's README).
- **"Why was X chosen over Y?"** → `docs/adr/` (immutable reasoning snapshots).
- **"What decisions are currently blocked on the human?"** → `docs/QUESTIONS.md`.
