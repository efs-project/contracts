# CLAUDE.md

Project conventions and architecture overview for Claude Code working in this repository.

> **All agents (Claude, Codex, Cursor, Gemini, etc.):** start with `AGENTS.md`. It defines the cross-tool workflow, escalation rules, and discovery order. This file (`CLAUDE.md`) is loaded by Claude Code automatically and contains the project-specific orientation.

## Project Overview

EFS (Ethereum File System) is an on-chain file system built on EAS (Ethereum Attestation Service) attestations. It uses Scaffold-ETH 2 as a base framework. The system stores files/folders as on-chain attestations and serves them via `web3://` URIs.

The data model is **three-layer**: Anchors (paths) → DATA (content identity) → MIRRORs (retrieval URIs), connected by TAGs. See `docs/adr/0001-three-layer-data-model.md` for the full reasoning.

## Documentation map

- **`AGENTS.md`** — workflow rules for AI agents (escalation tiers, discovery order, decision logging)
- **`docs/specs/`** — current system behavior (authoritative for "how does X work today?")
- **`docs/adr/`** — architectural decisions and reasoning (immutable; see `docs/adr/README.md`)
- **`docs/QUESTIONS.md`** — open items needing James's input
- **`docs/FUTURE_WORK.md`** — known backlog (post-launch and beyond)
- **`docs/LAUNCH_CHECKLIST.md`** — pre-launch blockers
- **`docs/decisions.md`** — informal dated log of small decisions made by agents
- **`reference/`** — external specs (EAS, EIPs, Scaffold-ETH)

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
- `packages/nextjs/` — Next.js frontend (App Router, internal devtools UI)
- `reference/` — EAS docs, Scaffold-ETH docs, EIP specs (4804, 6860, 5219, 6944, 7617, 6821, 7618, 7774)

### EFS Data Model

Six EAS schema types:

| Schema | Fields | Resolver | Revocable | Purpose |
|--------|--------|----------|-----------|---------|
| `ANCHOR` | `string name, bytes32 schemaUID` | EFSIndexer | No | Folders/positions. `schemaUID` differentiates file anchors, sort anchors, etc. |
| `DATA` | `bytes32 contentHash, uint64 size` | EFSIndexer | No | Standalone file identity (`refUID = 0x0`). Cross-referenced via TAG. |
| `MIRROR` | `bytes32 transportDefinition, string uri` | MirrorResolver | Yes | Retrieval URI. `refUID = DATA UID`. Multiple per DATA allowed. |
| `TAG` | `bytes32 definition, bool applies` | TagResolver | Yes | Places content at a path: `definition = anchorUID, refUID = dataUID`. Singleton per (attester, target, definition). |
| `PROPERTY` | `string key, string value` | EFSIndexer | Yes | Key-value metadata. `refUID = parent attestation UID`. |
| `SORT_INFO` | `address sortFunc, bytes32 targetSchema` | EFSSortOverlay | Yes | Sort overlay declaration. `refUID = naming Anchor`. |

**Three-layer model**: paths (Anchors) are decoupled from content (DATA, content-hash addressed) which is decoupled from retrieval (MIRRORs). Files are placed at paths via TAG attestations. See `docs/adr/0001-three-layer-data-model.md`.

Files are stored via SSTORE2 chunking: content split into 24KB chunks deployed as raw bytecode, then a chunk manager contract is deployed and attested as a MIRROR with a `web3://` URI.

**Kernel/overlay architecture**: EFSIndexer is the append-only kernel — revocations set `_isRevoked[uid]` but never remove from arrays. EFSSortOverlay maintains per-parent sorted linked lists, populated lazily via `processItems` calls validated by pluggable `ISortFunc` comparators.

### Smart Contracts

- **`EFSIndexer`** — Core kernel. Manages schemas, resolver hooks, path resolution (`resolvePath`, `rootAnchorUID`), directory pagination, revocation tracking (`isRevoked`), the `_qualifyingFolders` write-time index, and content-hash dedup (`dataByContentKey`). Partner contracts wired once via `wireContracts()` (deployer-only, one-time, **no escape hatch on mainnet**). Schema UIDs are immutable. Emits per-schema events for off-chain indexing.
- **`EFSRouter`** — Implements `IDecentralizedApp` for `web3://` URI resolution (ERC-5219 mode). Trace: path → `?editions=` parsing (or fallback to `?caller=` then deployer) → TAG-based DATA lookup → mirror priority resolution → SSTORE2 fetch (web3://) or `message/external-body` redirect (other transports).
- **`EFSFileView`** — Enriched directory listing views over EFSIndexer. Three variants:
  - `getDirectoryPage(parentAnchor, start, length, dataSchemaUID, propertySchemaUID)` — all children, insertion order
  - `getDirectoryPageByAddressList(parentAnchor, attesters, startingCursor, pageSize)` — attester-filtered
  - `getDirectoryPageBySchemaAndAddressList(parentAnchor, anchorSchema, attesters, startingCursor, pageSize)` — schema + attester filtered
- **`TagResolver`** — Singleton tagging pattern: one active tag per (attester, target, definition). Compact `_activeByAAS` index uses swap-and-pop for O(1) removal. Wired bidirectionally with EFSIndexer (`propagateContains` / `clearContains`).
- **`MirrorResolver`** — Validates MIRROR attestations. Enforces transport ancestry (`transportDefinition` must descend from `/transports/` anchor), URI scheme allowlist (web3, ipfs, ar, https, magnet), and 8KB URI length cap.
- **`EFSSortOverlay`** — Per-parent sorted linked lists. `processItems` lazily inserts new items with binary-search hints. `computeHints` is a free view function (eth_call) that computes correct hints client-side via binary search.
- **`NameSort`** / **`TimestampSort`** — Reference `ISortFunc` implementations.
- Deploy order: `01_indexer.ts` → `02_fileview.ts` → `03_router.ts` → `04_sortoverlay.ts` → `05_mirrors.ts` → `06_sort_functions.ts`. Final step: `wireContracts()` on EFSIndexer.

EAS contracts (Sepolia addresses used in fork):
- EAS: `0xC2679fBD37d54388Ce493F1DB75320D236e1815e`
- SchemaRegistry: `0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0`

### Internal DevTools Architecture

> **Note:** The pages in `packages/nextjs/` are the internal Scaffold-ETH debugging UI. The production **EFS Client UI** (Vite/Lit) lives in a separate external repository.

**Pages** (`packages/nextjs/app/`):
- `/` — Landing page
- `/explorer/[[...path]]` — Main file browser (URL path maps to EFS anchor path)
- `/debug/schemas` — Schema debug/testing UI
- `/easexplorer` — EAS attestation explorer
- `/blockexplorer` — Block/transaction explorer

**Explorer data flow:**
1. `explorer/[[...path]]/page.tsx` resolves the URL path → anchor UID via `Indexer.resolvePath()`, manages `editionAddresses` (the attester filter)
2. `TopicTree.tsx` renders the folder sidebar using `getDirectoryPage`
3. `FileBrowser.tsx` renders directory contents — uses `getDirectoryPageBySchemaAndAddressList` (filtered by attester addresses)
4. `Toolbar.tsx` handles file upload (SSTORE2 chunking + DATA + MIRROR + TAG attestations) and folder creation (ANCHOR attestation)

**Editions system** (`?editions=` query param):
- Empty / no param → show only files from connected wallet (`[connectedAddress]`)
- `?editions=0xABC,vitalik.eth` → show files from those addresses (ENS names resolved async via `publicClient.getEnsAddress`)
- `editionAddresses` is derived synchronously via `useMemo` to prevent flash of unfiltered data on account switch
- `lockedToEditions` ref in `FileBrowser` prevents reverting to standard query during transient empty states
- See `docs/adr/0031-editions-url-param-model.md` for the design rationale

**Key hooks** (`packages/nextjs/hooks/scaffold-eth/`):
- `useScaffoldReadContract` — reads from deployed contracts by name (resolves address from `deployedContracts.ts`)
- `useScaffoldWriteContract` — writes to deployed contracts
- `useDeployedContractInfo` — gets ABI + address for a contract name
- `useTargetNetwork` — returns the configured chain from `scaffold.config.ts`

### Dev Wallet Switcher

`DevWalletSwitcher.tsx` (shown only on hardhat network) switches between the 20 deterministic Hardhat accounts. It uses wagmi's `useDisconnect`/`useConnect` with the `burnerWallet` connector — **no page reload**. The burner connector re-reads `localStorage["burnerWallet.pk"]` on each `connect()` call via `loadBurnerPK()`.

### Contract ABI Updates

After changing contracts and redeploying, regenerate the TypeScript ABIs:
```bash
yarn deploy  # auto-runs generateTsAbis script
```
Generated ABIs land in `packages/nextjs/contracts/deployedContracts.ts`.

## Mainnet permanence

**Contracts on mainnet are permanent.** No proxies, no upgradeability. This is intentional (credible neutrality) — see `docs/adr/0030-mainnet-permanence.md`. Devnet/Sepolia may use upgradeable proxies during the design phase; mainnet does not. **Any change that would require a future migration must be flagged in `docs/QUESTIONS.md` before being implemented.**
