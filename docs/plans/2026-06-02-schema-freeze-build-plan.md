# EFS Schema-Freeze Build — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this task-by-task. Steps use checkbox (`- [ ]`) syntax. **Permanence tier: Etched** (schema UIDs + resolver addresses) — write the ADR/spec before the code, run the 50-year test, prefer invariant tests.

**Goal:** Ship the frozen 9-schema EFS set to Sepolia behind upgradeable (later burnable) proxy resolvers, proven by an end-to-end round-trip and a human-signed frozen-UID table.

**Architecture:** Refactor the 5 existing resolvers (+ 1 new `AliasResolver`) onto a shared `EFSUpgradeableResolver` base (EAS `SchemaResolver` + OZ `Initializable`, ERC-7201 storage, `_disableInitializers()` in impl). Deploy each behind a CREATE3-deterministic Transparent proxy, **initialize atomically**, **verify**, then **register schemas last** with `resolver = proxy`. DATA becomes an empty (pure-identity) schema; REDIRECT (`bytes32 target, uint16 kind`) is added. Logic stays upgradeable through dev; the upgrade key is burned before mainnet.

**Tech stack:** Solidity 0.8.26 (optimizer 200, viaIR), Hardhat + hardhat-deploy, EAS `eas-contracts`, OpenZeppelin `@openzeppelin/contracts` ~5.0.2 + **new:** `@openzeppelin/contracts-upgradeable` + `@openzeppelin/hardhat-upgrades`, **CreateX** factory (`0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed`) for CREATE3.

**Governing decisions:** ADR-0048 (freeze set + proxy/burn), ADR-0049 (empty DATA), ADR-0050 (REDIRECT), `docs/SEPOLIA_FREEZE_TABLE.md`.

---

## Frozen set (target — 9 schemas)

| # | Schema | Field string (exact, frozen) | revocable | Resolver |
|---|---|---|---|---|
| 1 | ANCHOR | `string name, bytes32 schemaUID` | false | EFSIndexer |
| 2 | PROPERTY | `string value` | false | EFSIndexer |
| 3 | DATA | `` (empty) | false | EFSIndexer |
| 4 | PIN | `bytes32 definition` | true | EdgeResolver |
| 5 | TAG | `bytes32 definition, int256 weight` | true | EdgeResolver |
| 6 | MIRROR | `bytes32 transportDefinition, string uri` | true | MirrorResolver |
| 7 | LIST | `bool allowsDuplicates, bool appendOnly, uint8 targetType, bytes32 targetSchema, uint256 maxEntries` | false | ListResolver |
| 8 | LIST_ENTRY | `bytes32 listUID, bytes32 target` | true | ListEntryResolver |
| 9 | REDIRECT | `bytes32 target, uint16 kind` | true | AliasResolver |

**Dropped:** BLOB, NAMING (remove from `01_indexer.ts`; don't deploy `SchemaNameIndex`). **Deferred:** SORT_INFO + `EFSSortOverlay` (keep the contracts, skip registration/wiring for the freeze).

---

## Prerequisites (Tier-2 — new dependencies; flag in `docs/QUESTIONS.md`)

- [ ] **Task 0.1 — add upgradeable deps.** `cd packages/hardhat && yarn add -D @openzeppelin/contracts-upgradeable@^5.0.2 @openzeppelin/hardhat-upgrades`. Register the plugin in `hardhat.config.ts` (`import "@openzeppelin/hardhat-upgrades"`). Add an entry to `docs/QUESTIONS.md` recording the new deps (Tier-2). Commit: `chore(hardhat): add OZ upgradeable + hardhat-upgrades (Tier-2 deps for proxy resolvers)`.
- [ ] **Task 0.2 — vendor a CreateX interface.** CreateX is a pre-deployed factory; we only need its interface + the canonical address. Create `packages/hardhat/contracts/external/ICreateX.sol` with the `deployCreate3` and `deployCreate3AndInit` signatures (copy from CreateX docs). Record the factory address + per-chain availability check in `docs/decisions.md`. Note: **zkSync-class chains are excluded** from CREATE3 address parity (different derivation).

---

## File structure

**New:**
- `packages/hardhat/contracts/base/EFSUpgradeableResolver.sol` — shared initializable resolver base.
- `packages/hardhat/contracts/AliasResolver.sol` — REDIRECT resolver.
- `packages/hardhat/contracts/external/ICreateX.sol` — CreateX interface.
- `packages/hardhat/deploy/lib/schemas.ts` — single source of truth for every schema field string + revocable flag.
- `packages/hardhat/deploy/lib/create3.ts` — CREATE3 deploy+init+verify helper.
- `packages/hardhat/test/Upgradeability.test.ts` — init-lock, storage-layout, self-UID-matches-proxy, upgrade-with-state.
- `packages/hardhat/test/GoldenVectors.test.ts` — field-string ↔ on-chain UID parity.
- `packages/hardhat/test/AliasResolver.test.ts` — REDIRECT guards.
- `packages/hardhat/test/Freeze.e2e.test.ts` — full deploy → round-trip.

**Modified:** the 5 resolvers (`EFSIndexer.sol`, `EdgeResolver.sol`, `MirrorResolver.sol`, `ListResolver.sol`, `ListEntryResolver.sol`); deploy scripts `01`–`09`; `hardhat.config.ts`; `specs/02-Data-Models-and-Schemas.md` + `specs/overview.md`.

---

## Phase 1 — `EFSUpgradeableResolver` base

**Files:** Create `packages/hardhat/contracts/base/EFSUpgradeableResolver.sol`; Test `test/Upgradeability.test.ts`.

The base keeps `_eas` as an EAS-`SchemaResolver` constructor immutable (EAS address is a per-chain constant; immutables live in impl bytecode and resolve correctly under delegatecall — verified). It adds OZ `Initializable` and disables the implementation's initializer.

- [ ] **Step 1.1 — write the base.**
```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { SchemaResolver } from "@ethereum-attestation-service/eas-contracts/contracts/resolver/SchemaResolver.sol";
import { IEAS } from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @notice Base for EFS resolvers deployed behind upgradeable proxies.
/// `_eas` stays an implementation-immutable (EAS is a per-chain constant);
/// all EFS-specific state moves into per-resolver ERC-7201 storage set in initialize().
abstract contract EFSUpgradeableResolver is SchemaResolver, Initializable {
    /// @param eas the canonical EAS for this chain. MUST be identical across every implementation upgrade.
    constructor(IEAS eas) SchemaResolver(eas) {
        _disableInitializers(); // implementation can never be initialized directly (Parity/Wormhole class)
    }
}
```
- [ ] **Step 1.2 — failing test: implementation initializer is locked.** In `test/Upgradeability.test.ts`, deploy a trivial concrete subclass directly (not behind a proxy) and assert calling its `initialize()` reverts `InvalidInitialization()`. Run: `cd packages/hardhat && npx hardhat test test/Upgradeability.test.ts --network hardhat`. Expected: FAIL (subclass not yet written).
- [ ] **Step 1.3 — minimal concrete subclass + make it pass.** Write a `test/mocks/MockResolver.sol` extending `EFSUpgradeableResolver` with an `initialize()` and trivial onAttest. Re-run: PASS.
- [ ] **Step 1.4 — commit.** `git add … && git commit -m "feat(contracts): EFSUpgradeableResolver base (Initializable + impl initializer locked)"` (trailers: `Permanence-tier: Etched`, `Refs: ADR-0048`).

---

## Phase 2 — refactor the 5 resolvers to initializer + ERC-7201

**Pattern (apply to each):** (a) change inheritance to `EFSUpgradeableResolver`; (b) move every EFS-specific `immutable`/constructor-set value and `DEPLOYER`/`_deployer` into an ERC-7201 namespaced storage struct set in `initialize(...)`; (c) keep `_eas` in the base constructor; (d) constructor becomes `constructor(IEAS eas) EFSUpgradeableResolver(eas) {}`; (e) replace `msg.sender == DEPLOYER` guards with OZ `OwnableUpgradeable` (owner set in `initialize`). **Never reorder/retype/remove an existing storage slot** — the live mappings keep their layout; only the immutables migrate into the namespaced struct.

### EFSIndexer (template — show fully)

**Files:** Modify `contracts/EFSIndexer.sol`; Test `test/Upgradeability.test.ts`, existing `test/EFSIndexer*.test.ts`.

- [ ] **Step 2.1 — ERC-7201 storage struct.** Add the namespaced struct holding what were immutables (`ANCHOR_SCHEMA_UID`, `PROPERTY_SCHEMA_UID`, `DATA_SCHEMA_UID` — BLOB dropped) plus `owner`. The existing `rootAnchorUID`, the wired schema-UID storage vars (`PIN/TAG/SORT_INFO/MIRROR_SCHEMA_UID`), partner addresses, `sortsAnchorUID`, and all mappings (`dataByContentKey`, `_children`, …) keep their current declaration order untouched.
```solidity
/// @custom:storage-location erc7201:efs.indexer.config
struct IndexerConfig { bytes32 anchorSchemaUID; bytes32 propertySchemaUID; bytes32 dataSchemaUID; }
// keccak256(abi.encode(uint256(keccak256("efs.indexer.config")) - 1)) & ~bytes32(uint256(0xff))
bytes32 private constant _CONFIG_SLOT = 0x...; // generate with the ERC-7201 formula
function _config() private pure returns (IndexerConfig storage $) { assembly { $.slot := _CONFIG_SLOT } }
```
- [ ] **Step 2.2 — initialize().** Replace the constructor body:
```solidity
constructor(IEAS eas) EFSUpgradeableResolver(eas) {}

function initialize(bytes32 anchorSchemaUID, bytes32 propertySchemaUID, bytes32 dataSchemaUID, address owner_)
    external initializer
{
    require(owner_ != address(0), "owner zero");
    IndexerConfig storage $ = _config();
    $.anchorSchemaUID = anchorSchemaUID;
    $.propertySchemaUID = propertySchemaUID;
    $.dataSchemaUID = dataSchemaUID;
    __Ownable_init(owner_); // OwnableUpgradeable; replaces DEPLOYER
}
```
Replace reads of `ANCHOR_SCHEMA_UID` etc. with `_config().anchorSchemaUID` (add `public` getters preserving the old names for ABI/back-compat). Replace `require(msg.sender == DEPLOYER)` in `wireContracts`/`setSortsAnchor` with `onlyOwner`. Keep the one-shot `require(edgeResolver == address(0))` / `require(sortsAnchorUID == bytes32(0))` guards (they read proxy storage — survive upgrades correctly).
- [ ] **Step 2.3 — DATA reshape touchpoints (see Phase 3) are applied here too.**
- [ ] **Step 2.4 — run existing EFSIndexer tests against the proxy.** Adapt the test harness to deploy EFSIndexer behind a proxy (helper in `test/helpers/deployProxy.ts`) and call `initialize`. Run all `test/EFSIndexer*.test.ts`: Expected PASS (behaviour unchanged).
- [ ] **Step 2.5 — commit.**

### EdgeResolver
- [ ] **Step 2.6** — move `PIN_SCHEMA_UID`, `TAG_SCHEMA_UID`, `indexer`, `schemaRegistry` immutables → `EdgeConfig` ERC-7201 struct set in `initialize(eas?, pin, tag, indexer, registry, owner)`; keep the constructor `require` invariants (pin≠0, tag≠0, pin≠tag) inside `initialize`. Mappings (`_activeBySlot`, `_activeByAAS`, …) keep order. Run `test/EdgeResolver*.test.ts`: PASS. Commit.

### MirrorResolver
- [ ] **Step 2.7** — move `indexer`, `_deployer` immutables → `MirrorConfig` struct in `initialize`; `transportsAnchorUID` storage var stays; `setTransportsAnchor` guard → `onlyOwner` (one-shot guard kept). Run `test/EFSTransports.test.ts`: PASS. Commit.

### ListResolver (stateless)
- [ ] **Step 2.8** — trivial: `constructor(IEAS eas) EFSUpgradeableResolver(eas) {}` + empty `initialize() external initializer {}` (only `_disableInitializers` matters). Run `test/Lists.unit.test.ts` (LIST cases): PASS. Commit.

### ListEntryResolver (the critical one)
- [ ] **Step 2.9 — failing test: self-UID matches the PROXY.** In `test/Upgradeability.test.ts`, deploy ListEntryResolver behind a CREATE3 proxy at address `P`, init it, then assert its public `listEntrySchemaUID()` getter equals `keccak256(abi.encodePacked("bytes32 listUID, bytes32 target", P, true))`. Run: FAIL (still constructor-derived → equals the impl address).
- [ ] **Step 2.10 — move the derivation into initialize().** Drop the two `immutable`s (`LIST_SCHEMA_UID`, `_listEntrySchemaUID`); put both in a `ListEntryConfig` ERC-7201 struct; in `initialize(bytes32 listSchemaUID, address owner_)` compute `$.listEntrySchemaUID = keccak256(abi.encodePacked(LIST_ENTRY_DEFINITION, address(this), true))` — now `address(this)` is the proxy. Keep `LIST_ENTRY_DEFINITION` as the contract constant (single-sourced in Phase 6). Re-run Step 2.9: PASS. Run `test/Lists.*.test.ts`: PASS. Commit.

---

## Phase 3 — DATA reshape (empty schema; hash/size as properties)

**Files:** Modify `contracts/EFSIndexer.sol`; `specs/02-Data-Models-and-Schemas.md`, `specs/overview.md`; Test `test/EFSIndexer.test.ts`.

- [ ] **Step 3.1 — write ADR-0049 r2 is already done; update specs.** Change `specs/02` §3 + `overview.md` "nine schemas" table: DATA = empty; `contentHash`/`size` are reserved-key PROPERTYs; document `cid`/`hash:*` reserved keys + the canonical-preimage convention (stub now, full vectors in Phase 7).
- [ ] **Step 3.2 — failing test: empty DATA indexes.** Test that an attestation under the (empty) DATA schema is accepted by `onAttest` and indexed, with `data.length == 0`. Run: FAIL.
- [ ] **Step 3.3 — update onAttest DATA branch.** In `EFSIndexer.onAttest`, the DATA branch no longer decodes `(bytes32 contentHash, uint64 size)`; it indexes the bare DATA UID. Remove the `dataByContentKey` write from the DATA path. Keep `dataByContentKey` mapping declared (advisory; now written — if at all — by the Phase-7 property-index hook, not the DATA path) to preserve storage order. Re-run 3.2: PASS.
- [ ] **Step 3.4 — grep for orphaned decoders.** `grep -rn "contentHash\|dataByContentKey" contracts/ packages/nextjs/` — fix or AGENT-NOTE every consumer (router upload flow doc, FileView). Show the grep output in the commit body (Etched discipline).
- [ ] **Step 3.5 — run full indexer + router suite.** PASS. Commit.

---

## Phase 4 — REDIRECT schema + `AliasResolver`

**Files:** Create `contracts/AliasResolver.sol`; Test `test/AliasResolver.test.ts`.

- [ ] **Step 4.1 — failing tests (write all guards first).** In `test/AliasResolver.test.ts`: (a) `sameAs` with source+target both DATA → accepted; (b) `target == 0` → revert; (c) `target == refUID` (self-loop) → revert; (d) `symlink` (kind=2) with non-Anchor source → revert; (e) unknown `kind` (e.g. 99) → recorded but `followable()` view returns false; (f) revoke a redirect → onRevoke succeeds. Run: FAIL.
- [ ] **Step 4.2 — implement AliasResolver** extending `EFSUpgradeableResolver`, schema `"bytes32 target, uint16 kind"`. `initialize` stores the EAS-registered REDIRECT schema UID + `owner`. `onAttest` decodes `(bytes32 target, uint16 kind)`, reads `refUID` (the source) from the attestation, enforces guards per `kind` (0=sameAs/1=supersededBy require source+target DATA; 2=symlink requires source Anchor; ≥3 recorded, not auto-followed). Optional advisory `_aliasesByTarget` reverse index in ERC-7201 storage. Re-run 4.1: PASS.
- [ ] **Step 4.3 — commit** (`Permanence-tier: Etched`, `Refs: ADR-0050`).

> **Note:** read-time multi-hop cycle/chain resolution is NOT in the resolver — it's the client/router resolution spec (Phase 7 doc + conformance vectors). The resolver only does write-time guards.

---

## Phase 5 — resolver-logic fixes (write-time-practicality findings)

- [ ] **Step 5.1 — MIRROR URI allowlist.** In `MirrorResolver`, replace `_isAllowedScheme`'s hard reject with either removal or a widened set (add `ftp`, `s3`, `gs`, `bittorrent`/infohash, `dat`). Decision: widen, since scheme safety is a client-render concern (ADR-0023 supersede note). Failing test first (an `s3://` mirror is accepted), then implement, then PASS. Update ADR-0023 (supersede) + `specs/02` §Mirror. Commit.
- [ ] **Step 5.2 — ANCHOR name canonical encoding.** Define the canonical encoding in `specs/02` §1 (NFC + percent-encode the reserved byte set) and enforce/normalize in `EFSIndexer._isValidAnchorName`. Failing test (`"Q&A: Episode 5"` round-trips deterministically), implement, PASS. Update ADR-0025 (supersede). Commit.

---

## Phase 6 — deploy pipeline rewrite (CREATE3 proxies, register-last)

**Files:** Create `deploy/lib/schemas.ts`, `deploy/lib/create3.ts`; rewrite `deploy/01_indexer.ts`, `04_sortoverlay.ts` (skip-register), `05_mirrors.ts`, `09_lists.ts`, + new `deploy/0X_redirect.ts`; Test `test/GoldenVectors.test.ts`.

- [ ] **Step 6.1 — single-source schema strings.** `deploy/lib/schemas.ts` exports each field string + revocable. Make `ListEntryResolver.sol`'s `LIST_ENTRY_DEFINITION` the canonical Solidity copy and assert byte-equality in the golden-vector test (Step 6.2). Remove BLOB/NAMING from the set.
- [ ] **Step 6.2 — golden-vector test.** `test/GoldenVectors.test.ts`: for each schema, assert `solidityPackedKeccak256(["string","address","bool"],[fieldString, proxyAddr, revocable])` equals (a) the contract's self-derived UID where applicable (ListEntry), and (b) the UID registered in EAS after deploy. Also assert the Solidity `LIST_ENTRY_DEFINITION` constant == `schemas.ts` LIST_ENTRY string. Run: FAIL (deploy not rewritten). 
- [ ] **Step 6.3 — CREATE3 deploy helper.** `deploy/lib/create3.ts`: `deployProxyCreate3(implFactory, salt, initCalldata, owner)` → deploys impl (non-deterministic), then via CreateX `deployCreate3AndInit` deploys a `TransparentUpgradeableProxy(impl, owner, initCalldata)` at the salt-derived address **and initializes in one tx**; asserts `realizedAddr == predictedAddr`; returns the proxy address. Pin salts as committed constants.
- [ ] **Step 6.4 — rewrite deploy ordering** to: (1) deploy all impls; (2) for each resolver, compute predicted proxy addr from (CreateX, salt) → compute schema UID off-chain → `deployProxyCreate3` (deploy+init atomic); (3) **verify gate** (`deploy/lib/verify.ts`): realized==predicted, `initialize` reverts on 2nd call, impl `initialize` reverts, ListEntry self-UID==computed UID, `wireContracts`/`setTransportsAnchor` set; (4) **register schemas last** with `resolver = proxy`, assert `schemaRegistry.getSchema(uid).resolver == proxy` and no prior conflicting registration; (5) wire partners; (6) **live smoke**: one attestation through every schema (onAttest no revert) + one revoke through each revocable schema. SORT_INFO/BLOB/NAMING registration removed.
- [ ] **Step 6.5 — run golden-vector + full suite on the pinned fork.** `yarn deploy` then `git diff --exit-code packages/nextjs/contracts/deployedContracts.ts` (ADR-0037 pin). Re-run 6.2: PASS. Commit.

---

## Phase 7 — conventions, Sepolia freeze, round-trip

- [ ] **Step 7.1 — content-hash preimage spec + reference vectors.** Write `specs/09-content-identity-conventions.md`: canonical preimage ("raw flat file bytes, no DAG framing"), multibase/multicodec encoding for `contentHash`/`cid`/`hash:*`, with reference test vectors. (Durable.)
- [ ] **Step 7.2 — redirect resolution spec + conformance vectors.** Write `specs/10-redirect-resolution.md`: lens precedence, depth cap `D_MAX`, cycle → lowest-UID-in-SCC, which kinds auto-follow, tiebreak. Add conformance vectors. (Durable; must precede durable seeding.)
- [ ] **Step 7.3 — deploy to Sepolia; fill the freeze table.** Run the Phase-6 pipeline against Sepolia; fill `docs/SEPOLIA_FREEZE_TABLE.md` with realized proxy addresses + computed UIDs + bytecode hashes (the FREEZE_LEDGER). **STOP — human gate: James signs the table.** (Tier-1; do not register seed-data schemas until signed.)
- [ ] **Step 7.4 — round-trip proof.** `test/Freeze.e2e.test.ts` + a live script: create an anchor → DATA → contentHash PROPERTY → PIN (place at path) → MIRROR → read it back through `EFSFileView`/`EFSRouter`. Create a LIST + LIST_ENTRY, read back. Create a REDIRECT (sameAs) between two DATA, resolve it client-side. Commit the evidence.

---

## Out of scope (separate, later)
- **Burn-to-immutable** — its own runbook + ≥14-day soak + full invariant suite + mainnet-fork dry run, then `ProxyAdmin.renounceOwnership()`. Pre-burn checklist already in `docs/SEPOLIA_FREEZE_TABLE.md`.
- **On-chain property index** (find-by-hash) — resolver logic, upgradeable, frozen at burn; its own ADR.
- **General typed-edge / EVENT primitive**, signature-PROPERTY for authenticity (#7) — additive, future ADRs.

---

## Verification gates (must pass before the next phase)
1. Phase 1–2: every existing test passes with resolvers behind proxies; impl `initialize` reverts; init-lock holds.
2. Phase 2.9–2.10: ListEntry self-UID == proxy-derived UID (the single most dangerous bug).
3. Phase 6: golden-vector parity (string↔UID); `deployedContracts.ts` pin holds; live smoke through all 9 schemas.
4. Phase 7: human-signed freeze table BEFORE registration; round-trip green.
5. CI: storage-layout `validateUpgrade` gate on every resolver change; `deploy-pin-check`.

## Self-review notes (for human + AI reviewers — attack these)
- **EAS base + Initializable interaction:** is keeping `_eas` a constructor-immutable while everything else is initializer-set actually safe across an upgrade? (Each new impl must re-supply the same EAS; the verify gate asserts `proxy.getEAS() == EXPECTED`.) Confirm no OZ-v5 `Initializable` storage collides with EAS base (base has no storage — confirmed).
- **CreateX availability** on Sepolia (and intended mainnet) at the canonical address; behavior if absent. zkSync-class chains excluded from parity.
- **DATA reshape ripple:** every `contentHash`/`dataByContentKey` consumer in contracts + nextjs + the production client (separate repo — can't grep here; flag for James). Does removing the inline hash break the upload flow doc (`overview.md` step 2)?
- **Storage-layout discipline:** ERC-7201 structs are append-only; the *existing* mappings must not move. Is moving immutables → a namespaced struct truly non-colliding with the pre-existing sequential storage? (ERC-7201 namespaced slots are derived away from slot 0, so yes — but `validateUpgrade` must confirm on the first proxied deploy.)
- **REDIRECT kind taxonomy** is logic, not frozen — but is `uint16` + the initial {0,1,2,3} the right starting set? (See ADR-0050 Alternatives considered.)
- **Scope:** is Phase 3 (DATA reshape) safe to land in the same PR train as the proxy refactor, or should it be its own Etched PR (WIP-limit = one Etched PR per subsystem)? Recommend: DATA reshape lands first/separately, then proxy refactor, then REDIRECT.
