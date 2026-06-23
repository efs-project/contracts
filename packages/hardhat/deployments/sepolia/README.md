# deployments/sepolia — committed real-network records

These are hardhat-deploy's address records for **live Sepolia (chainId 11155111)**.
Unlike dev networks (localhost/hardhat/devnet), this directory is **committed** —
the Sepolia foundation is a one-time, irreplaceable deploy, so its records must
not live on a single machine (see `packages/hardhat/.gitignore` and ADR-0061).

Two provenance classes:

- **Frozen core** — `Indexer`, `EdgeResolver`, `MirrorResolver`, `ListResolver`,
  `ListEntryResolver`, `AliasResolver`, `SystemAccount`. The freeze was executed
  via the **Safe Transaction Builder UI**, so hardhat-deploy never produced records
  for it. These files are **reconstructed** (`{address, abi}` only): the addresses
  are verified three ways — the executed Safe batches, `docs/CHAINS.md`, and live
  `eth_getCode` — and the ABIs come from the current compiled artifacts. They exist
  so `deploy:efs-views` (`getOrNull`) and other tooling can resolve the frozen core
  from a clean checkout. They are NOT full deploy artifacts (no tx hash / receipt).

- **Redeployable views** — `EFSFileView`, `EFSRouter`, `ListReader`. These are
  **genuine** hardhat-deploy artifacts from the actual `deploy:efs-views` run.
  Re-running `deploy:efs-views` overwrites them with new addresses (the views are
  stateless and in no schema UID — ADR-0048/0058).

The authoritative human/client view of all addresses is `docs/CHAINS.md` +
`packages/nextjs/contracts/deployedContracts.ts`. `solcInputs/` is gitignored.
