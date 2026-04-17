# AGENTS.md

EFS — Ethereum File System. On-chain file system built on EAS attestations. Pre-launch, devnet target April 19, 2026. Breaking changes are acceptable for now as there's no real data created yet. Good design and future proofing is key.

## System at a glance

**Three layers, linked by TAG:** Anchors (paths) → DATA (content identity, content-hashed) → MIRRORs (retrieval URIs). TAG attestations place DATA at paths. Content addressability and multi-attester "editions" fall out of this separation.

**Six EAS schemas** (see [specs/02-Data-Models-and-Schemas.md](./specs/02-Data-Models-and-Schemas.md) for fields):
ANCHOR, DATA, MIRROR, TAG, PROPERTY, SORT_INFO.

**Core contracts:**

| Contract | Role | State? | Redeployable? |
|---|---|---|---|
| `EFSIndexer` | Append-only kernel. All indices, path resolution, revocation tracking. | Yes (heavy) | No — schema UIDs encode its address |
| `EFSRouter` | `web3://` URI resolution (ERC-5219). Edition-scoped content serving. | No | Yes (URIs change) |
| `EFSFileView` | Directory listing views over EFSIndexer. | No | Yes — fully stateless |
| `TagResolver` | TAG schema hook. Singleton placement via `_activeByAAS`. | Yes | No — wired into EFSIndexer |
| `MirrorResolver` | MIRROR schema hook. URI allowlist + transport ancestry check. | Minimal | No — wired into EFSIndexer |
| `EFSSortOverlay` | Per-parent sorted linked lists. Overlay on EFSIndexer. | Yes | No — wired into EFSIndexer |

**Load-bearing invariants** (violating these is expensive):
- **Append-only indices** (ADR-0009) — never compact, never mutate existing entries.
- **Schema UIDs are immutable** — they hash the field string; any field change creates a new schema and new UID.
- **Edition-scoped reads** (ADR-0013, ADR-0014) — mirrors and PROPERTYs on DATA are scoped to the edition attester at read time; cross-attester injection is blocked by design.
- **Mainnet contracts are permanent** (ADR-0030) — no upgrades, no admin overrides, no migrations. Devnet is upgradeable; mainnet is not.

## Read on init

- **[docs/agent-workflow.md](./docs/agent-workflow.md)** — escalation tiers, decision logging, asking-the-human protocol. **Required before any task.**

## Read as needed

- **[specs/README.md](./specs/README.md)** — current system behavior (authoritative; indexed)
- **[docs/adr/](./docs/adr/)** — past decisions and reasoning
- **[docs/QUESTIONS.md](./docs/QUESTIONS.md)** — open items needing the human's input (check before working in any area)
- **[docs/FUTURE_WORK.md](./docs/FUTURE_WORK.md)** — backlog
- **[docs/LAUNCH_CHECKLIST.md](./docs/LAUNCH_CHECKLIST.md)** — pre-launch blockers
- **[reference/README.md](./reference/README.md)** — EAS, EIP, Scaffold-ETH docs (indexed by task)
- **[docs/external-repos.md](./docs/external-repos.md)** — production EFS Client and other repos outside this monorepo

## Setup

```bash
yarn fork     # Terminal 1 — local Sepolia fork (required, not plain hardhat node)
yarn deploy   # Terminal 2 — deploy contracts (handles workspace + env)
yarn start    # Terminal 3 — Next.js debug UI at http://localhost:3000
```

Click the cash/faucet icon (top right of UI) to fund the burner wallet — attestations need gas.

**Smoke test**: navigate to `http://localhost:3000/debug/schemas`, submit a test TAG attestation via the Tag Schema form, and confirm it appears in the Attestation Viewer below. This verifies EAS is reachable, schemas are registered, and the resolver chain is wired correctly.

## Commands

```bash
yarn hardhat:test           # contract tests
yarn hardhat:simulate       # run simulate-file-browser.ts against localhost
yarn next:check-types       # TypeScript check
yarn lint && yarn format    # both packages
```

Single test file:
```bash
cd packages/hardhat && npx hardhat test test/EFSIndexer.test.ts --network hardhat
```

## Critical

- **Specs are authoritative.** If specs and code disagree, surface it (likely Tier 2). Don't guess which is right.
- **ADRs are immutable once Accepted.** Don't edit historical ones. Supersede instead.

---

*Claude Code: see CLAUDE.md (pointer to this file).*
