# Ethereum File System Contracts

**EFS (Ethereum File System)** is an on-chain file system built on EAS attestations. Files, folders, and their placement are expressed as EAS attestations; content is retrieved via `web3://` URIs backed by SSTORE2 chunks or off-chain transports (IPFS, Arweave, HTTPS, magnet). The design goal is permanent, credibly neutral archival — anyone can publish, anyone can curate, nobody can silently revise what was published.

This repo is the contracts monorepo. The user-facing production web client is a separate repo: https://github.com/efs-project/client.

**Status:** pre-launch. Devnet target April 19, 2026. Breaking changes are acceptable while no real data exists; once mainnet deploys, contracts are permanent (no upgrade path).

**Architecture at a glance** → [`specs/overview.md`](./specs/overview.md)
**Contributor / agent workflow** → [AGENTS.md](./AGENTS.md)

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

### 4. Optional: Start Scaffold UI (Terminal 3)
For debugging and easily using the contracts:
```bash
yarn start
```

### 5. Optional: Seed The User-Browsing Demo Corpus
To populate the James Carnley address container (`0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199`) with the curated demo files under [`reference/devnet-sample-media/`](./reference/devnet-sample-media/README.md), run:

```bash
cd packages/hardhat
npx hardhat deploy --tags UserBrowsingDemo --network localhost
```

This step is intentionally separate from `yarn deploy` so normal local deploys stay fast. It is idempotent: files already seeded for that address are skipped.



---

## About Scaffold-ETH 2
This project uses [Scaffold-ETH 2](https://scaffoldeth.io) as a base.
- [Documentation](https://docs.scaffoldeth.io)
- [Website](https://scaffoldeth.io)
