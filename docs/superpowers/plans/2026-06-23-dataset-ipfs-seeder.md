# Dataset IPFS Seeder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded Hardhat CLI that pins dataset files to IPFS and writes EFS DATA/MIRROR/PROPERTY/PIN/TAG attestations from a curator EOA.

**Architecture:** Keep pure manifest/path/IPFS helpers in a small script library with focused tests. Keep chain writes in `seed-dataset.ts`, dry-run by default, and require `--execute --pin` for the Monday dataset seed path.

**Tech Stack:** Hardhat, ethers v6, EAS `attest`/`multiAttest`, Kubo HTTP API `POST /api/v0/add`, Node HTTP(S).

---

### Task 1: Helper Tests

**Files:**
- Create: `packages/hardhat/test/SeedDatasetLib.test.ts`
- Create: `packages/hardhat/scripts/seed-dataset-lib.ts`

- [ ] Write tests for CLI arg parsing, safe manifest paths, Kubo add response parsing, and IPFS API URL normalization.
- [ ] Run `yarn workspace @se-2/hardhat test test/SeedDatasetLib.test.ts --network hardhat` and confirm it fails because the helper module does not exist yet.

### Task 2: Helper Library

**Files:**
- Create: `packages/hardhat/scripts/seed-dataset-lib.ts`

- [ ] Implement `parseSeedDatasetArgs`, `assertSafeManifestPath`, `parseKuboAddResponse`, `buildIpfsAddUrl`, `contentTypeForEntry`, and `loadDatasetManifest`.
- [ ] Run the targeted test and confirm it passes.

### Task 3: Seeder CLI

**Files:**
- Create: `packages/hardhat/scripts/seed-dataset.ts`

- [ ] Implement dry-run manifest validation and file summary.
- [ ] Implement optional Kubo pinning via `--execute --pin --ipfs-api-url <url>`.
- [ ] Implement EFS writes: ensure anchor path, ensure tag anchors, attest DATA, MIRROR, contentType/contentHash/size PROPERTYs, placement PIN, manifest TAGs, and ancestor folder visibility TAGs.
- [ ] Keep idempotency simple: skip a file when the curator already has an active placement PIN at its file anchor unless `--force` is passed.

### Task 4: Script Wiring

**Files:**
- Modify: `package.json`
- Modify: `packages/hardhat/package.json`

- [ ] Add `seed:dataset` to the Hardhat package.
- [ ] Add `hardhat:seed:dataset` to the root package.

### Task 5: Verification

**Files:**
- No file changes.

- [ ] Run `yarn workspace @se-2/hardhat test test/SeedDatasetLib.test.ts --network hardhat`.
- [ ] Run `yarn workspace @se-2/hardhat check-types`.
- [ ] Run a dry-run command against `../datasets/web-games/manifest.json` and confirm it does not write or pin.
