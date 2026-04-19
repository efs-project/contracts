# AGENTS.md

EFS — Ethereum File System. On-chain file system built on EAS attestations. Pre-launch, devnet target April 19, 2026. Breaking changes are acceptable for now as there's no real data created yet. Good design and future proofing is key.

**Production web client** (Vite/Lit, separate repo): https://github.com/efs-project/client. The internal UI at `packages/nextjs/` in this repo is a Scaffold-ETH-based devtools/debug interface — not the production client. Don't apply Scaffold-ETH patterns (`useScaffoldReadContract` etc.) to the production client.

## Read on init

**If your tool does not auto-load `@`-imported files (non-Claude-Code agents: Codex CLI, Cursor, Gemini, GitHub Actions agents, etc.), you MUST read all of these before starting any task:**

- **[docs/agent-workflow.md](./docs/agent-workflow.md)** — escalation tiers, decision logging, asking-the-human protocol. **Required before any task.**
- **[specs/overview.md](./specs/overview.md)** — architecture at a glance.
- **[docs/QUESTIONS.md](./docs/QUESTIONS.md)** — open items needing the human's input. Check before working in any area.

(Claude Code auto-loads the above via `CLAUDE.md`'s `@` imports.)

## Read as needed

- **[specs/README.md](./specs/README.md)** — index of detailed specs (authoritative current behavior)
- **[docs/adr/](./docs/adr/)** — past decisions and reasoning
- **[docs/FUTURE_WORK.md](./docs/FUTURE_WORK.md)** — backlog
- **[docs/LAUNCH_CHECKLIST.md](./docs/LAUNCH_CHECKLIST.md)** — pre-launch blockers
- **[reference/README.md](./reference/README.md)** — EAS, EIP, Scaffold-ETH docs (indexed by task)

## Change-type → required reads

If your task fits one of these categories, load the listed ADRs *before* writing code. Most Tier 1 mistakes come from missing the right governing decision.

| Change type | Required reads |
|---|---|
| Schema field change (ANCHOR, DATA, MIRROR, TAG, PROPERTY, SORT_INFO) | ADR-0005, ADR-0030, ADR-0032, `specs/02-Data-Models-and-Schemas.md` |
| New transport type or priority change | ADR-0011, ADR-0012, ADR-0023, `specs/02` §Mirror |
| Kernel index / indexing logic (EFSIndexer) | ADR-0007, ADR-0008, ADR-0009, ADR-0010, ADR-0021, `specs/03-Onchain-Indexing-Strategy.md` |
| Editions / router resolution | ADR-0013, ADR-0014, ADR-0016, ADR-0017, ADR-0020, ADR-0031, ADR-0033, `specs/04-Core-Workflows.md` |
| Root URL classification / schema alias anchors | ADR-0033, ADR-0019, ADR-0025 |
| Display-name / address-label rendering | ADR-0014, ADR-0034, `specs/02` §Property |
| Security limits (MAX_*) | ADR-0021 through ADR-0026 |
| Deploy / wiring / contract addresses | ADR-0027, ADR-0028, ADR-0030 |
| Sort overlay | ADR-0011 (transports pattern analog), `specs/07-Sort-Overlay-Architecture.md` |
| Licensing / legal | ADR-0029 |

## Setup

**One-command path (preferred — also what Claude Code's "Preview" button runs):**

```bash
yarn preview   # fork + deploy + next dev, with auto-port selection
```

This launches the hardhat Sepolia fork, deploys contracts, then starts Next.js dev,
all wired together. If `8545` or `3000` are busy (another worktree / preview
already running), it scans upward and picks free ports automatically and passes
them through as `LOCALHOST_RPC_URL` / `NEXT_PUBLIC_HARDHAT_RPC_URL`. The hardhat
fork is a child process and is torn down when `next dev` exits.

**Three-terminal path (when you want each piece under separate control):**

```bash
yarn fork     # Terminal 1 — local Sepolia fork (required, not plain hardhat node)
yarn deploy   # Terminal 2 — deploy contracts (handles workspace + env)
yarn start    # Terminal 3 — Next.js debug UI at http://localhost:3000
```

Click the cash/faucet icon (top right of UI) to fund the burner wallet — attestations need gas.

### Running alongside another project (parallel agents / worktrees)

The default ports are `8545` (hardhat RPC) and `3000` (Next.js). When another agent or
worktree is already bound to them, pick free ports and wire them through two env vars.
**Nothing else changes** — yarn forwards trailing args to the underlying scripts, so
`--port` / `-p` flags flow through unchanged.

```bash
# Terminal 1 — second hardhat node on 8546
yarn fork --port 8546

# Terminal 2 — deploy against it
#   LOCALHOST_RPC_URL retargets hardhat's `localhost` network (deploy/simulate/seed)
LOCALHOST_RPC_URL=http://127.0.0.1:8546 yarn deploy

# Terminal 3 — Next.js on 3001, pointed at the same node
#   NEXT_PUBLIC_HARDHAT_RPC_URL retargets wagmi's hardhat transport
NEXT_PUBLIC_HARDHAT_RPC_URL=http://127.0.0.1:8546 yarn start -p 3001
```

Or (preferred for long-running agents) set them once in `packages/hardhat/.env` and
`packages/nextjs/.env.local` — templates in the matching `.env.example` files. Leaving
the vars unset keeps the original `127.0.0.1:8545` / `:3000` behavior.

The two vars are **independent**: `LOCALHOST_RPC_URL` governs hardhat CLI (`yarn deploy`,
`yarn simulate*`, `yarn seed`); `NEXT_PUBLIC_HARDHAT_RPC_URL` governs the in-browser
wagmi client. Set both to the same URL when running end-to-end.

**Smoke test**: navigate to `http://localhost:3000/debug/schemas`, submit a test TAG attestation via the Tag Schema form, and confirm it appears in the Attestation Viewer below. This verifies EAS is reachable, schemas are registered, and the resolver chain is wired correctly.

### Seeding demo data (devnet + local first-run)

`yarn deploy` now chains `yarn hardhat:seed` at the end, so a fresh deploy
populates a small demo tree (`/docs/`, `/images/`, `/shared/`) with an editions
demo on `shared/photo.png` automatically. The seed script is **idempotent** —
each top-level subtree is guarded by a `resolveAnchor` call, so re-running after
a partial failure only fills in what's missing, and re-running after a successful
seed is a zero-write no-op. It is also **fail-soft**: if the Indexer contract
isn't registered (e.g. CI deploy against a vanilla hardhat node with no EAS),
seed logs a skip and exits 0 rather than failing the chain.

Run seed by itself (e.g. after manual contract deployment or to re-seed after a
data wipe) with `yarn hardhat:seed`.

### Pinned Sepolia fork (coordination unit for devnet / client)

The hardhat network forks Sepolia at a **pinned block** (see `packages/hardhat/hardhat.config.ts` → `networks.hardhat.forking.blockNumber`; default set via `FORK_BLOCK`). This makes contract addresses, EAS schema UIDs, and `packages/nextjs/contracts/deployedContracts.ts` byte-identical across every environment that runs this commit — local hardhat, CI, the devnet VPS, the statically hosted Vite client. See ADR-0037.

**Invariant**: `packages/nextjs/contracts/deployedContracts.ts` is committed and is the contract-address source of truth. It's regenerated by `yarn deploy` against the pinned fork. If you bump `FORK_BLOCK`, regenerate and commit `deployedContracts.ts` in the same commit. The commit SHA is the cross-environment coordination unit.

## Commands

```bash
yarn hardhat:test           # contract tests
yarn hardhat:simulate       # run simulate-file-browser.ts against localhost
yarn hardhat:seed           # idempotent demo tree (/docs /images /shared)
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
