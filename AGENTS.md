# AGENTS.md

EFS — Ethereum File System. On-chain file system built on EAS attestations. Pre-launch, devnet target April 19, 2026. Breaking changes are acceptable for now as there's no real data created yet. Good design and future proofing is key.

**Production web client** (Vite/Lit, separate repo): https://github.com/efs-project/client. The internal UI at `packages/nextjs/` in this repo is a Scaffold-ETH-based devtools/debug interface — not the production client. Don't apply Scaffold-ETH patterns (`useScaffoldReadContract` etc.) to the production client.

## Read on init

- **[docs/agent-workflow.md](./docs/agent-workflow.md)** — escalation tiers, decision logging, asking-the-human protocol. **Required before any task.**

## Read as needed

- **[specs/overview.md](./specs/overview.md)** — architecture at a glance (read for any non-trivial task)
- **[specs/README.md](./specs/README.md)** — index of detailed specs (authoritative current behavior)
- **[docs/adr/](./docs/adr/)** — past decisions and reasoning
- **[docs/QUESTIONS.md](./docs/QUESTIONS.md)** — open items needing the human's input (check before working in any area)
- **[docs/FUTURE_WORK.md](./docs/FUTURE_WORK.md)** — backlog
- **[docs/LAUNCH_CHECKLIST.md](./docs/LAUNCH_CHECKLIST.md)** — pre-launch blockers
- **[reference/README.md](./reference/README.md)** — EAS, EIP, Scaffold-ETH docs (indexed by task)

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
