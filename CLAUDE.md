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
yarn hardhat:test           # Run contract tests with gas reporting
yarn hardhat:simulate       # Run simulate-file-browser.ts script against localhost
yarn hardhat:simulate:sort  # Run simulate-sort-overlay.ts script against localhost

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

Five EAS schema types:

| Schema | Fields | Resolver | Purpose |
|--------|--------|----------|---------|
| `ANCHOR` | `string name, bytes32 schemaUID` | EFSIndexer | Folders/positions (permanent, non-revocable). `schemaUID` differentiates file anchors, sort anchors, etc. |
| `DATA` | `string uri, string contentType, string fileMode` | EFSIndexer | File content (uri = `web3://...` pointing to SSTORE2 chunks) |
| `PROPERTY` | `string key, string value` | EFSIndexer | Key-value metadata attached to anchors |
| `TAG` | `bytes32 definition, bool applies` | TagResolver | Labels/tags (singleton per attester+target+definition) |
| `SORT_INFO` | `address sortFunc, bytes32 targetSchema` | EFSSortOverlay | Sort overlay declaration. `refUID` → naming Anchor (child of directory being sorted). `sortFunc` implements `ISortFunc`. |

Files are stored via SSTORE2 chunking: content is split into 24KB chunks deployed as raw bytecode contracts, then a chunk manager contract is deployed and attested as a `DATA` attestation with a `web3://` URI.

**Kernel/overlay architecture**: EFSIndexer is the append-only kernel — revocations set `_isRevoked[uid]` but never remove from arrays. EFSSortOverlay maintains per-attester sorted linked lists over kernel arrays, populated lazily via `processItems` calls validated by pluggable `ISortFunc` comparators.

**Curated lists** use positional Anchors: create a directory of child Anchors (named "a0", "a1", etc.), attach a SORT_INFO child with `sortFunc = FractionalSort`, and set a `defaultSort` PROPERTY. Each position Anchor can have per-attester DATA — enabling Editions-style overrides per position.

### Smart Contracts (deployed to Sepolia fork)

- **`Indexer` (EFSIndexer)** — Core kernel. Manages schemas, resolver hooks, path resolution (`resolvePath`, `rootAnchorUID`), directory pagination, and revocation tracking (`isRevoked`). Read functions include `showRevoked` param for filtering. Public index API: `index(uid)`, `indexBatch(uids)`, `indexRevocation(uid)`, `isIndexed(uid)` — allows any EAS attestation from an external resolver to opt into EFSIndexer's discovery layer. Partner contract addresses and schema UIDs are set once after full deployment via `wireContracts()` (deployer-only, one-time) and queryable as public state: `TAG_SCHEMA_UID`, `SORT_INFO_SCHEMA_UID`, `tagResolver`, `sortOverlay`, `schemaRegistry` — single entry point for all schema/contract discovery. Emits `AnchorCreated`, `DataCreated`, `PropertyCreated`, `AttestationRevoked` events from native schema hooks — enables efficient off-chain indexing (The Graph) without scanning all EAS events. `getChildrenByAttesterAt(parentUID, attester, idx)` exposes single-element kernel array access by physical index. `getAnchorsBySchemaAndAddressList(parentUID, anchorSchema, attesters, startCursor, pageSize, reverseOrder, showRevoked)` — schema + attester filtered pagination: intersects `_childrenBySchema[anchorSchema]` with `_containsAttestations` per attester — use to fetch only file Anchors (DATA_SCHEMA), only sort Anchors (SORT_INFO_SCHEMA), etc. from a multi-attester directory without mixing unrelated anchor types.
- **`EFSRouter`** — Implements `IDecentralizedApp` for `web3://` URI resolution (ERC-5219 mode). Takes path segments and returns file content.
- **`EFSFileView`** — Enriched directory listing views over EFSIndexer. `getDirectoryPage` (simple), `getDirectoryPageByAddressList` (attester-filtered), and `getDirectoryPageBySchemaAndAddressList(parentAnchor, anchorSchema, attesters, startingCursor, pageSize)` (schema + attester filtered — use this to fetch only file Anchors, only sort Anchors, etc. without mixing types). Returns `FileSystemItem[]` structs with metadata resolved from EAS.
- **`TagResolver`** — Singleton tagging pattern: one active tag per (attester, target, definition). Wired to EFSIndexer: `onAttest` calls `indexer.index(uid)` and `onRevoke` calls `indexer.indexRevocation(uid)` — TAG attestations are discoverable via EFSIndexer's generic indices (`getReferencingAttestations`, `getOutgoingAttestations`, etc.) just like any other schema.
- **`EFSSortOverlay`** — Per-attester sorted linked lists for SORT_INFO schemas. `processItems(sortInfoUID, items, leftHints, rightHints)` lazily processes kernel items — validates each item against the kernel via `getChildrenByAttesterAt` before inserting (integrity guarantee: callers cannot inject arbitrary UIDs). `getSortedChunk(sortInfoUID, attester, startNode, limit)` for cursor-based pagination. `getSortStaleness(sortInfoUID, attester)` shows unprocessed count. `computeHints(sortInfoUID, attester, newItems)` is a view function (free `eth_call`) that computes correct `leftHints`/`rightHints` using binary search — no client-side sort logic needed. `SortConfig` caches `parentUID` at attest time (no EAS call chain needed at read time). Calls `indexer.index()` and `indexer.indexRevocation()` from its resolver hooks so SORT_INFO attestations are fully discoverable on-chain via `getReferencingAttestations`.
- **`AlphabeticalSort`** / **`TimestampSort`** — Reference `ISortFunc` implementations.
- Deploy scripts: `01_indexer.ts` → `02_fileview.ts` → `03_router.ts` → `04_sortoverlay.ts`

EAS contracts (Sepolia addresses used in fork):
- EAS: `0xC2679fBD37d54388Ce493F1DB75320D236e1815e`
- SchemaRegistry: `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`

### Internal DevTools Architecture

> **Note:** These pages apply only to the Scaffold-ETH internal debugging UI (`packages/nextjs`). The true **EFS Client UI** (Vite/Lit) lives in a completely separate external repository.

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

**`EFSFileView` API signatures** (important — arg counts vary per function):
```ts
// All children, insertion order (basic paging)
getDirectoryPage(parentAnchor, start, length, dataSchemaUID, propertySchemaUID)

// All children filtered by attester set (4 args — no schema UIDs)
getDirectoryPageByAddressList(parentAnchor, attesters, startingCursor, pageSize)

// Children of a specific anchorSchema filtered by attester set (5 args)
getDirectoryPageBySchemaAndAddressList(parentAnchor, anchorSchema, attesters, startingCursor, pageSize)
```
`getDirectoryPage` is the only variant that takes `dataSchemaUID`/`propertySchemaUID` explicitly — the others read them from the indexer. Use `getDirectoryPageBySchemaAndAddressList` to fetch only file Anchors, only sort Anchors, etc.

### Dev Wallet Switcher

`DevWalletSwitcher.tsx` (shown only on hardhat network) switches between the 20 deterministic Hardhat accounts. It uses wagmi's `useDisconnect`/`useConnect` with the `burnerWallet` connector — **no page reload**. The burner connector re-reads `localStorage["burnerWallet.pk"]` on each `connect()` call via `loadBurnerPK()`.

### Contract ABI Updates

After changing contracts and redeploying, regenerate the TypeScript ABIs:
```bash
yarn deploy  # auto-runs generateTsAbis script
```
Generated ABIs land in `packages/nextjs/contracts/deployedContracts.ts`.
