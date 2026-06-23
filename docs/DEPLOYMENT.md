# EFS Deployment Plan & Runbook (Sepolia → mainnet-forward)

**Status:** Plan. Execution is **human-gated** — James signs the FREEZE_LEDGER before any schema is registered. **Nothing is irreversible until registration.**
**Owner of freeze + upgradability + deploy:** the schema-freeze agent line.
**Governing decisions:** ADR-0048 (freeze set + proxy/burn), ADR-0049 (empty DATA), ADR-0050 (REDIRECT), ADR-0037 (pinned fork), `docs/SEPOLIA_FREEZE_TABLE.md`. (Background: the schema-freeze deployment blueprint + build-plan/critique/review artifacts were moved to the planning vault — `efs-project/planning` → `Reviews/2026-06-02-*.md` — as transient build-process records.)

This runbook produces a **mainnet-forward** Sepolia deployment: the Sepolia structure _is_ the mainnet structure (same CREATE3 addresses ⇒ same schema UIDs), so seed data persists and Sepolia→mainnet is a redeploy + re-attestation, not a rewrite.

---

## 0. What gets deployed

- **6 resolver implementations** (non-deterministic addresses; not in any UID): EFSIndexer, EdgeResolver, MirrorResolver, ListResolver, ListEntryResolver, AliasResolver.
- **7 CREATE3-deterministic contracts** — these addresses ARE baked into the schema UIDs (for the 6 resolvers) or into the system bootstrap (for SystemAccount) and are permanent:
  - **6 Transparent proxies** for the schema resolvers: EFSIndexer, EdgeResolver, MirrorResolver, ListResolver, ListEntryResolver, AliasResolver. Each has its own `ProxyAdmin`.
  - **1 SystemAccount proxy** (Transparent, CREATE3-deterministic): the neutral system write-identity (ADR-0053). Has its own `ProxyAdmin`. Separate from the resolver proxies; its burn requires additional verification (see burn checklist).
- **3 stateless views** (redeployable, in no UID): EFSRouter, EFSFileView, ListReader.
- **9 EAS schemas** registered against the proxy addresses: ANCHOR, PROPERTY, DATA(empty), PIN, TAG, MIRROR, LIST, LIST_ENTRY, REDIRECT. (SORT_INFO + EFSSortOverlay are **deferred**, added later additively.)

---

## 1. Keys & roles — the Safe best-practice (your "JamesCarnley.eth or EFS.eth" question)

**Two distinct roles — keep them separate:**

| Role                          | Who                                                               | What it does                                                                  | Retains power after deploy?                   |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| **Deployer**                  | a funded **EOA** (`JamesCarnley.eth` or a dedicated deployer key) | sends the deploy + register txs, pays gas                                     | **No** — transfers everything away at the end |
| **Owner / upgrade authority** | the **EFS.eth Safe**                                              | owns every ProxyAdmin + resolver `Ownable` → can upgrade logic (until burned) | **Yes** — this is the permanent authority     |

**Recommended pattern: deploy _from_ the EFS.eth Safe (Safe-native, born-owned).**

The deploy is **deterministic** — every CREATE3 address and schema UID is computable off-chain _before_ any tx (the scaffolding-anchor UIDs are NOT predicted: the bootstrap call threads the real EAS-returned UIDs in memory — FIX 1, PR #24). That lets us precompute the dependency graph and submit it as **Safe MultiSend batches** the Safe executes via `execTransaction` (Batch 1 deploy+wire → verify gate → freeze signing → Batch 2 register+scaffolding → Batch 3 wire transports anchor), rather than read-and-branching between txs. Deploying from the Safe means:

- **The deployer baked into the permanent CREATE3 addresses + the root-scaffolding authorship is the multisig**, not a personal EOA — team-control/provenance traces to EFS.eth.
- **Everything is born owned by the Safe** (each proxy initializes with `owner_ = Safe`; because the Safe is the CreateX caller, the auto-created ProxyAdmins are Safe-owned; `SystemAccount` is Safe-owned and authors the scaffolding as the Safe executes the single `SystemAccount.bootstrap(...)` call). **So the ownership-transfer phase disappears** — no hot key ever holds the nascent system.
- **Safe-keyed addresses:** when the Safe calls CreateX, `msg.sender = the Safe`, so the CREATE3 permissioned-salt guard mixes the Safe address. The realized proxy addresses (hence the schema UIDs baked against them) are **Safe-keyed** — different from EOA-deployed addresses; that's intended, the canonical addresses are now keyed to the Safe. The salt VALUES are unchanged (frozen); only the realized address for a given salt moves.

The flow is **three** Safe batches around the freeze gate: **Batch 1 (pre-gate)** = CreateX proxy deploys (atomic init, born Safe-owned) + `EFSIndexer.wireContracts`; then a read-only **verify gate** runs against the now-on-chain Safe-keyed proxies (mirroring the EOA path — throws before any registration on drift); the **human signs the freeze table** after the verify gate passes; **Batch 2 (post-gate)** = register the 9 schemas LAST + author the whole scaffolding tree through **one** `SystemAccount.bootstrap(...)` call (threads the real EAS-returned UIDs in memory — no off-chain prediction) + `SystemAccount.seal()` as the last leg; **Batch 3 (post-gate)** = `MirrorResolver.setTransportsAnchor(<realized /transports UID>)`, fed the real `/transports` UID read back from the index after Batch 2. The owner(s) execute via Safe{Wallet} or a Safe-SDK script (the in-repo builder drives the canonical Safe v1.4.1 MultiSend directly; see §4).

**Fallback pattern (industry-standard, simpler): deploy from the EOA, transfer ownership to the Safe.**

> For local/devnet, a fork-without-Safe, or any environment where standing up the Safe execution is overkill, the **deployer EOA** runs the script and its **last actions transfer every `ProxyAdmin` owner and every resolver `Ownable` owner to the EFS.eth Safe**. The EOA ends with zero authority; the Safe is the upgrade key from that moment. This is how OZ Defender / most protocols do it, and it remains fully supported (`deploy:efs` without `--via-safe`). Trade-off: the EOA briefly holds the nascent system before the transfer, and the canonical addresses are keyed to the EOA, not the Safe.
>
> **Public-network restriction (PR #24 P1):** the EOA path registers schemas and creates the root in _separate_ txs, so on a real public network there is a mempool window between ANCHOR registration and `SystemAccount.bootstrap` where a front-runner could attest the first generic ANCHOR and become the canonical root (`EFSIndexer` accepts the first generic anchor as root). The EOA register/bootstrap step is therefore **gated to the trusted operator forks** — the local/CI pinned fork (chainId `31337`) and the devnet VPS (anvil `--chain-id 26001993`, ADR-0062), both of which are single-operator nodes with no public mempool. On real Sepolia/mainnet you **must** use the Safe-native ceremony above (`EFS_DEPLOY_VIA_SAFE=1`), whose Batch 2 registers + bootstraps atomically in one MultiSend, leaving no window. The EOA path can still deploy+wire (`--until-freeze-gate`) anywhere.

**Why the Safe as owner is the _right_ posture** (and supersedes the earlier "simple single-admin EOA" assumption): the upgrade authority is a multisig you control — no single hot key can rewrite resolver logic behind a "permanent" schema. It directly satisfies the PM's "who holds the keys + guardrails" requirement, the good way. The eventual **burn** is then a deliberate Safe transaction.

**After deploy, the Safe does three kinds of things (via Safe{Wallet} UI or a Safe-SDK script):**

1. **Upgrade a resolver** (dev iteration): `ProxyAdmin.upgradeAndCall(proxy, newImpl, data)` — proposed in the Safe, signed, executed.
2. **Nothing** (steady state): the Safe just holds the keys.
3. **Burn to immutable** (pre-mainnet, after soak): `ProxyAdmin.renounceOwnership()` per proxy is **not sufficient on its own** — `ProxyAdmin` only controls upgrades, so a contract's own `OwnableUpgradeable` owner (its privileged setters / module authorization) survives a proxy-only burn and leaves the Safe with live authority over a nominally "frozen" contract. The full burn ALSO calls `SystemAccount.sealModules()` (before burning, verify `modulesSealed() == true`) and `EFSIndexer.renounceOwnership()` + `MirrorResolver.renounceOwnership()` + `SystemAccount.renounceOwnership()`. **Follow the authoritative pre-burn + burn checklist in §4 (and `docs/SEPOLIA_FREEZE_TABLE.md`)** — do not treat this one-line summary as the procedure. Logic frozen forever; address/UID/data intact.

**Cross-chain parity (nice-to-have):** the CREATE3 proxy address depends only on `(CreateX factory, salt, caller)`. For _identical_ Sepolia↔mainnet addresses (⇒ identical schema UIDs), deploy with the **same caller + same salts** on both chains (CreateX permissioned salts mix the sender). On the Safe-native path the **caller is the Safe**, so use the **same Safe address** on both chains (deterministic Safe deployment via the canonical SafeProxyFactory makes this achievable). On the EOA fallback, use the same deployer EOA. (If you don't need parity, any caller works; Sepolia data persists on Sepolia regardless.)

---

## 2. Prerequisites (before running the deploy)

- [ ] **Deployer EOA funded** with Sepolia ETH. Import via the Scaffold-ETH flow: `cd packages/hardhat && yarn account:import` (encrypts the key into `.env` as `DEPLOYER_PRIVATE_KEY_ENCRYPTED`; decrypted at deploy with a password you hold). Use `JamesCarnley.eth` or `yarn generate` a fresh deployer.
- [ ] **RPC**: the Scaffold-ETH default Alchemy key (already in `hardhat.config.ts`) works; or set your own `ALCHEMY_API_KEY` / `SEPOLIA_FORK_RPC_URL` in `.env`.
- [ ] **EFS.eth Safe address** on Sepolia — the ownership transfer target.
- [ ] **CreateX factory live** on the target chain — confirmed present on Sepolia at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` (verified). Same canonical address on mainnet.
- [ ] **The 9 frozen field strings** match `docs/SEPOLIA_FREEZE_TABLE.md` exactly (golden-vector test green).

---

## 3. The deploy sequence (the ceremony — order is load-bearing)

Run on a **pinned fork first** (rehearsal), then Sepolia. Two paths produce the same end state (a Safe-owned, frozen foundation); the Safe-native path is recommended.

### 3a. Safe-native flow (recommended) — three Safe MultiSend batches, born-owned

The deploy is precomputed off-chain and submitted as **owner-signed MultiSend batches** the Safe executes — **Batch 1** (deploy + wire), then a read-only **verify gate** and the freeze-table signing, then **Batch 2** (register + scaffolding) and **Batch 3** (wire the transports anchor). There is **no transfer phase** — everything is born owned by the Safe. (`deploy-lib/safePlan.ts` precomputes; `deploy-lib/safe.ts` builds the batches; `deploy-lib/orchestrateSafe.ts` executes + asserts; `deploy:efs --via-safe` is the front door.)

0. **Precompute** (off-chain, no tx): the 7 Safe-keyed CREATE3 proxy addresses (6 resolvers + `SystemAccount`) and the 9 schema UIDs (keyed against the Safe-keyed proxies). Deploy the resolver impls from a funded EOA (non-deterministic, in no UID). **No scaffolding-anchor UID is predicted off-chain** — the bootstrap call threads each child's `refUID` from the parent UID the prior `EAS.attest` returned in the same call (FIX 1, PR #24), so the scaffolding UIDs are simply whatever EAS returns and are read back from the index afterward.
1. **🅑 BATCH 1 (pre-gate):** the Safe executes a MultiSend of: 7× CreateX `deployCreate3` (each proxy initialized atomically with `owner_ = Safe` → born Safe-owned ProxyAdmins) + `EFSIndexer.wireContracts(...)` (pure storage, no EAS call). Assert each proxy at its Safe-keyed predicted address with code, ProxyAdmin owner == Safe.
2. **🔒 VERIFY GATE** (read-only; same checks as 3b step 3, run against the now-on-chain Safe-keyed proxies — `runVerifyGate` in `deploy-lib/verify.ts`, the SAME gate the EOA path runs): realized == predicted; initializer locked (proxy 2nd call + impl-direct revert); self-UID getters (`ListEntryResolver.listEntrySchemaUID()` / `AliasResolver.redirectSchemaUID()`) == computed Safe-keyed UID; `getEAS()` == EAS; golden-vector field strings. **Throws before Batch 2 on any drift** — no permanent schema is registered against an unverified Safe-keyed proxy. It is idempotent (read-only), so a resume re-runs it harmlessly; it always runs at least once before the first register.
3. **🔒 FREEZE GATE (HUMAN):** after the verify gate passes, fill + sign `docs/SEPOLIA_FREEZE_TABLE.md` with the Safe-keyed addresses/UIDs + the Batch-1/2/3 SafeTx hashes. _No schema is registered before this signature._ The batches are independent Safe txs, so the human signs after Batch 1 + verify gate and before Batch 2.
4. **🅑 BATCH 2 (post-gate):** the Safe executes a MultiSend of: 9× `SchemaRegistry.register(field, proxy, revocable)` (register LAST) + **one** `SystemAccount.bootstrap(indexer, ANCHOR_UID, specs[])` call authoring the WHOLE scaffolding tree — root → (tags, transports) under root; then all **11** `/transports/*` children (onchain, ipfs, arweave, magnet, https, ftp, s3, gs, dat, rsync, bittorrent — every scheme `MirrorResolver._isAllowedScheme` accepts) — threading each child's `refUID` from the parent UID the prior `EAS.attest` returned in the same call (timestamp-robust, no off-chain prediction; attester == `SystemAccount`, executed by the Safe as its owner) + `SystemAccount.seal()` as the LAST leg (PR #24 P1: permanently locks the owner's one-time bootstrap write authority — the steady-state relay becomes module-only). Register-then-author preserves the ordering: the anchors are attestations EAS rejects until the ANCHOR schema is registered. `setTransportsAnchor` is NOT in this batch — the realized `/transports` UID isn't known until bootstrap runs.
5. **🅑 BATCH 3 (post-gate):** read the realized `/transports` UID back from the index (`indexer.resolvePath(root, "transports")`), then the Safe executes `MirrorResolver.setTransportsAnchor(thatUID)` (owner-gated; the Safe is the born owner). Separate from Batch 2 because the UID is only known after the bootstrap call has run.
6. **ASSERT born-owned + scaffolding present:** every ProxyAdmin + `Ownable` resolver + `SystemAccount` owner == Safe; the deployer EOA holds nothing; **no transfer step ran**; `SystemAccount.bootstrapSealed()` == true; the scaffolding tree is present + correctly parented (root non-zero; every `/transports/*` child resolves under `/transports`) — read back from the index, not asserted against an off-chain prediction.
7. **Views + pin** as in 3b steps 8–9 (the views are NON-FROZEN, deployed post-freeze; the Safe-native rehearsal does NOT regenerate `deployedContracts.ts` — the pin stays the EOA-fork artifact).

**Idempotent resume.** Each batch is guarded so a re-run after a partial/complete deploy is a clean no-op rather than a revert: **Batch 1** is SKIPPED if the proxies already exist (the `EFSIndexer` proxy has code) and the indexer is already wired to the Safe-keyed `EdgeResolver`; **Batch 2** OMITS each already-registered schema's `register` leg (EAS register is not idempotent — re-including reverts `AlreadyExists`) and OMITS the `bootstrap` + `seal` legs once `SystemAccount.bootstrapSealed()` is true (they would revert `BootstrapSealed`), so a fully-registered+sealed system yields an empty Batch 2; **Batch 3** is SKIPPED if `MirrorResolver.transportsAnchorUID()` is already set (asserting it equals the realized `/transports` UID first). The verify gate is read-only and re-runs harmlessly on a resume.

The 3b EOA sequence below is the simpler fallback and remains fully supported. Both register the schemas LAST and end Safe-owned; the difference is _who_ sends the txs and whether ownership is born-with or transferred.

### 3b. EOA-then-transfer flow (fallback)

The Phase-D deploy script automates steps 1–4 and 6–8; step 5 is the human gate.

1. **Deploy the 6 resolver implementations** (any addresses).
2. **Deploy the 6 Transparent proxies via CreateX `deployCreate3` at salt-derived addresses, and `initialize` each atomically** (init in the proxy-creation tx, or immediately after with a same-tx guard). Each proxy gets its own `ProxyAdmin`. Initialize wires each resolver's config (schema UIDs, partner refs, and the self-derived UID for ListEntry/Alias — where `address(this)` is now the proxy). Compute each schema UID off-chain as `keccak256(fieldString, proxyAddr, revocable)`.
3. **VERIFY GATE** (abort on any failure — `deploy-lib/verify.ts`):
   - realized proxy addr == CREATE3-predicted addr (per resolver);
   - `initialize` is locked (2nd call reverts) and the **implementation's** `initialize` reverts (`_disableInitializers`);
   - **read each resolver's on-chain self-UID getter** (`ListEntryResolver.listEntrySchemaUID()`, `AliasResolver.redirectSchemaUID()`) and assert it == `keccak256(fieldString, realizedProxyAddr, revocable)` == the UID about to be registered (the ListEntry-class bug guard);
   - `proxy.getEAS() == EXPECTED_EAS` for the chain;
   - golden-vector: contract field-string constants == `deploy-lib/schemas.ts` (no UID drift);
   - storage-layout snapshot matches.
4. **Wire partners (pre-gate, storage-only)**: `EFSIndexer.wireContracts(...)` — pure storage, no EAS call, so it is safe before any schema is registered. (No SORT_INFO wiring — deferred.) The `/transports/*` anchors and `MirrorResolver.setTransportsAnchor(...)` are **not** done here: they require the ANCHOR schema to be registered first (an ANCHOR attestation EAS-reverts until then), and the realized `/transports` UID isn't known until bootstrap runs — so both move to the post-register step 6. (`orchestrate.ts` does exactly this: the only pre-gate wiring is `wireContracts`.)
5. **🔒 FREEZE GATE (HUMAN):** fill `docs/SEPOLIA_FREEZE_TABLE.md` (the FREEZE*LEDGER) with realized proxy addresses, computed UIDs, impl+proxy bytecode keccak, salts, factory, EAS+registry+chainId. **James reviews and signs.** \_No schema is registered before this signature.*
6. **Register the 9 schemas LAST** in EAS, `resolver = proxy`. Assert `getSchema(uid).resolver == proxy` and no conflicting prior registration. (Registration is cheap, idempotent — `AlreadyExists` reverts harmlessly.) **Then author the scaffolding** (now that ANCHOR exists): one `SystemAccount.bootstrap(indexer, ANCHOR_UID, specs)` call writes root → `/transports/*` followed by `SystemAccount.seal()`, then `MirrorResolver.setTransportsAnchor(...)` binds the realized `/transports` UID read back from the index. This is the wiring that step 4 deferred — it cannot run earlier because ANCHOR attestations EAS-revert until the schema is registered and the `/transports` UID isn't known until bootstrap runs. (On real networks this register→bootstrap path is Safe-batch-only, EOA-disallowed — see `orchestrate.ts` front-run guard; §3a runs it as Batch 2 + Batch 3.)
7. **Transfer ownership to the EFS.eth Safe**: every `ProxyAdmin.transferOwnership(SAFE)` + every resolver `Ownable.transferOwnership(SAFE)` (EFSIndexer, MirrorResolver). Assert each `owner() == SAFE` and the deployer EOA holds nothing.
8. **Live smoke + pin**: push one real attestation through _every_ schema (onAttest no revert + expected index written) + one revoke per revocable schema; regenerate + commit `packages/nextjs/contracts/deployedContracts.ts`; confirm `git diff --exit-code` (ADR-0037 pin holds).
9. **Deploy the read views (NON-FROZEN, post-freeze):** deploy the three stateless views — **EFSFileView, EFSRouter, ListReader** — against the proxy addresses + frozen schema UIDs from steps 2/6. These are in **no schema UID** and are **freely redeployable** (specs/overview.md "Core contracts"): re-running redeploys-or-no-ops, and you can redeploy them anytime (e.g. a view bugfix, a new lens feature) **without touching the freeze** — the frozen foundation and all attestations are unaffected. Run with `yarn deploy:efs-views` (the `EFSViews` tag → `deploy/10_efs_views.ts`), which binds to the proxies via the `Indexer` / `EdgeResolver` / `ListEntryResolver` named deployments that step 2 saved, reads the now-frozen UIDs off the proxies (`indexer.DATA_SCHEMA_UID()` etc.), and fails clearly if the core (steps 1–7) hasn't run. This step is **outside the freeze ceremony** — `deploy:efs` (steps 1–8) never deploys the views; `deploy:efs-views` never registers a schema or redeploys a proxy.

**Rollback:** if any step ≤4 fails, **halt before the freeze gate**, capture the failing resolver/check, and on a clean network wipe + redeploy from the salts. Never register against an unverified proxy. Post-registration, the schemas are permanent — there is no rollback, only a new schema (which orphans data); that's why step 5 is human-gated.

---

## 4. How James runs it (once the Phase-D script lands)

**Safe-native (recommended) — deploy FROM the EFS.eth Safe, born-owned:**

```bash
cd packages/hardhat
# 1. one-time: fund a gas-paying EOA (gas only — authority is the Safe owner signatures)
yarn account:import                       # a funded deployer EOA (gas)
# 2a. MECHANISM REHEARSAL (no EFS_SAFE_ADDRESS): exercises the full two-batch born-owned flow end to
#     end against a 1-of-1 test Safe the task DEPLOYS automatically. Because that test Safe's single
#     owner IS a local signer, the task SELF-EXECUTES (mode "execute") and runs the full born-owned
#     assertions. This is the "does the ceremony work?" rehearsal — it does NOT use the real Safe.
yarn deploy:efs --via-safe --network hardhat
#    (or run the mechanism rehearsal directly:
#     MAINNET_FORKING_ENABLED=true npx hardhat test test/DeploySafe.fork.test.ts --network hardhat)
# 2b. REAL-SAFE FORK PRE-FLIGHT (with the real EFS_SAFE_ADDRESS exported): a supplied real Safe is NOT
#     owned by any local signer — even on the fork — so the task runs in BUILD/PROPOSE mode (PR #24 P2):
#     it emits deployments/hardhat/safe-batches.json + the REAL Safe-keyed predicted addresses / freeze-
#     table values to review, and does NOT self-execute (no fabricated signatures, no revert). This is
#     the useful "what will the real ceremony produce?" pre-flight — distinct from the 2a mechanism
#     rehearsal (which deploys + self-executes a throwaway test Safe).
EFS_SAFE_ADDRESS=0x...EFS.eth Safe... yarn deploy:efs --via-safe --network hardhat
# 3. on real Sepolia/mainnet: the deployer EOA has NO Safe-owner keys, so the task runs in
#    BUILD/PROPOSE mode — it does NOT self-execute (a non-owner EOA can't sign the Safe; self-signing
#    would revert Batch 1). Propose mode is PHASE-AWARE (PR #24 P1): each invocation detects the
#    current on-chain phase and writes deployments/<net>/safe-batches.json holding ONLY the NEXT
#    pending batch (its {to, value, data, operation}, the Safe nonce + SafeTx hash to sign) — never a
#    duplicate of an already-landed batch. So you RE-RUN the task once per batch, executing each in
#    Safe{Wallet} / the Safe Tx Service before re-running for the next. The cycle:
#
#      run `--via-safe`  →  emits Batch 1 (deploy + wire)
#         → propose + sign + execute Batch 1 in Safe{Wallet}
#      RE-RUN `--via-safe`  →  Phase 1: runs the VERIFY GATE automatically (read-only; aborts on any
#                              drift) against the now-live Safe-keyed proxies, BEFORE emitting Batch 2;
#                              on pass it emits Batch 2 (register-last + one SystemAccount.bootstrap
#                              + seal)
#         → FREEZE GATE (human): review the emitted realized addresses/UIDs + freeze table, sign
#           docs/SEPOLIA_FREEZE_TABLE.md (no schema is registered before this signature), then
#           propose + sign + execute Batch 2 in Safe{Wallet}
#      RE-RUN `--via-safe`  →  Phase 2: reads the realized /transports UID back from the index and
#                              emits Batch 3 (MirrorResolver.setTransportsAnchor)
#         → propose + sign + execute Batch 3 in Safe{Wallet}
#      RE-RUN `--via-safe`  →  Phase 3: "deploy complete, nothing to propose" (clean no-op).
#
#    Run the command once per arrow above:
yarn deploy:efs --via-safe --network sepolia
#    No transfer phase — everything is born Safe-owned. The verify gate runs automatically at Phase 1
#    (the re-run after Batch 1), before Batch 2 is emitted. Batch 3 is never emitted before Batch 2 has
#    landed (its arg is the realized /transports UID, minted only when Batch 2's bootstrap runs).
#    A supplied real EFS_SAFE_ADDRESS is ALWAYS build/propose — EFS has no raw-keys-in-env
#    self-execute path; you sign + execute each emitted batch in Safe{Wallet}.
# 4. deploy the read views (NON-FROZEN; redeployable anytime, in no UID, outside the freeze)
yarn deploy:efs-views --network sepolia
```

> Note: `yarn deploy:efs --via-safe --network hardhat` runs the full hardhat-deploy pipeline and so
> regenerates `deployedContracts.ts` with the Safe-keyed addresses — do **not** commit that; the
> canonical pin is the EOA/account-0 fork artifact (ADR-0037). Use `git checkout` to restore it, or
> rehearse via `test/DeploySafe.fork.test.ts`, which drives `orchestrateViaSafe` directly and never
> touches the pin.

**EOA-then-transfer (fork / devnet only — NOT for the real Sepolia/mainnet freeze):**

> ⚠️ The EOA register/bootstrap step is **gated to the trusted operator forks — chainId `31337` (local/CI) and `26001993` (devnet VPS, ADR-0062)** (`orchestrate.ts` — front-run safety, PR #24 P1: on a public network there's a mempool window between ANCHOR registration and root bootstrap; both forks are single-operator nodes with no public mempool). So this gated two-phase EOA flow runs only on the **local pinned fork and the devnet VPS** (anvil `--chain-id 26001993`). For the **real Sepolia/mainnet freeze use the Safe-native ceremony above** (`--via-safe`), whose Batch 2 registers + bootstraps atomically. The EOA `--until-freeze-gate` (deploy + wire, no register) is allowed on any network, but `--after-freeze-gate` (register) will hard-fail on any chain other than `31337`/`26001993`.

```bash
cd packages/hardhat
# 1. one-time: import the deployer key (encrypted) + set the Safe address
yarn account:import                       # JamesCarnley.eth or a dedicated deployer
echo "EFS_SAFE_ADDRESS=0x...your Safe..." >> .env
# 2. rehearse the FULL ceremony on the pinned fork (no real txs, full verify + smoke)
yarn deploy:efs --network hardhat         # (Phase-D script; dry-run/fork)
# 3. devnet (anvil --chain-id 26001993, ADR-0062): deploy UP TO the freeze gate (deploys + verifies, STOPS before register)
yarn deploy:efs --network localhost --until-freeze-gate
#    -> review + sign docs/SEPOLIA_FREEZE_TABLE.md
# 4. devnet: register + transfer-to-Safe + smoke (after signing) — 31337/26001993 only; real nets use --via-safe
yarn deploy:efs --network localhost --after-freeze-gate
# 5. deploy the read views (NON-FROZEN; redeployable anytime, in no UID, outside the freeze)
yarn deploy:efs-views --network localhost
```

`deploy:efs` is a real hardhat task (`packages/hardhat/tasks/deployEfs.ts`, run via the `deploy:efs` package script with the encrypted-key flow). It runs **only** the EFS core ceremony (the `EFSCore` tag → `deploy/00_efs_core.ts`), never the downstream/legacy scripts. The flags map to the run mode: `--via-safe` (Safe-native, born-owned, two MultiSend batches — its own flow, not combinable with the gate flags) / `--until-freeze-gate` / `--after-freeze-gate` / (omit all) full EOA-then-transfer. The EOA fork rehearsal `yarn deploy:efs --network hardhat` exercises the full ceremony end-to-end (deploy + verify + wire + register + transfer + per-schema smoke); the Safe fork rehearsal `yarn deploy:efs --via-safe --network hardhat` deploys a 1-of-1 test Safe and exercises the two-batch born-owned flow (also covered by `test/DeploySafe.fork.test.ts`). `EFS_SAFE_ADDRESS` must be set to the real checksummed Safe before `--after-freeze-gate` (EOA path) or before `--via-safe` on a real network (the task hard-fails otherwise — on the EOA path the transfer is single-step and irreversible, see I-5a; on the Safe path the address is the CreateX caller baked permanently into every address/UID).

`deploy:efs-views` is the companion post-freeze task (`packages/hardhat/tasks/deployEfsViews.ts`, run via the `deploy:efs-views` package script with the same encrypted-key flow). It runs **only** the `EFSViews` tag (`deploy/10_efs_views.ts`) — it deploys the three stateless views against the already-registered proxies and **never** registers a schema or redeploys a proxy. The views are in **no UID** and are **freely redeployable**: re-running is safe (redeploy-or-no-op), and you can redeploy them at any later time (view bugfix, new feature) without re-running the freeze ceremony and without affecting any attestation. The fork rehearsal `yarn deploy:efs-views --network hardhat` skips gracefully when CreateX is absent (no foundation present); the full round-trip is exercised by `test/DeployE2E.fork.test.ts` (orchestrate → views → write anchor/DATA/PIN/TAG/MIRROR/LIST/LIST_ENTRY → read it all back through EFSRouter/EFSFileView/ListReader). On local/devnet (no CreateX) the views are deployed by the legacy `02_fileview` / `03_router` / `09_lists` scripts instead — `10_efs_views` only runs where CreateX exists, so the two paths never double-deploy.

**Upgrading a resolver later (from the Safe):** in Safe{Wallet}, propose a tx to `ProxyAdmin.upgradeAndCall(proxy, newImpl, 0x)`; sign; execute. Or script it with `@safe-global/protocol-kit`.

**Burn to immutable (pre-mainnet, after a ≥14-day soak):** the pre-burn checklist is in `docs/SEPOLIA_FREEZE_TABLE.md`; when satisfied, the Safe executes `ProxyAdmin.renounceOwnership()` per proxy — all **7** proxies (6 resolver proxies + SystemAccount proxy). **The contract-owner vs ProxyAdmin distinction (PR #24 50yr-review):** each proxied contract has two independent owners — its external ProxyAdmin (controls upgrades) and, where the logic is `Ownable`/`OwnableUpgradeable`, the contract's own owner (controls its setters). `ProxyAdmin.renounceOwnership()` does NOT zero the contract-owner; both must be renounced or the Safe retains live authority over a nominally "frozen" contract. So the burn also calls **`EFSIndexer.renounceOwnership()`** and **`MirrorResolver.renounceOwnership()`** — the two `OwnableUpgradeable` resolvers. This is load-bearing for EFSIndexer: its one-shot `setSortsAnchor(...)` is never set in this freeze (SORT_INFO deferred), so until the kernel owner is renounced a post-burn Safe could weld a permanent value into the immutable kernel. (EdgeResolver/ListResolver/ListEntryResolver/AliasResolver have no owner — config is `initialize()`-only — so they need no renounce.) For SystemAccount specifically: (1) call `SystemAccount.sealModules()` **before** burning, verify `SystemAccount.modulesSealed() == true` (permanently prevents any new system-writer module from being authorized post-burn — ADR-0053 "pre-burn only" membership); (2) burn its ProxyAdmin like the others; and (3) call `SystemAccount.renounceOwnership()` to zero its own `OwnableUpgradeable` owner. Post-burn verify `EFSIndexer.owner()==0`, `MirrorResolver.owner()==0`, `SystemAccount.owner()==0` (+ every ProxyAdmin), and that `setSortsAnchor`/`upgradeAndCall` now revert. Address + UID + data unchanged; logic frozen forever.

---

## 5. Status / what's built vs TODO

- ✅ **Schema + contract layer** (this PR): 9 schemas finalized; all 6 resolvers upgradeable behind the `EFSUpgradeableResolver` base; storage-layout verified + upgrade-with-state guard; suite 429/0; independently reviewed.
- ✅ **CreateX confirmed live on Sepolia**; ✅ key-custody decided (deploy-EOA → EFS.eth-Safe owner).
- ✅ **Safe-native deploy path** (`deploy-lib/{safe,safePlan,orchestrateSafe}.ts` + `deploy:efs --via-safe` / `EFS_DEPLOY_VIA_SAFE=1`) — deploy the whole system _from_ the EFS.eth Safe as owner-signed MultiSend batches (Batch 1 born-Safe-owned proxy deploys + wire; verify gate; freeze-table signing; Batch 2 register-last + one `SystemAccount.bootstrap` + `seal`; Batch 3 `setTransportsAnchor`), **born owned by the Safe so the transfer phase disappears**. Safe-keyed CREATE3 addresses (the Safe is the CreateX caller). Drives the canonical on-chain Safe v1.4.1 MultiSend directly (no `@safe-global/protocol-kit` runtime dep). Fork-rehearsed by `test/DeploySafe.fork.test.ts` against a real Gnosis Safe stood up on the pinned fork (7 proxies at Safe-keyed predicted addresses, the verify gate runs before Batch 2, 9 schemas registered, ProxyAdmins + resolvers + `SystemAccount` all born Safe-owned + sealed, scaffolding authored by `SystemAccount` with the realized UIDs read back from the index). The EOA-then-transfer path is retained as the simpler fallback.
- ✅ **Phase-D deploy script** (`deploy-lib/{schemas,create3,verify,orchestrate,superseded}.ts` + the `deploy:efs` task) — implements steps 1–4, 6–8 above; fork-rehearsable on the pinned fork without real keys. The Sepolia surface is the **EFS core only** (the `EFSCore` tag): the downstream/legacy scripts (01–06, 09) are neutralized wherever CreateX is present and are now a **local/devnet-only** concern — they are _not_ part of the Sepolia deploy (the stateless views EFSRouter/EFSFileView/ListReader are redeployed separately post-freeze, outside this ceremony).
- ✅ **Post-freeze read-views deploy** (`deploy/10_efs_views.ts` + `deploy-lib/views.ts` + the `deploy:efs-views` task) — the NON-FROZEN view layer (EFSFileView, EFSRouter, ListReader; in no UID, freely redeployable). Binds to the proxies + frozen UIDs registered by the core; runs only where CreateX is present (so it never double-deploys with the local/devnet `02`/`03`/`09` path); idempotent re-run. Full round-trip proven on the pinned fork by `test/DeployE2E.fork.test.ts` (frozen foundation → views → write anchor/DATA/PIN/TAG/MIRROR/LIST/LIST_ENTRY → read back through all three views; assertions on returned UIDs/paths/values).
- ⏳ **Resolution-spec + reference vectors** for REDIRECT-following and the content-hash preimage (Durable; must land before durable seed data — ADR-0050/0049 action items).
- 🔒 **Sepolia deploy + freeze** (steps 5–8 on real Sepolia): needs the funded deployer EOA + EFS.eth Safe address + **James's FREEZE_LEDGER signature.**

When the Phase-D script lands and is fork-rehearsed, the foundation is turnkey: James runs the commands in §4, signs the ledger, and Sepolia is live + usable.
