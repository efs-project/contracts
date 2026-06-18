# EFS Schema-Freeze Build — Implementation Plan (r2)

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax. **Permanence tier: Etched** — ADR/spec before code, 50-year test, invariant tests.
>
> **r2 (2026-06-02):** folds in the 7-lens critique (`2026-06-02-schema-freeze-plan-critique.md`, 66 verified findings). Key changes: **single PR with staged commits** (James's call — conscious waiver of the WIP-limit for a greenfield freeze, since the on-chain registration is one atomic end-ceremony regardless and the changes concentrate in the same files); on-chain ListEntry self-UID verification; explicit empty-DATA decode/event/deploy fixes; DATA-ripple ownership + cross-repo flag; CREATE3 spike-first; storage-layout + upgrade-with-state tests scheduled; `getEAS` guard; SORT_INFO wiring reconciliation; rollback procedure.

**Goal:** Ship the frozen 9-schema EFS set to Sepolia behind upgradeable (later burnable) CREATE3 proxy resolvers, proven by an end-to-end round-trip and a human-signed frozen-UID table.

**Architecture:** Refactor the 5 existing resolvers (+ new `AliasResolver`) onto a shared `EFSUpgradeableResolver` base (EAS `SchemaResolver` immutable `_eas` + OZ `Initializable` + `_disableInitializers()` in impl + ERC-7201 storage). Deploy each behind a CREATE3-deterministic Transparent proxy, **initialize atomically**, **verify on-chain**, **register schemas last**. DATA → empty (pure-identity); REDIRECT (`bytes32 target, uint16 kind`) added. Single PR; logic upgradeable through dev; key burned before mainnet.

**Tech stack:** Solidity 0.8.26 (optimizer 200, viaIR), Hardhat + hardhat-deploy, EAS `eas-contracts`, OZ `@openzeppelin/contracts` ~5.0.2 + **new:** `@openzeppelin/contracts-upgradeable`, `@openzeppelin/hardhat-upgrades`; **CreateX** factory for CREATE3.

**Governing:** ADR-0048 (freeze+proxy/burn), ADR-0049 (empty DATA), ADR-0050 (REDIRECT), `docs/SEPOLIA_FREEZE_TABLE.md`, critique synthesis.

**Delivery:** ONE PR (`schema-freeze`), commits ordered DATA-reshape → proxy-refactor → REDIRECT, each phase's tests green before the next. On-chain registration is a single end-ceremony (Phase 7).

---

## Frozen set (9) — target

| # | Schema | Field string (frozen) | revocable | Resolver |
|---|---|---|---|---|
| 1 ANCHOR | `string name, bytes32 forSchema` | false | EFSIndexer |
| 2 PROPERTY | `string value` | false | EFSIndexer |
| 3 DATA | `` (empty) | false | EFSIndexer |
| 4 PIN | `bytes32 definition` | true | EdgeResolver |
| 5 TAG | `bytes32 definition, int256 weight` | true | EdgeResolver |
| 6 MIRROR | `bytes32 transportDefinition, string uri` | true | MirrorResolver |
| 7 LIST | `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries` | false | ListResolver |
| 8 LIST_ENTRY | `bytes32 listUID, bytes32 target` | true | ListEntryResolver |
| 9 REDIRECT | `bytes32 target, uint16 kind` | true | AliasResolver |

**Drop:** BLOB, NAMING (remove from `01_indexer.ts`; don't deploy `SchemaNameIndex`). **Defer:** SORT_INFO + `EFSSortOverlay` — and **also remove `_sortInfoSchemaUID` from `EFSIndexer.wireContracts` / `04_sortoverlay` registration** so no half-wired SORT_INFO slot is left (critique theme 7).

---

## Phase 0 — prerequisites & spikes (do FIRST)

- [ ] **0.1 deps (Tier-2, log in QUESTIONS.md):** `yarn add -D @openzeppelin/contracts-upgradeable@^5.0.2 @openzeppelin/hardhat-upgrades`; `import "@openzeppelin/hardhat-upgrades"` in `hardhat.config.ts`. Confirm `upgrades` namespace + `validateUpgrade` available. Commit.
- [ ] **0.2 CreateX spike (BLOCKING — critique theme 5):** Verify the CreateX factory is deployed on **Sepolia** at its canonical address (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) and on the pinned fork; fetch the **exact** `deployCreate3` / `deployCreate3AndInit` signatures from CreateX source/ABI and confirm `deployCreate3AndInit` lets us pass the proxy constructor calldata for atomic deploy+init. Record a per-chain availability matrix in `docs/decisions.md`. **If CreateX is absent on a target chain, STOP and escalate** (fallback: deploy our own CreateX or use plain CREATE2 with frozen init-code). Decide TS-only (ethers calls CreateX) vs a Solidity helper; vendor `contracts/external/ICreateX.sol` only if Solidity-side calls are needed.
- [ ] **0.3 salt scheme:** define per-resolver salts as committed constants in `deploy-lib/create3.ts` (e.g. permissioned salt = `deployer ++ entropy`); document they are one-time-chosen and frozen.

---

## File structure
**New:** `contracts/base/EFSUpgradeableResolver.sol`, `contracts/AliasResolver.sol`, `contracts/external/ICreateX.sol` (if needed), `deploy-lib/schemas.ts`, `deploy-lib/create3.ts`, `deploy-lib/verify.ts`, `test/{Upgradeability,UpgradeWithState,GoldenVectors,AliasResolver,Freeze.e2e}.test.ts`, `test/helpers/deployProxy.ts`.
**Modified:** the 5 resolvers; deploy `01/04/05/09` + new `0X_redirect`; `hardhat.config.ts`; `specs/02`, `specs/overview.md`; events in `EFSIndexer.sol`.

---

## COMMIT GROUP A — DATA reshape (lands + tests green first)

### Phase A1 — DATA → empty, with the three fixes the critique caught
**Files:** `contracts/EFSIndexer.sol`; `deploy/01_indexer.ts`; `specs/02`, `specs/overview.md`; Test `test/EFSIndexer.test.ts`.

- [ ] **A1.1 specs first** (Etched): `specs/02` §3 + `overview.md` table → DATA empty; `contentHash`/`size`/`cid`/`hash:*` are reserved-key PROPERTYs. Supersede ADR-0002/0004/0005 framing (note in those ADRs' status lines per the supersession discipline).
- [ ] **A1.2 failing test:** attest under an empty DATA schema (`data.length == 0`) → expect ACCEPTED + indexed. Run → FAIL.
- [ ] **A1.3 fix `onAttest` DATA branch (critique theme 3 — the decode reverts!):** in `EFSIndexer.onAttest`, **delete the `abi.decode(attestation.data, (bytes32, uint64))`** (it reverts on zero-length data) and the `dataByContentKey` write. New DATA branch: validate `refUID == 0` + `revocable == false`, index the bare DATA UID. Keep the `dataByContentKey` mapping declared (storage-order preserved; now unused / advisory). Re-run A1.2 → PASS.
- [ ] **A1.4 event migration (critique theme — downstream break):** `DataCreated(bytes32 indexed dataUID, address indexed attester, bytes32 contentHash)` loses its field. Change to `DataCreated(bytes32 indexed dataUID, address indexed attester)`; update all emit sites; grep subgraph/indexer configs and note the ABI change in the PR + `docs/decisions.md` (downstream indexers bind to this).
- [ ] **A1.5 deploy-string fix (critique theme 3):** `deploy/01_indexer.ts` — change DATA registration from `"bytes32 contentHash, uint64 size"` to `""`; drop BLOB + NAMING registrations + `SchemaNameIndex` deploy; remove `blobSchemaUID` from the EFSIndexer constructor/init args. Run the indexer suite → PASS. Commit.

### Phase A2 — DATA-ripple consumers (critique theme 4 — was unowned)
**Files:** `contracts/EFSRouter.sol`, `contracts/EFSFileView.sol`, `deploy/08_seed_demo_tree.ts`, `packages/nextjs/**`, `docs/QUESTIONS.md`.
- [ ] **A2.1 grep + map:** `grep -rn "contentHash\|dataByContentKey" contracts/ packages/nextjs/ deploy/` — quote output in the PR (Etched discipline). For each: fix to read the `contentHash` PROPERTY (or off-chain index) instead of the removed field, or `// AGENT-NOTE` + task if out-of-scope.
- [ ] **A2.2 upload-flow doc:** update `overview.md` "upload flow" step 2 — native upload now attaches `contentHash`/`size` PROPERTYs; remote pin attaches `cid`. 
- [ ] **A2.3 production-client cross-repo (Tier-2):** add a `docs/QUESTIONS.md` entry — the separate `efs-project/client` repo reads `contentHash`/`size` from DATA; it must update to read the PROPERTYs. Flag for James (cross-repo; can't fix here). Commit.

---

## COMMIT GROUP B — proxy refactor

### Phase B1 — `EFSUpgradeableResolver` base + storage-layout gate
**Files:** Create `contracts/base/EFSUpgradeableResolver.sol`; `test/Upgradeability.test.ts`, `test/helpers/deployProxy.ts`.
- [ ] **B1.1 base contract:**
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @dev `_eas` stays an EAS-base constructor immutable: EAS is a per-chain constant, immutables live in
/// impl bytecode and resolve under delegatecall, and EAS calls resolvers via CALL (not delegatecall) so
/// onlyEAS holds. EVERY impl upgrade MUST re-supply the same EAS (asserted by the verify gate, B-gate).
abstract contract EFSUpgradeableResolver is SchemaResolver, Initializable {
    constructor(IEAS eas) SchemaResolver(eas) { _disableInitializers(); }
}
```
- [ ] **B1.2 failing test — impl initializer locked:** deploy a mock subclass directly; assert `initialize()` reverts `InvalidInitialization()`; assert `getEAS()` returns the EAS passed. FAIL → write mock → PASS.
- [ ] **B1.3 wire `validateUpgrade` CI gate (critique theme 6):** in `test/Upgradeability.test.ts`, add a helper using OZ `upgrades.validateUpgrade(...)` (or `forge inspect storage-layout` snapshot diff). Add it to CI as a blocking job on any resolver change. Commit.

### Phase B2 — refactor each resolver (pattern: immutables → ERC-7201 storage set in `initialize`; `_eas` stays in base constructor; mappings keep order; `DEPLOYER`/`_deployer` → `OwnableUpgradeable`)
- [ ] **B2.1 EFSIndexer (template — shown in r1):** ERC-7201 `IndexerConfig{anchorSchemaUID, propertySchemaUID, dataSchemaUID}` (BLOB dropped) + `__Ownable_init(owner)`; constructor → `constructor(IEAS eas) EFSUpgradeableResolver(eas) {}`; `initialize(anchor, property, data, owner)`; keep public getters with old names for ABI; `wireContracts`/`setSortsAnchor` → `onlyOwner`, **drop the SORT_INFO param** (theme 7); preserve the one-shot `require(... == 0)` guards. Run `test/EFSIndexer*.test.ts` behind a proxy → PASS. Commit.
- [ ] **B2.2 EdgeResolver:** `EdgeConfig{pinSchemaUID, tagSchemaUID, indexer, schemaRegistry}` + owner; keep the pin≠0/tag≠0/pin≠tag invariants inside `initialize`; mappings keep order. **Add failing test: PIN supersession behind a proxy** (theme 6) — attest PIN→A, PIN→B same slot, assert prior revoked + active==B in O(1). Run `test/EdgeResolver*.test.ts` → PASS. Commit.
- [ ] **B2.3 MirrorResolver:** `MirrorConfig{indexer}` + owner; `transportsAnchorUID` stays; `setTransportsAnchor` → `onlyOwner` (one-shot). **Also fold theme: widen `_isAllowedScheme`** (add ftp/s3/gs/bittorrent/dat — scheme safety is a client-render concern; supersede ADR-0023, update `specs/02` §Mirror). Failing test (`s3://` mirror accepted) → PASS. Run `test/EFSTransports.test.ts` → PASS. Commit.
- [ ] **B2.4 ListResolver:** trivial — `constructor(IEAS eas) EFSUpgradeableResolver(eas) {}` + empty `initialize() external initializer {}`. Run LIST cases → PASS. Commit.
- [ ] **B2.5 ListEntryResolver (CRITICAL — critique themes 2):** drop both immutables; `ListEntryConfig{listSchemaUID, listEntrySchemaUID}` ERC-7201; `initialize(listSchemaUID, owner)` computes `$.listEntrySchemaUID = keccak256(abi.encodePacked(LIST_ENTRY_DEFINITION, address(this), true))` — now `address(this)` is the proxy. **Add `function listEntrySchemaUID() external view returns (bytes32)`** (the on-chain getter the verify gate reads). **Failing test:** behind a CREATE3 proxy at `P`, after `initialize`, assert the getter `== keccak256(abi.encodePacked(LIST_ENTRY_DEFINITION, P, true))` and `!= impl-derived`. Add a false-green guard (flip `==`→`!=`, confirm it fails). Run `test/Lists.*.test.ts` → PASS. Commit.

### Phase B3 — anchor-name canonical encoding (theme 9 — must precede freeze)
- [ ] **B3.1** define canonical encoding in `specs/02` §1 (NFC + percent-encode the reserved byte set); enforce/normalize in `EFSIndexer._isValidAnchorName`; supersede ADR-0025. Failing test (`"Q&A: Episode 5"` round-trips deterministically) → PASS. Commit.

### Phase B4 — upgrade-with-state corruption test (theme 6 — was only in pre-burn checklist)
- [ ] **B4.1** `test/UpgradeWithState.test.ts`: deploy each resolver proxy v0, seed state (anchors, PINs, list entries), snapshot key index reads, deploy a v1 impl (trivial change), `upgradeAndCall`, assert every snapshotted read is byte-identical and `getEAS()` unchanged. Run → PASS. Commit. **This is the 50-year silent-corruption guard.**

---

## COMMIT GROUP C — REDIRECT
### Phase C1 — REDIRECT schema + `AliasResolver`
**Files:** Create `contracts/AliasResolver.sol`; `test/AliasResolver.test.ts`.
- [ ] **C1.1 failing tests (all guards):** sameAs(DATA,DATA)→ok; target==0→revert; target==refUID→revert; symlink(non-Anchor source)→revert; unknown kind(99)→recorded, `followable()`==false; revoke→ok. FAIL.
- [ ] **C1.2 implement** extending `EFSUpgradeableResolver`, schema `"bytes32 target, uint16 kind"`; `initialize(redirectSchemaUID, owner)`; `onAttest` decodes `(bytes32 target, uint16 kind)`, reads source from `refUID`, enforces per-kind typing (0/1 require source+target DATA; 2 requires source Anchor; ≥3 recorded not auto-followed); optional advisory `_aliasesByTarget` reverse index in ERC-7201 storage. PASS. Commit.

> Read-time multi-hop resolution is NOT here — it's the spec + (deferred) router/client follower (Phase 7.2 / D2 below).

---

## Phase D — deploy pipeline (CREATE3, register-LAST) + the verify gate
**Files:** `deploy-lib/{schemas,create3,verify}.ts`; rewrite `deploy/01/04/05/09` + new `0X_redirect`; `test/GoldenVectors.test.ts`.
- [ ] **D1 single-source schema strings:** `deploy-lib/schemas.ts` exports each field string + revocable; `ListEntryResolver.LIST_ENTRY_DEFINITION` is the canonical Solidity copy; golden-vector test asserts byte-equality. BLOB/NAMING/SORT_INFO removed from the registered set.
- [ ] **D2 CREATE3 helper:** `deployProxyCreate3(implFactory, salt, initCalldata, owner)` → deploy impl → CreateX `deployCreate3AndInit` deploys `TransparentUpgradeableProxy(impl, owner, initCalldata)` at the salt-derived address **and inits in one tx** → assert `realized == predicted` (abort on mismatch). Salts from 0.3.
- [ ] **D3 verify gate** `deploy-lib/verify.ts` (run after each proxy, before any register): (1) realized==predicted; (2) `initialize` reverts on 2nd call; (3) impl `initialize()` reverts directly; (4) **read on-chain self-UID getters** (ListEntry `listEntrySchemaUID()`, others) and assert `== keccak256(fieldString, proxyAddr, revocable)` (critique theme 2 — read, don't recompute); (5) **`proxy.getEAS() == EXPECTED_EAS_FOR_CHAIN`** (theme 8); (6) `wireContracts`/`setTransportsAnchor` set; (7) `validateUpgrade` storage-layout clean.
- [ ] **D4 golden-vector test** `test/GoldenVectors.test.ts`: after deploy+init, for each schema **read the deployed value on-chain** and assert it equals the local `solidityPackedKeccak256(["string","address","bool"],[field, proxyAddr, revocable])` AND the EAS-registered UID. Assert Solidity `LIST_ENTRY_DEFINITION` == `schemas.ts`. 
- [ ] **D5 register-LAST + wire + live smoke:** only after all proxies pass D3 → register all 9 with `resolver = proxy`, assert `getSchema(uid).resolver == proxy` + no conflicting prior registration → wire partners → push one real attestation through **every** schema (onAttest no revert + expected index written) + one revoke per revocable schema (exercise a rejection branch too).
- [ ] **D6 rollback procedure (theme 10):** document in `deploy/README.md` — if any verify check fails, **halt before register-last**, capture the failing resolver/check, and on a clean network wipe+redeploy from the salt (no real data pre-freeze). Never register against an unverified proxy.
- [ ] **D7** run full suite on the pinned fork; `git diff --exit-code packages/nextjs/contracts/deployedContracts.ts` (ADR-0037 pin holds). Commit.

---

## Phase E — conventions, Sepolia freeze, round-trip
- [ ] **E1** `specs/09-content-identity-conventions.md`: canonical preimage + multibase/multicodec for `contentHash`/`cid`/`hash:*` + reference vectors (Durable; before durable seeding).
- [ ] **E2** `specs/10-redirect-resolution.md`: lens precedence, `D_MAX`, cycle→lowest-UID-in-SCC, kinds-followed, tiebreak + conformance vectors. **Decision noted:** redirect *following* (router/client implementation, theme 10) is **deferred to post-freeze** — writing REDIRECT attestations is sufficient to freeze the schema; following is upgradeable logic. (If James wants following at launch, add Phase D-follow.)
- [ ] **E3 deploy to Sepolia; fill FREEZE_LEDGER:** run Phase D against Sepolia; fill `docs/SEPOLIA_FREEZE_TABLE.md` with realized proxy addresses, computed UIDs, impl+proxy bytecode keccak, salts, factory, EAS+registry+chainId. **STOP — human gate: James signs the table.** (Tier-1; no seed-data registration until signed.)
- [ ] **E4 round-trip proof** `test/Freeze.e2e.test.ts` + live: anchor → empty DATA → `contentHash` PROPERTY → PIN (place) → MIRROR → read back via FileView/Router; LIST + LIST_ENTRY read back; REDIRECT(sameAs) created + resolved client-side. Commit the evidence.

---

## Out of scope (later): burn-to-immutable (own runbook + 14-day soak); on-chain property index (find-by-hash); redirect-following implementation; general typed-edge/EVENT; signature-PROPERTY.

## Verification gates (block the next phase)
1. Group A: empty-DATA attests+indexes; no `abi.decode` revert; ripple consumers fixed or noted.
2. Group B: existing suites green behind proxies; impl initializer locked; **ListEntry self-UID (read on-chain) == proxy-derived**; PIN supersession; upgrade-with-state byte-identical; `validateUpgrade` clean.
3. Phase D: golden-vector reads on-chain == registered UID; `getEAS` == expected; deployedContracts pin holds; live smoke through all 9.
4. Phase E: **human-signed freeze table before registration**; round-trip green.

## Open items for James (not blocking dev start)
- E2 decision: is redirect-*following* in-scope at launch, or deferred (plan default = deferred)?
- A2.3: production-client repo update (cross-repo) — schedule separately.
- 0.2: if CreateX is absent on a target chain, escalate (fallback choice).
