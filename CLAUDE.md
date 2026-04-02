# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EFS (Ethereum File System) is an on-chain file system built on EAS (Ethereum Attestation Service) attestations. It uses Scaffold-ETH 2 as a base framework. The system stores files/folders as on-chain attestations and serves them via `web3://` URIs.

## Development Setup

**IMPORTANT: Always use `yarn fork` (not `npx hardhat node`) and `yarn deploy` (not `npx hardhat deploy`).** The yarn scripts handle environment variables and workspace resolution correctly.

Three terminals required:

```bash
# Terminal 1: Start local Sepolia fork
yarn fork

# Terminal 2: Deploy contracts
yarn deploy

# Terminal 3: Start frontend
yarn start
```

After starting the frontend, click the **cash/faucet icon** (top right) to fund the burner wallet with test ETH — attestations require gas.

## Key Commands

```bash
# From repo root
yarn fork              # Start local Sepolia fork (required — not plain hardhat node)
yarn deploy            # Deploy all contracts to localhost
yarn start             # Start Next.js dev server (http://localhost:3000)
yarn test              # Run Hardhat contract tests
yarn compile           # Compile contracts
yarn lint              # Lint both packages
yarn format            # Format both packages

# Hardhat package directly
yarn hardhat:test      # Run contract tests with gas reporting
yarn hardhat:simulate  # Run simulate-file-browser.ts script against localhost

# Next.js package directly
yarn next:build        # Production build
yarn next:check-types  # TypeScript check
```

**Run a single hardhat test file:**
```bash
cd packages/hardhat && npx hardhat test test/EFSIndexer.test.ts --network hardhat
```

## Architecture

### Monorepo Structure
- `packages/hardhat/` — Solidity contracts + deploy scripts
- `packages/nextjs/` — Next.js frontend (App Router)
- `reference/` — EAS docs, Scaffold-ETH docs, EIP specs (4804, 6860, 5219, 6944, 7617, 6821, 7618, 7774)

### EFS Data Model

Six EAS schema types:

| Schema | Fields | Resolver | Purpose |
|--------|--------|----------|---------|
| `ANCHOR` | `string name, bytes32 schemaUID` | EFSIndexer | Folders (permanent, non-revocable) |
| `DATA` | `string uri, string contentType, string fileMode` | EFSIndexer | Files (uri = `web3://...` pointing to SSTORE2 chunks) |
| `PROPERTY` | `string value` | EFSIndexer | Key-value metadata attached to anchors |
| `TAG` | `bytes32 definition, bool applies` | TagResolver | Labels/tags (singleton per attester+target+definition) |
| `LIST_INFO` | `uint8 listType, bytes32 targetSchemaUID` | EFSListManager | List root configuration (refUID → EFS Anchor as naming Schelling point) |
| `LIST_ITEM` | `bytes32 itemUID, string fractionalIndex, bytes32 tags` | EFSListManager | Individual list entry (refUID → LIST_INFO) |

Files are stored via SSTORE2 chunking: content is split into 24KB chunks deployed as raw bytecode contracts, then a chunk manager contract is deployed and attested as a `DATA` attestation with a `web3://` URI.

### Smart Contracts (deployed to Sepolia fork)

- **`Indexer` (EFSIndexer)** — Core contract. Manages schemas, resolver hooks, path resolution (`resolvePath`, `rootAnchorUID`), and directory pagination (`getDirectoryPage`, `getDirectoryPageByAddressList`).
- **`EFSRouter`** — Implements `IDecentralizedApp` for `web3://` URI resolution (ERC-5219 mode). Takes path segments and returns file content.
- **`EFSFileView`** — Renders directory listings as HTML for browser access.
- **`TagResolver`** — Singleton tagging pattern: one active tag per (attester, target, definition).
- **`EFSListManager`** — Per-attester doubly linked lists for LIST_INFO/LIST_ITEM schemas. `getSortedChunk(listInfoUID, attester, startNode, limit)` for O(1) cursor-based pagination.
- Deploy scripts: `01_indexer.ts` → `02_fileview.ts` → `03_router.ts` → `04_listmanager.ts`

EAS contracts (Sepolia addresses used in fork):
- EAS: `0xC2679fBD37d54388Ce493F1DB75320D236e1815e`
- SchemaRegistry: `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`

### Frontend Architecture

**Pages** (`packages/nextjs/app/`):
- `/` — Landing page
- `/explorer/[[...path]]` — Main file browser (URL path maps to EFS anchor path)
- `/debug/schemas` — Schema debug/testing UI
- `/easexplorer` — EAS attestation explorer
- `/blockexplorer` — Block/transaction explorer

**Explorer data flow:**
1. `explorer/[[...path]]/page.tsx` resolves the URL path → anchor UID via `Indexer.resolvePath()`, manages `editionAddresses` (the attester filter)
2. `TopicTree.tsx` renders the folder sidebar using `getDirectoryPage`
3. `FileBrowser.tsx` renders directory contents — uses `getDirectoryPage` (all files) or `getDirectoryPageByAddressList` (filtered by attester addresses)
4. `Toolbar.tsx` handles file upload (SSTORE2 chunking + DATA attestation) and folder creation (ANCHOR attestation)

**Editions system** (`?editions=` query param):
- Empty / no param → show only files from connected wallet (`[connectedAddress]`)
- `?editions=0xABC,vitalik.eth` → show files from those addresses (ENS names resolved async via `publicClient.getEnsAddress`)
- `editionAddresses` is derived synchronously via `useMemo` to prevent flash of unfiltered data on account switch
- `lockedToEditions` ref in `FileBrowser` prevents reverting to standard query during transient empty states

**Key hooks** (`packages/nextjs/hooks/scaffold-eth/`):
- `useScaffoldReadContract` — reads from deployed contracts by name (resolves address from `deployedContracts.ts`)
- `useScaffoldWriteContract` — writes to deployed contracts
- `useDeployedContractInfo` — gets ABI + address for a contract name
- `useTargetNetwork` — returns the configured chain from `scaffold.config.ts`

**`getDirectoryPageByAddressList` signature** (important — only 4 args):
```ts
getDirectoryPageByAddressList(parentAnchor: bytes32, attesters: address[], startingCursor: uint256, pageSize: uint256)
```
Do NOT pass `dataSchemaUID` or `propertySchemaUID` — those are only on `getDirectoryPage`.

### Dev Wallet Switcher

`DevWalletSwitcher.tsx` (shown only on hardhat network) switches between the 20 deterministic Hardhat accounts. It uses wagmi's `useDisconnect`/`useConnect` with the `burnerWallet` connector — **no page reload**. The burner connector re-reads `localStorage["burnerWallet.pk"]` on each `connect()` call via `loadBurnerPK()`.

### Contract ABI Updates

After changing contracts and redeploying, regenerate the TypeScript ABIs:
```bash
yarn deploy  # auto-runs generateTsAbis script
```
Generated ABIs land in `packages/nextjs/contracts/deployedContracts.ts`.
