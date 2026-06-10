# EFS Deployment Plan & Runbook (Sepolia → mainnet-forward)

**Status:** Plan. Execution is **human-gated** — James signs the FREEZE_LEDGER before any schema is registered. **Nothing is irreversible until registration.**
**Owner of freeze + upgradability + deploy:** the schema-freeze agent line.
**Governing decisions:** ADR-0048 (freeze set + proxy/burn), ADR-0049 (empty DATA), ADR-0050 (REDIRECT), ADR-0037 (pinned fork), `docs/SEPOLIA_FREEZE_TABLE.md`, `docs/plans/2026-06-02-sepolia-deployment-blueprint.md`.

This runbook produces a **mainnet-forward** Sepolia deployment: the Sepolia structure *is* the mainnet structure (same CREATE3 addresses ⇒ same schema UIDs), so seed data persists and Sepolia→mainnet is a redeploy + re-attestation, not a rewrite.

---

## 0. What gets deployed
- **6 resolver implementations** (non-deterministic addresses; not in any UID): EFSIndexer, EdgeResolver, MirrorResolver, ListResolver, ListEntryResolver, AliasResolver.
- **6 Transparent proxies (CREATE3-deterministic)** — these addresses ARE baked into the schema UIDs and are permanent. Each has its own `ProxyAdmin`.
- **3 stateless views** (redeployable, in no UID): EFSRouter, EFSFileView, ListReader.
- **9 EAS schemas** registered against the proxy addresses: ANCHOR, PROPERTY, DATA(empty), PIN, TAG, MIRROR, LIST, LIST_ENTRY, REDIRECT. (SORT_INFO + EFSSortOverlay are **deferred**, added later additively.)

---

## 1. Keys & roles — the Safe best-practice (your "JamesCarnley.eth or EFS.eth" question)

**Two distinct roles — keep them separate:**

| Role | Who | What it does | Retains power after deploy? |
|---|---|---|---|
| **Deployer** | a funded **EOA** (`JamesCarnley.eth` or a dedicated deployer key) | sends the deploy + register txs, pays gas | **No** — transfers everything away at the end |
| **Owner / upgrade authority** | the **EFS.eth Safe** | owns every ProxyAdmin + resolver `Ownable` → can upgrade logic (until burned) | **Yes** — this is the permanent authority |

**Recommended pattern (industry-standard): deploy from the EOA, transfer ownership to the Safe.**

> Do **not** run the deploy *through* the Safe. Safe-originated deploys mean building the whole sequence as a MultiSend batch, proposing it to the Safe Transaction Service, and collecting confirmations for every step — fragile and slow. Instead: the **deployer EOA** runs the script; its **last actions transfer every `ProxyAdmin` owner and every resolver `Ownable` owner to the EFS.eth Safe**. The EOA ends with zero authority; the Safe is the upgrade key from that moment. This is how OZ Defender / most protocols do it.

**Why the Safe as owner is the *right* posture** (and supersedes the earlier "simple single-admin EOA" assumption): the upgrade authority is a multisig you control — no single hot key can rewrite resolver logic behind a "permanent" schema. It directly satisfies the PM's "who holds the keys + guardrails" requirement, the good way. The eventual **burn** is then a deliberate Safe transaction.

**After deploy, the Safe does three kinds of things (via Safe{Wallet} UI or a Safe-SDK script):**
1. **Upgrade a resolver** (dev iteration): `ProxyAdmin.upgradeAndCall(proxy, newImpl, data)` — proposed in the Safe, signed, executed.
2. **Nothing** (steady state): the Safe just holds the keys.
3. **Burn to immutable** (pre-mainnet, after soak): `ProxyAdmin.renounceOwnership()` per proxy — logic frozen forever, address/UID/data intact.

**Cross-chain parity (nice-to-have):** the CREATE3 proxy address depends only on `(CreateX factory, salt)`. For *identical* Sepolia↔mainnet addresses (⇒ identical schema UIDs), deploy with the **same deployer EOA + same salts** on both chains (CreateX permissioned salts mix the sender). If you deploy Sepolia from `JamesCarnley.eth`, use the same EOA for the mainnet deploy. (If you don't need parity, any deployer works; Sepolia data persists on Sepolia regardless.)

---

## 2. Prerequisites (before running the deploy)
- [ ] **Deployer EOA funded** with Sepolia ETH. Import via the Scaffold-ETH flow: `cd packages/hardhat && yarn account:import` (encrypts the key into `.env` as `DEPLOYER_PRIVATE_KEY_ENCRYPTED`; decrypted at deploy with a password you hold). Use `JamesCarnley.eth` or `yarn generate` a fresh deployer.
- [ ] **RPC**: the Scaffold-ETH default Alchemy key (already in `hardhat.config.ts`) works; or set your own `ALCHEMY_API_KEY` / `SEPOLIA_FORK_RPC_URL` in `.env`.
- [ ] **EFS.eth Safe address** on Sepolia — the ownership transfer target.
- [ ] **CreateX factory live** on the target chain — confirmed present on Sepolia at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` (verified). Same canonical address on mainnet.
- [ ] **The 9 frozen field strings** match `docs/SEPOLIA_FREEZE_TABLE.md` exactly (golden-vector test green).

---

## 3. The deploy sequence (the ceremony — order is load-bearing)

Run on a **pinned fork first** (rehearsal), then Sepolia. The Phase-D deploy script automates steps 1–4 and 6–8; step 5 is the human gate.

1. **Deploy the 6 resolver implementations** (any addresses).
2. **Deploy the 6 Transparent proxies via CreateX `deployCreate3` at salt-derived addresses, and `initialize` each atomically** (init in the proxy-creation tx, or immediately after with a same-tx guard). Each proxy gets its own `ProxyAdmin`. Initialize wires each resolver's config (schema UIDs, partner refs, and the self-derived UID for ListEntry/Alias — where `address(this)` is now the proxy). Compute each schema UID off-chain as `keccak256(fieldString, proxyAddr, revocable)`.
3. **VERIFY GATE** (abort on any failure — `deploy/lib/verify.ts`):
   - realized proxy addr == CREATE3-predicted addr (per resolver);
   - `initialize` is locked (2nd call reverts) and the **implementation's** `initialize` reverts (`_disableInitializers`);
   - **read each resolver's on-chain self-UID getter** (`ListEntryResolver.listEntrySchemaUID()`, `AliasResolver.redirectSchemaUID()`) and assert it == `keccak256(fieldString, realizedProxyAddr, revocable)` == the UID about to be registered (the ListEntry-class bug guard);
   - `proxy.getEAS() == EXPECTED_EAS` for the chain;
   - golden-vector: contract field-string constants == `deploy/lib/schemas.ts` (no UID drift);
   - storage-layout snapshot matches.
4. **Wire partners**: `EFSIndexer.wireContracts(...)`, `MirrorResolver.setTransportsAnchor(...)`; create the `/transports/*` anchors. (No SORT_INFO wiring — deferred.)
5. **🔒 FREEZE GATE (HUMAN):** fill `docs/SEPOLIA_FREEZE_TABLE.md` (the FREEZE_LEDGER) with realized proxy addresses, computed UIDs, impl+proxy bytecode keccak, salts, factory, EAS+registry+chainId. **James reviews and signs.** *No schema is registered before this signature.*
6. **Register the 9 schemas LAST** in EAS, `resolver = proxy`. Assert `getSchema(uid).resolver == proxy` and no conflicting prior registration. (Registration is cheap, idempotent — `AlreadyExists` reverts harmlessly.)
7. **Transfer ownership to the EFS.eth Safe**: every `ProxyAdmin.transferOwnership(SAFE)` + every resolver `Ownable.transferOwnership(SAFE)` (EFSIndexer, MirrorResolver). Assert each `owner() == SAFE` and the deployer EOA holds nothing.
8. **Live smoke + pin**: push one real attestation through *every* schema (onAttest no revert + expected index written) + one revoke per revocable schema; regenerate + commit `packages/nextjs/contracts/deployedContracts.ts`; confirm `git diff --exit-code` (ADR-0037 pin holds).
9. **Deploy the read views (NON-FROZEN, post-freeze):** deploy the three stateless views — **EFSFileView, EFSRouter, ListReader** — against the proxy addresses + frozen schema UIDs from steps 2/6. These are in **no schema UID** and are **freely redeployable** (specs/overview.md "Core contracts"): re-running redeploys-or-no-ops, and you can redeploy them anytime (e.g. a view bugfix, a new lens feature) **without touching the freeze** — the frozen foundation and all attestations are unaffected. Run with `yarn deploy:efs-views` (the `EFSViews` tag → `deploy/10_efs_views.ts`), which binds to the proxies via the `Indexer` / `EdgeResolver` / `ListEntryResolver` named deployments that step 2 saved, reads the now-frozen UIDs off the proxies (`indexer.DATA_SCHEMA_UID()` etc.), and fails clearly if the core (steps 1–7) hasn't run. This step is **outside the freeze ceremony** — `deploy:efs` (steps 1–8) never deploys the views; `deploy:efs-views` never registers a schema or redeploys a proxy.

**Rollback:** if any step ≤4 fails, **halt before the freeze gate**, capture the failing resolver/check, and on a clean network wipe + redeploy from the salts. Never register against an unverified proxy. Post-registration, the schemas are permanent — there is no rollback, only a new schema (which orphans data); that's why step 5 is human-gated.

---

## 4. How James runs it (once the Phase-D script lands)
```bash
cd packages/hardhat
# 1. one-time: import the deployer key (encrypted) + set the Safe address
yarn account:import                       # JamesCarnley.eth or a dedicated deployer
echo "EFS_SAFE_ADDRESS=0x...your Safe..." >> .env
# 2. rehearse on the pinned fork (no real txs, full verify + smoke)
yarn deploy:efs --network hardhat         # (Phase-D script; dry-run/fork)
# 3. deploy to Sepolia UP TO the freeze gate (deploys + verifies, STOPS before register)
yarn deploy:efs --network sepolia --until-freeze-gate
#    -> review + sign docs/SEPOLIA_FREEZE_TABLE.md
# 4. register + transfer-to-Safe + smoke (after signing)
yarn deploy:efs --network sepolia --after-freeze-gate
# 5. deploy the read views (NON-FROZEN; redeployable anytime, in no UID, outside the freeze)
yarn deploy:efs-views --network sepolia
```
`deploy:efs` is a real hardhat task (`packages/hardhat/tasks/deployEfs.ts`, run via the `deploy:efs` package script with the encrypted-key flow). It runs **only** the EFS core ceremony (the `EFSCore` tag → `deploy/00_efs_core.ts`), never the downstream/legacy scripts. The flags map to the run mode: `--until-freeze-gate` / `--after-freeze-gate` / (omit both) full. The fork rehearsal `yarn deploy:efs --network hardhat` exercises the full ceremony end-to-end (deploy + verify + wire + register + transfer + per-schema smoke) against the pinned Sepolia fork. `EFS_SAFE_ADDRESS` must be set to the real checksummed Safe before `--after-freeze-gate` on Sepolia (the task hard-fails otherwise — the transfer is single-step and irreversible; see I-5a).

`deploy:efs-views` is the companion post-freeze task (`packages/hardhat/tasks/deployEfsViews.ts`, run via the `deploy:efs-views` package script with the same encrypted-key flow). It runs **only** the `EFSViews` tag (`deploy/10_efs_views.ts`) — it deploys the three stateless views against the already-registered proxies and **never** registers a schema or redeploys a proxy. The views are in **no UID** and are **freely redeployable**: re-running is safe (redeploy-or-no-op), and you can redeploy them at any later time (view bugfix, new feature) without re-running the freeze ceremony and without affecting any attestation. The fork rehearsal `yarn deploy:efs-views --network hardhat` skips gracefully when CreateX is absent (no foundation present); the full round-trip is exercised by `test/DeployE2E.fork.test.ts` (orchestrate → views → write anchor/DATA/PIN/TAG/MIRROR/LIST/LIST_ENTRY → read it all back through EFSRouter/EFSFileView/ListReader). On local/devnet (no CreateX) the views are deployed by the legacy `02_fileview` / `03_router` / `09_lists` scripts instead — `10_efs_views` only runs where CreateX exists, so the two paths never double-deploy.

**Upgrading a resolver later (from the Safe):** in Safe{Wallet}, propose a tx to `ProxyAdmin.upgradeAndCall(proxy, newImpl, 0x)`; sign; execute. Or script it with `@safe-global/protocol-kit`.

**Burn to immutable (pre-mainnet, after a ≥14-day soak):** the pre-burn checklist is in `docs/SEPOLIA_FREEZE_TABLE.md`; when satisfied, the Safe executes `ProxyAdmin.renounceOwnership()` per proxy. Address + UID + data unchanged; logic frozen forever.

---

## 5. Status / what's built vs TODO
- ✅ **Schema + contract layer** (this PR): 9 schemas finalized; all 6 resolvers upgradeable behind the `EFSUpgradeableResolver` base; storage-layout verified + upgrade-with-state guard; suite 429/0; independently reviewed.
- ✅ **CreateX confirmed live on Sepolia**; ✅ key-custody decided (deploy-EOA → EFS.eth-Safe owner).
- ✅ **Phase-D deploy script** (`deploy/lib/{schemas,create3,verify,orchestrate,superseded}.ts` + the `deploy:efs` task) — implements steps 1–4, 6–8 above; fork-rehearsable on the pinned fork without real keys. The Sepolia surface is the **EFS core only** (the `EFSCore` tag): the downstream/legacy scripts (01–06, 09) are neutralized wherever CreateX is present and are now a **local/devnet-only** concern — they are *not* part of the Sepolia deploy (the stateless views EFSRouter/EFSFileView/ListReader are redeployed separately post-freeze, outside this ceremony).
- ✅ **Post-freeze read-views deploy** (`deploy/10_efs_views.ts` + `deploy/lib/views.ts` + the `deploy:efs-views` task) — the NON-FROZEN view layer (EFSFileView, EFSRouter, ListReader; in no UID, freely redeployable). Binds to the proxies + frozen UIDs registered by the core; runs only where CreateX is present (so it never double-deploys with the local/devnet `02`/`03`/`09` path); idempotent re-run. Full round-trip proven on the pinned fork by `test/DeployE2E.fork.test.ts` (frozen foundation → views → write anchor/DATA/PIN/TAG/MIRROR/LIST/LIST_ENTRY → read back through all three views; assertions on returned UIDs/paths/values).
- ⏳ **Resolution-spec + reference vectors** for REDIRECT-following and the content-hash preimage (Durable; must land before durable seed data — ADR-0050/0049 action items).
- 🔒 **Sepolia deploy + freeze** (steps 5–8 on real Sepolia): needs the funded deployer EOA + EFS.eth Safe address + **James's FREEZE_LEDGER signature.**

When the Phase-D script lands and is fork-rehearsed, the foundation is turnkey: James runs the commands in §4, signs the ledger, and Sepolia is live + usable.
