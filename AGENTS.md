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
| Editions / router resolution | ADR-0013, ADR-0014, ADR-0016, ADR-0017, ADR-0020, ADR-0031, `specs/04-Core-Workflows.md` |
| Security limits (MAX_*) | ADR-0021 through ADR-0026 |
| Deploy / wiring / contract addresses | ADR-0027, ADR-0028, ADR-0030 |
| Sort overlay | ADR-0011 (transports pattern analog), `specs/07-Sort-Overlay-Architecture.md` |
| Licensing / legal | ADR-0029 |

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
