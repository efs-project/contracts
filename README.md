# Ethereum File System Contracts

**EFS (Ethereum File System)** is an on-chain file system built on EAS attestations. Files, folders, and their placement are expressed as EAS attestations; content is retrieved via `web3://` URIs backed by SSTORE2 chunks or off-chain transports (IPFS, Arweave, HTTPS, magnet). The design goal is permanent, credibly neutral archival — anyone can publish, anyone can curate, nobody can silently revise what was published.

This repo is the contracts monorepo. The user-facing production web client is a separate repo: https://github.com/efs-project/client.

**Status:** pre-launch. Devnet target April 19, 2026. Breaking changes are acceptable while no real data exists; once mainnet deploys, contracts are permanent (no upgrade path).

**Architecture at a glance** → [`specs/overview.md`](./specs/overview.md)
**Contributor / agent workflow** → [AGENTS.md](./AGENTS.md)
**Human PR review workflow** → [docs/HUMAN_PR_WORKFLOW.md](./docs/HUMAN_PR_WORKFLOW.md)

## PR Reviews With Agents

If you want agents to review a PR or clean up PR comments, start here:

- Human-friendly guide: [docs/HUMAN_PR_WORKFLOW.md](./docs/HUMAN_PR_WORKFLOW.md)
- Deeper routing / persona details: [docs/review/review-squad.md](./docs/review/review-squad.md)

Short version:

1. Keep the PR description current, especially `Agents involved`.
2. Before asking for review, scan existing agent comments and unresolved threads.
3. Do not just say `review PR #<N>`.
4. Use the copy/paste review prompt from the human workflow doc.
5. After fixes land, use the copy/paste response prompt so threads get replied to and resolved cleanly.

## Getting Started

### 1. Install Dependencies
```bash
yarn install
```

### 2. Start Local Chain (Terminal 1)
```bash
yarn fork
```

### 3. Deploy Contracts (Terminal 2)
```bash
yarn deploy
```

> [!IMPORTANT]
> Always use the `yarn` scripts (`yarn fork`, `yarn deploy`, `yarn start`) rather than direct `npx hardhat` equivalents — the yarn scripts handle environment variables and workspace resolution correctly.
>
> Running a single contract test file is the one documented exception — see AGENTS.md for the pattern.

### 4. Optional: Start Internal Debug UI (Terminal 3)
For debugging and easily using the contracts:
```bash
yarn start
```



---

## About Scaffold-ETH 2
This project uses [Scaffold-ETH 2](https://scaffoldeth.io) as a base.
- [Documentation](https://docs.scaffoldeth.io)
- [Website](https://scaffoldeth.io)
