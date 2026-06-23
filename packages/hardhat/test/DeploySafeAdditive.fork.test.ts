import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot } from "@nomicfoundation/hardhat-network-helpers";
import { CREATEX_ADDRESS } from "../deploy-lib/addresses";
import { orchestrateViaSafe } from "../deploy-lib/orchestrateSafe";
import { getCreateX, predictProxyAddress } from "../deploy-lib/create3";
import { RESOLVERS, SCHEMAS } from "../deploy-lib/schemas";
import {
  buildAdditivePlan,
  buildSafePlan,
  detectDeployPhase,
  detectMissingResolvers,
  predictPlan,
} from "../deploy-lib/safePlan";
import { deployTestSafe, executeBatchAsSafe, getSafe, SAFE_PROXY_FACTORY_141 } from "../deploy-lib/safe";

// Fork rehearsal for the ADDITIVE post-freeze Safe deploy (ADR-0055 — adding WHITEOUT to a LIVE core).
//
// The bug this guards: WhiteoutResolver was appended to the core RESOLVERS set (schemas.ts), but the
// Safe deploy machinery keyed Phase 0 only on EFSIndexer code + looped ALL proxies in
// `buildDeploysFromOnchain`. In the documented additive case (the original frozen nine-schema core is
// ALREADY LIVE on Sepolia and only WHITEOUT is missing), the flow skipped Batch 1, then threw because
// there was no code at the predicted WhiteoutResolver address — so the new schema could not be
// registered without redeploying the whole core. This blocks the actual planned Sepolia deployment.
//
// The fix: detect missing additive resolvers (resolvers with no on-chain code while the core EFSIndexer
// IS live) and deploy ONLY those (+ register ONLY their schemas) as a dedicated step BEFORE the register
// batch — no full-core redeploy. This file proves:
//   1. `buildAdditivePlan(["WhiteoutResolver"])` deploys ONLY WhiteoutResolver + registers ONLY WHITEOUT.
//   2. On a COMPLETE live system, `detectMissingResolvers` is empty + `detectDeployPhase` == 3 — the
//      additive branch is inert, so the existing fresh-deploy path is unchanged.
//   3. END-TO-END: a manufactured LIVE CORE with WhiteoutResolver MISSING (the real additive shape) is
//      completed by `orchestrateViaSafe` deploying ONLY WhiteoutResolver + registering ONLY WHITEOUT,
//      born Safe-owned, with the 9 core schemas + 6 core resolvers untouched (no redeploy).
//
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/DeploySafeAdditive.fork.test.ts --network hardhat
// When not forking, self-skips so the default unit suite is unaffected.
describe("DeploySafeAdditive.fork — additive WhiteoutResolver deploy onto a live core (ADR-0055)", function () {
  this.timeout(240_000);

  let forked = false;

  before(async function () {
    const createxCode = await ethers.provider.getCode(CREATEX_ADDRESS);
    const safeFactoryCode = await ethers.provider.getCode(SAFE_PROXY_FACTORY_141);
    forked = createxCode !== "0x" && safeFactoryCode !== "0x";
    if (!forked) {
      console.log(
        "    (skipping DeploySafeAdditive.fork — CreateX/Safe factory not present; run with MAINNET_FORKING_ENABLED=true)",
      );
      this.skip();
    }
  });

  // ── 1. buildAdditivePlan deploys ONLY WhiteoutResolver + registers ONLY WHITEOUT ──────────────────
  // Pure plan-shape proof (no on-chain core needed): the additive plan for the single missing additive
  // resolver carries exactly one CreateX deploy leg (WhiteoutResolver) and exactly one register leg
  // (WHITEOUT) — never a core resolver / core schema. This is the "no full-core redeploy" guarantee at
  // the plan layer.
  it("buildAdditivePlan(WhiteoutResolver) → exactly 1 deploy leg + 1 register leg, none core", async function () {
    const [deployer, ownerSigner] = await ethers.getSigners();
    const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);
    const predicted = await predictPlan(deployer, safe, false);

    const additive = await buildAdditivePlan(deployer, predicted, ["WhiteoutResolver"], false);

    // Batch A1: exactly one deploy leg, for WhiteoutResolver — no core resolver.
    expect(additive.batchA1, "Batch A1 deploys exactly one resolver").to.have.lengthOf(1);
    expect(additive.batchA1[0].label).to.match(/deployCreate3 WhiteoutResolver/);
    const coreResolvers = RESOLVERS.filter(r => r !== "WhiteoutResolver");
    for (const r of coreResolvers) {
      expect(
        additive.batchA1.some(leg => (leg.label ?? "").includes(`deployCreate3 ${r}`)),
        `Batch A1 must NOT redeploy core resolver ${r}`,
      ).to.equal(false);
    }

    // Batch A2: exactly one register leg, for WHITEOUT — no core schema.
    expect(additive.batchA2, "Batch A2 registers exactly one schema").to.have.lengthOf(1);
    expect(additive.batchA2[0].label).to.match(/register WHITEOUT/);
    const coreSchemas = SCHEMAS.filter(s => s.resolver !== "WhiteoutResolver");
    for (const s of coreSchemas) {
      expect(
        additive.batchA2.some(leg => (leg.label ?? "").includes(`register ${s.name}`)),
        `Batch A2 must NOT re-register core schema ${s.name}`,
      ).to.equal(false);
    }
  });

  // ── 2. On a COMPLETE live system the additive branch is inert (fresh path unchanged) ──────────────
  it("complete system: detectMissingResolvers is empty + phase 3 (additive branch inert)", async function () {
    const snap = await takeSnapshot();
    try {
      const [deployer, ownerSigner] = await ethers.getSigners();
      const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);

      // Full happy-path deploy (all 7 resolvers incl. WhiteoutResolver land in one Batch 1).
      const raw = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: false });
      expect(raw.mode).to.equal("execute");

      const predicted = await predictPlan(deployer, safe, false);
      const missing = await detectMissingResolvers(deployer, predicted);
      expect(missing, "no resolver missing on a complete system").to.have.lengthOf(0);
      const phase = await detectDeployPhase(deployer, predicted);
      expect(phase, "complete system is phase 3").to.equal(3);

      // Re-running orchestrate is a clean no-op (does NOT enter the additive branch, does NOT redeploy).
      const reraw = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: false });
      expect(reraw.mode).to.equal("execute");
      if (reraw.mode !== "execute") throw new Error("unreachable");
      expect(reraw.safeTxHashes.batch1, "Batch 1 skipped on a complete system").to.match(/skipped/i);
    } finally {
      await snap.restore();
    }
  });

  // ── 3. END-TO-END: live core with WhiteoutResolver missing → additive deploy completes it ─────────
  // Manufacture the real additive shape by standing up the core WITHOUT WhiteoutResolver: build the full
  // Safe plan, then drive Batch 1 / Batch 2 / Batch 3 with the WhiteoutResolver deploy leg and the
  // WHITEOUT register leg FILTERED OUT. The result is a genuine live core (9 core schemas on 6 core
  // resolvers, sealed, transports wired) with the WhiteoutResolver proxy absent + WHITEOUT unregistered —
  // exactly the documented Sepolia state. Then `orchestrateViaSafe` must deploy ONLY WhiteoutResolver +
  // register ONLY WHITEOUT, born Safe-owned, leaving the core untouched.
  it("live core missing WhiteoutResolver: orchestrate deploys ONLY WhiteoutResolver + registers ONLY WHITEOUT (no core redeploy)", async function () {
    const snap = await takeSnapshot();
    try {
      const [deployer, ownerSigner] = await ethers.getSigners();
      const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);
      const safeContract = await getSafe(safe, deployer);
      const safeLc = safe.toLowerCase();
      const createx = await getCreateX(deployer);

      // Build the full plan (deploys all impls), then strip the WhiteoutResolver/WHITEOUT legs so the
      // executed core is genuinely missing the additive resolver.
      const plan = await buildSafePlan(deployer, safe, false);
      const coreBatch1 = plan.batch1.filter(leg => !(leg.label ?? "").includes("deployCreate3 WhiteoutResolver"));
      const coreBatch2 = plan.batch2.filter(leg => (leg.label ?? "") !== "register WHITEOUT");
      // Sanity: we actually stripped exactly the two additive legs.
      expect(plan.batch1.length - coreBatch1.length, "stripped 1 deploy leg (WhiteoutResolver)").to.equal(1);
      expect(plan.batch2.length - coreBatch2.length, "stripped 1 register leg (WHITEOUT)").to.equal(1);

      // Execute the core-only Batch 1 (6 resolvers + SystemAccount + wire), then Batch 2 (register 9 core
      // schemas + bootstrap + seal). Then Batch 3 (setTransportsAnchor) — same ceremony, minus WHITEOUT.
      await executeBatchAsSafe(safeContract, coreBatch1, [ownerSigner], deployer);
      await executeBatchAsSafe(safeContract, coreBatch2, [ownerSigner], deployer);
      const indexer = await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer);
      const root = await indexer.rootAnchorUID();
      const transportsUID = await indexer.resolvePath(root, "transports");
      const { buildSetTransportsAnchorCall } = await import("../deploy-lib/safePlan");
      await executeBatchAsSafe(
        safeContract,
        [await buildSetTransportsAnchorCall(deployer, plan.proxies.MirrorResolver, transportsUID)],
        [ownerSigner],
        deployer,
      );

      // ── The manufactured state: core live, WhiteoutResolver MISSING. ────────────────────────────────
      const whiteoutProxy = (await predictProxyAddress(createx, safe, "WhiteoutResolver")).predicted;
      expect(await ethers.provider.getCode(plan.proxies.EFSIndexer), "core EFSIndexer live").to.not.equal("0x");
      expect(await ethers.provider.getCode(whiteoutProxy), "WhiteoutResolver proxy absent").to.equal("0x");
      const reg = await ethers.getContractAt(
        "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
        "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
        deployer,
      );
      // 9 core schemas registered; WHITEOUT not.
      for (const s of SCHEMAS) {
        const rec = await reg.getSchema(plan.schemaUIDs[s.name]);
        if (s.resolver === "WhiteoutResolver") {
          expect(rec.uid, "WHITEOUT NOT registered (the manufactured additive gap)").to.equal(ethers.ZeroHash);
        } else {
          expect(rec.uid.toLowerCase(), `core schema ${s.name} registered`).to.equal(
            plan.schemaUIDs[s.name].toLowerCase(),
          );
        }
      }
      // Detection: phase 3 (core complete, additive-aware) + WhiteoutResolver flagged missing.
      const predicted = await predictPlan(deployer, safe, false);
      expect(await detectDeployPhase(deployer, predicted), "core complete → phase 3").to.equal(3);
      expect(await detectMissingResolvers(deployer, predicted), "WhiteoutResolver detected missing").to.deep.equal([
        "WhiteoutResolver",
      ]);

      // Capture which CREATE3 proxy addresses already had code BEFORE the additive run — proof that the
      // additive step does NOT redeploy any core proxy (its CreateX deploy is one-shot: a redeploy would
      // revert "address taken"). Only WhiteoutResolver should transition from no-code to code.
      const codeBefore: Record<string, boolean> = {};
      for (const r of RESOLVERS) codeBefore[r] = (await ethers.provider.getCode(plan.proxies[r])) !== "0x";
      const saCodeBefore = (await ethers.provider.getCode(plan.systemAccount)) !== "0x";

      // ── THE FIX: orchestrateViaSafe now completes the additive resolver instead of throwing. ────────
      const raw = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: false });
      expect(raw.mode).to.equal("execute");
      if (raw.mode !== "execute") throw new Error("unreachable");

      // WhiteoutResolver proxy now has code, born Safe-owned; WHITEOUT registered against it.
      expect(
        await ethers.provider.getCode(whiteoutProxy),
        "WhiteoutResolver deployed by the additive step",
      ).to.not.equal("0x");
      const whiteoutResolver = await ethers.getContractAt("WhiteoutResolver", whiteoutProxy, deployer);
      const whiteoutUID = plan.schemaUIDs.WHITEOUT;
      expect(
        (await whiteoutResolver.whiteoutSchemaUID()).toLowerCase(),
        "self-UID matches the registered WHITEOUT",
      ).to.equal(whiteoutUID.toLowerCase());
      const whiteoutRec = await reg.getSchema(whiteoutUID);
      expect(whiteoutRec.uid.toLowerCase(), "WHITEOUT now registered").to.equal(whiteoutUID.toLowerCase());
      expect(whiteoutRec.resolver.toLowerCase(), "WHITEOUT registered against the WhiteoutResolver proxy").to.equal(
        whiteoutProxy.toLowerCase(),
      );

      // The additive deploy is born Safe-owned (its ProxyAdmin owner == Safe).
      const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
      const adminRaw = await ethers.provider.getStorage(whiteoutProxy, EIP1967_ADMIN_SLOT);
      const admin = ethers.getAddress("0x" + adminRaw.slice(-40));
      const pa = await ethers.getContractAt(
        "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
        admin,
        deployer,
      );
      expect((await pa.owner()).toLowerCase(), "WhiteoutResolver born Safe-owned").to.equal(safeLc);

      // NO full-core redeploy: only the WhiteoutResolver proxy transitioned no-code → code. Every core
      // proxy + SystemAccount that already existed still exists (and was NOT redeployed — a CreateX
      // redeploy is one-shot and would have reverted). Only WhiteoutResolver was missing before and is
      // present now.
      for (const r of RESOLVERS) {
        const after = (await ethers.provider.getCode(plan.proxies[r])) !== "0x";
        expect(after, `${r} proxy present after additive`).to.equal(true);
        if (r === "WhiteoutResolver") {
          expect(codeBefore[r], "WhiteoutResolver was missing before").to.equal(false);
        } else {
          expect(codeBefore[r], `core ${r} present before (not redeployed)`).to.equal(true);
        }
      }
      expect(saCodeBefore, "SystemAccount present before additive (not redeployed)").to.equal(true);

      // The core is byte-for-byte untouched: the 9 core schemas still resolve to the same proxies, the
      // bootstrap is still sealed, transports still wired, EFSIndexer still Safe-owned.
      for (const s of SCHEMAS.filter(x => x.resolver !== "WhiteoutResolver")) {
        const rec = await reg.getSchema(plan.schemaUIDs[s.name]);
        expect(rec.resolver.toLowerCase(), `core schema ${s.name} resolver unchanged`).to.equal(
          plan.proxies[s.resolver].toLowerCase(),
        );
      }
      const systemAccount = await ethers.getContractAt("SystemAccount", plan.systemAccount, deployer);
      expect(await systemAccount.bootstrapSealed(), "core bootstrap still sealed").to.equal(true);
      const mirror = await ethers.getContractAt("MirrorResolver", plan.proxies.MirrorResolver, deployer);
      expect((await mirror.transportsAnchorUID()).toLowerCase(), "core transports still wired").to.equal(
        transportsUID.toLowerCase(),
      );
      expect((await indexer.owner()).toLowerCase(), "core EFSIndexer still Safe-owned").to.equal(safeLc);

      // Re-running the additive orchestrate is a clean no-op (proxy deployed + schema registered).
      const reraw = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: false });
      expect(reraw.mode).to.equal("execute");
      if (reraw.mode !== "execute") throw new Error("unreachable");
      expect(reraw.safeTxHashes.batch1, "additive Batch A1 skipped on re-run").to.match(/skipped|additive/i);
      expect(
        await detectMissingResolvers(deployer, predicted),
        "no resolver missing after additive deploy",
      ).to.have.lengthOf(0);
    } finally {
      await snap.restore();
    }
  });

  // ── 4. PROPOSE path (the REAL Sepolia path): additive sub-phases A1 → A2 ───────────────────────────
  // Real Sepolia uses mode "propose" (the gas EOA is not a Safe owner). Drive the additive propose walk
  // against the manufactured live-core-missing-WhiteoutResolver state, APPLYING each proposed batch with
  // the test owner key to advance (the operator's Safe{Wallet} step). Assert each invocation emits ONLY
  // the next additive batch — A1 (deploy WhiteoutResolver), then A2 (register WHITEOUT) — never a core
  // ceremony batch, never a duplicate.
  it("propose path: additive walk emits Batch A1 (deploy) then Batch A2 (register WHITEOUT), never a core batch", async function () {
    const snap = await takeSnapshot();
    try {
      const [deployer, ownerSigner] = await ethers.getSigners();
      const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);
      const safeContract = await getSafe(safe, deployer);
      const createx = await getCreateX(deployer);

      // Manufacture the live core missing WhiteoutResolver (same construction as test 3).
      const plan = await buildSafePlan(deployer, safe, false);
      const coreBatch1 = plan.batch1.filter(leg => !(leg.label ?? "").includes("deployCreate3 WhiteoutResolver"));
      const coreBatch2 = plan.batch2.filter(leg => (leg.label ?? "") !== "register WHITEOUT");
      await executeBatchAsSafe(safeContract, coreBatch1, [ownerSigner], deployer);
      await executeBatchAsSafe(safeContract, coreBatch2, [ownerSigner], deployer);
      const indexer = await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer);
      const root = await indexer.rootAnchorUID();
      const transportsUID = await indexer.resolvePath(root, "transports");
      const { buildSetTransportsAnchorCall } = await import("../deploy-lib/safePlan");
      await executeBatchAsSafe(
        safeContract,
        [await buildSetTransportsAnchorCall(deployer, plan.proxies.MirrorResolver, transportsUID)],
        [ownerSigner],
        deployer,
      );
      const whiteoutProxy = (await predictProxyAddress(createx, safe, "WhiteoutResolver")).predicted;
      expect(await ethers.provider.getCode(whiteoutProxy), "WhiteoutResolver absent (manufactured gap)").to.equal("0x");

      // ── Additive sub-phase A1: propose emits ONLY Batch A1 (deploy WhiteoutResolver). ───────────────
      const a1 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      expect(a1.mode).to.equal("propose");
      if (a1.mode !== "propose") throw new Error("unreachable");
      expect(a1.batches, "additive A1 emits exactly one batch").to.have.lengthOf(1);
      expect(a1.batches[0].label, "additive A1 deploys WhiteoutResolver").to.match(/Batch A1 \(additive deploy/);
      expect(
        a1.batches[0].legs.every(leg => (leg.label ?? "").includes("WhiteoutResolver")),
        "A1 carries ONLY the WhiteoutResolver deploy leg (no core deploy)",
      ).to.equal(true);
      // Nothing executed by propose — the Safe-keyed WhiteoutResolver proxy is still absent.
      expect(await ethers.provider.getCode(whiteoutProxy), "propose A1 did not self-execute").to.equal("0x");

      // Apply Batch A1 (operator's Safe{Wallet} step) → WhiteoutResolver proxy now live.
      const a1plan = await buildAdditivePlan(
        deployer,
        await predictPlan(deployer, safe, false),
        ["WhiteoutResolver"],
        false,
      );
      await executeBatchAsSafe(safeContract, a1plan.batchA1, [ownerSigner], deployer);
      expect(await ethers.provider.getCode(whiteoutProxy), "WhiteoutResolver live after A1").to.not.equal("0x");

      // ── Sub-phase A2: re-run propose. Once the WhiteoutResolver proxy has code, `detectMissingResolvers`
      // no longer flags it, so the re-run routes the register through the existing (additive-aware) core
      // Phase-1 path — which by design registers ONLY the not-yet-registered schema (WHITEOUT). The 9 core
      // schemas are register-omitted (already registered) and bootstrap+seal are omitted (already sealed),
      // so the proposed batch is EXACTLY the one WHITEOUT register leg. This reuses the battle-tested
      // register-omit machinery rather than a parallel additive register path — the WHITEOUT schema is
      // registered, and nothing core is touched. ────────────────────────────────────────────────────────
      const a2 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      expect(a2.mode).to.equal("propose");
      if (a2.mode !== "propose") throw new Error("unreachable");
      expect(a2.batches, "A2 emits exactly one batch").to.have.lengthOf(1);
      expect(a2.batches[0].legs, "A2 carries exactly one leg").to.have.lengthOf(1);
      expect(
        a2.batches[0].legs[0].label,
        "A2 registers ONLY WHITEOUT (core registers + bootstrap/seal omitted)",
      ).to.match(/register WHITEOUT/);
      // No core ceremony leg leaks in (no core register, no bootstrap, no seal, no deployCreate3).
      expect(
        a2.batches[0].legs.some(
          leg => /deployCreate3|bootstrap|seal/i.test(leg.label ?? "") || /register (?!WHITEOUT)/.test(leg.label ?? ""),
        ),
        "A2 carries no core deploy/register/bootstrap/seal leg",
      ).to.equal(false);

      // Apply Batch A2 → WHITEOUT registered. (Rebuild the executable register leg — the propose result's
      // `legs` carry only to/value/dataLength for review, not calldata, so re-derive the SafeCall[].)
      const a2plan = await buildAdditivePlan(
        deployer,
        await predictPlan(deployer, safe, false),
        ["WhiteoutResolver"],
        false,
      );
      await executeBatchAsSafe(safeContract, a2plan.batchA2, [ownerSigner], deployer);
      const reg = await ethers.getContractAt(
        "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
        "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
        deployer,
      );
      expect(
        (await reg.getSchema(plan.schemaUIDs.WHITEOUT)).uid.toLowerCase(),
        "WHITEOUT registered after A2",
      ).to.equal(plan.schemaUIDs.WHITEOUT.toLowerCase());

      // ── Additive done: re-run propose → clean no-op (no batch). ─────────────────────────────────────
      const done = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      expect(done.mode).to.equal("propose");
      if (done.mode !== "propose") throw new Error("unreachable");
      expect(done.batches, "additive complete → no batch").to.have.lengthOf(0);
    } finally {
      await snap.restore();
    }
  });
});
