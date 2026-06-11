// Safe-native EFS deploy orchestration (docs/DEPLOYMENT.md §1, §3-§4; ADR-0048, ADR-0053).
//
// The Safe-native counterpart to orchestrate.ts. Where the EOA path read-and-branches between txs and
// ends with an ownership-transfer phase, this path PRECOMPUTES the whole deterministic graph
// (safePlan.ts) and executes it as TWO Safe MultiSend batches (safe.ts) — mirroring the human
// freeze-gate split — with everything BORN owned by the Safe (no transfer phase, no hot key ever holds
// the nascent system).
//
//   buildSafePlan        → predict Safe-keyed addresses/UIDs, deploy impls, assemble batch call lists
//   Batch 1 (pre-gate)   → CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts
//   --- 🔒 VERIFY GATE (PR #24 P1) → runVerifyGate against the on-chain Safe-keyed proxies; throws
//       before any registration on drift — mirrors the EOA path's step-3 gate ---
//   --- 🔒 freeze-table signing between batches (human on real Sepolia; immediate on the fork) ---
//   Batch 2 (post-gate)  → register 9 schemas LAST + author scaffolding (SystemAccount) + transports
//   assert born-owned    → ProxyAdmins + Ownable resolvers + SystemAccount owner == Safe; deployer holds
//                          nothing; realized scaffolding UIDs == precomputed (the bump-0 assertion).
//
// The EOA orchestrate.ts is untouched and remains the simpler fallback for local/devnet/fork-without-Safe
// and the unit suite.

import { Contract, Signer } from "ethers";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { ethers } from "hardhat";
import { ResolverName, SCHEMAS } from "./schemas";
import { Create3DeployResult, Create3Name } from "./create3";
import { OrchestrationResult } from "./orchestrate";
import { buildSetTransportsAnchorCall, buildSafePlan, SafePlan, SCAFFOLDING, TRANSPORTS_INDEX } from "./safePlan";
import { ProposedBatch, buildProposedBatch, executeBatchAsSafe, getSafe } from "./safe";
import { runVerifyGate } from "./verify";

// EIP-1967 admin slot — bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1).
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
async function readProxyAdmin(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_ADMIN_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

export interface SafeOrchestrationResult extends OrchestrationResult {
  /// FIX A (PR #24): discriminant — "execute" means the batches were signed + executed in-process
  /// (fork rehearsal). The real-network build/propose path returns a `SafeProposeResult` instead.
  mode: "execute";
  /// The full precomputed plan (Safe-keyed addresses + the deploy/register batches).
  plan: SafePlan;
  /// The Safe transaction hashes (Batch 1 deploys, Batch 2 register+bootstrap, Batch 3
  /// setTransportsAnchor) — for the freeze ledger.
  safeTxHashes: { batch1: string; batch2: string; batch3: string };
  /// Realized scaffolding UIDs (anchor name → UID), read back from the index after bootstrap.
  scaffoldingUIDs: Record<string, string>;
}

/// FIX A (PR #24): mode selector for the Safe-native path.
///   "execute" — sign + execTransaction in-process. ONLY valid when real owner signatures are
///               available to the process (the fork rehearsal's auto-deployed 1-of-1 test Safe, whose
///               single owner is a local signer). Self-signing a REAL Safe with a non-owner EOA would
///               produce invalid signatures and revert.
///   "propose" — build the MultiSend batches + emit a build/propose artifact (safe-batches.json) and a
///               console ceremony summary, then exit WITHOUT calling execTransaction. The operator
///               proposes/signs/executes each batch in Safe{Wallet} out of band. The default for real
///               networks with a real EFS_SAFE_ADDRESS and no owner keys.
export type SafeDeployMode = "execute" | "propose";

/// The propose-mode artifact: the precomputed Safe-keyed addresses/UIDs + the proposable MultiSend
/// batches (Batch 1 = deploy + wire; Batch 2 = register-last + bootstrap + seal). Batch 3
/// (setTransportsAnchor) is NOT pre-built — its argument is the realized /transports UID, only known
/// AFTER Batch 2 is executed on-chain (the bootstrap call mints it), so the operator builds it last.
export interface SafeProposeResult {
  mode: "propose";
  safe: string;
  chainId: string;
  proxies: Record<ResolverName, string>;
  systemAccount: string;
  schemaUIDs: Record<string, string>;
  plan: SafePlan;
  /// The proposable batches, in ceremony order. Each carries {to, value, data, operation, nonce,
  /// safeTxHash} for Safe{Wallet} import + the decoded inner legs for operator review.
  batches: ProposedBatch[];
  /// The human-readable ceremony order + freeze-gate pause (also printed to the console).
  ceremony: string[];
}

/// Run the full Safe-native deploy. `deployer` funds impl deploys + pays gas to execute the Safe txs
/// (gas only — authority is the owner signatures); `safe` is the EFS.eth Safe; `owners` are the Safe
/// owner signers (1-of-1 for the fork rehearsal, threshold-N for the real Safe).
///
/// FIX 1 (PR #24): the scaffolding is authored by a SINGLE timestamp-robust SystemAccount.bootstrap
/// call (in Batch 2) that threads real EAS-returned UIDs in memory — there is NO off-chain UID
/// prediction and therefore no `pinTimestamp` knob and no post-write `assertNoBump`. The scaffolding
/// UIDs are simply whatever EAS returned; the deploy reads them back from the index for the result and
/// to feed setTransportsAnchor.
export async function orchestrateViaSafe(
  deployer: Signer,
  safe: string,
  owners: Signer[],
  opts: { log?: boolean; mode?: SafeDeployMode; proposeArtifactPath?: string } = {},
): Promise<SafeOrchestrationResult | SafeProposeResult> {
  const log = opts.log ?? true;
  const mode: SafeDeployMode = opts.mode ?? "execute";
  const l = (...a: unknown[]) => log && console.log(...a);
  const deployerAddr = await deployer.getAddress();

  // ── Precompute the whole graph + assemble batches ────────────────────────────────────────────────
  const plan = await buildSafePlan(deployer, safe, log);
  const safeContract = await getSafe(safe, deployer);

  // ── FIX A (PR #24): real-network build/propose — DO NOT self-execute with a non-owner EOA ─────────
  // On a real network the gas-paying deployer is NOT a Safe owner; signing + execTransaction here would
  // fabricate invalid owner signatures and revert Batch 1. Instead build the proposable MultiSend
  // batches (the precompute above is already done) + emit the build/propose artifact, then return
  // WITHOUT touching execTransaction. The operator proposes/signs/executes each batch in Safe{Wallet}.
  if (mode === "propose") {
    return proposeViaSafe(safeContract, safe, plan, opts.proposeArtifactPath, log);
  }

  // ── Batch 1 (pre-gate): CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts ──────
  // Idempotent on a re-run (analogous to the Batch 2 register/bootstrap omit). Batch 1's legs are NOT
  // idempotent on-chain: CreateX `deployCreate3` reverts once an address is taken, and
  // `EFSIndexer.wireContracts` is one-shot (`edgeResolver == address(0)` guard). So a re-run after
  // Batch 1 landed (process exited before Batch 2/3, or an operator re-runs after the freeze-table
  // signing) would revert the whole MultiSend on the first deployCreate3 and strand recovery. All 7
  // proxies deploy ATOMICALLY in Batch 1, so any one of them having code means Batch 1 already landed —
  // we key off the EFSIndexer proxy. When skipping, we also assert the indexer is wired (the
  // wireContracts leg ran) and that it wired the Safe-keyed EdgeResolver — a consistency check that the
  // landed Batch 1 matches THIS plan, not a foreign/partial deploy.
  const indexerCode = await ethers.provider.getCode(plan.proxies.EFSIndexer);
  let b1: { txHash: string };
  if (indexerCode !== "0x") {
    const wiredIndexer = await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer);
    const wiredEdge = (await wiredIndexer.edgeResolver()).toLowerCase();
    if (wiredEdge === ethers.ZeroAddress.toLowerCase())
      throw new Error("SAFE-DEPLOY: Batch 1 proxies present but EFSIndexer not wired — inconsistent partial Batch 1");
    if (wiredEdge !== plan.proxies.EdgeResolver.toLowerCase())
      throw new Error(
        `SAFE-DEPLOY: EFSIndexer wired to ${wiredEdge} != Safe-keyed EdgeResolver ${plan.proxies.EdgeResolver}`,
      );
    l("Safe-native deploy: Batch 1 already landed (proxies deployed + EFSIndexer wired) — SKIPPING Batch 1.");
    b1 = { txHash: "0x0 (Batch 1 skipped — already deployed)" };
  } else {
    l(`Safe-native deploy: executing Batch 1 (${plan.batch1.length} legs) as the Safe...`);
    b1 = await executeBatchAsSafe(safeContract, plan.batch1, owners, deployer);
    l(`  Batch 1 executed (SafeTx ${b1.txHash})`);
  }

  // Assert every proxy landed at its Safe-keyed predicted address with code + born Safe-owned admin.
  const deploys: Record<string, Create3DeployResult> = {};
  const allNames: Create3Name[] = [...(Object.keys(plan.proxies) as ResolverName[]), "SystemAccount"];
  for (const name of allNames) {
    const proxy = name === "SystemAccount" ? plan.systemAccount : plan.proxies[name as ResolverName];
    const code = await ethers.provider.getCode(proxy);
    if (code === "0x") throw new Error(`SAFE-DEPLOY: no code at Safe-keyed predicted ${proxy} for ${name}`);
    deploys[name] = {
      resolver: name,
      impl: plan.impls[name],
      proxy,
      predicted: proxy,
      proxyAdmin: await readProxyAdmin(proxy),
      rawSalt: plan.rawSalts[name],
    };
  }

  // ── 🔒 VERIFY GATE (PR #24 P1) — mirror the EOA path's step-3 gate on the Safe path ──────────────
  // The EOA orchestrator (orchestrate.ts step 3) runs runVerifyGate AFTER deploy+init and BEFORE
  // register-last, so a proxy initialized with a drifted self-UID / EAS / field-string config is
  // caught before its permanent schema is registered. The Safe path executes Batch 2 — which contains
  // the 9 permanent SchemaRegistry.register legs — and so it MUST run the same gate first, against the
  // now-on-chain Safe-keyed proxies. The handles runVerifyGate needs are exactly what we just built:
  // `deploys` (resolver→{proxy, predicted, impl}) and the Safe-keyed `schemaUIDs`. realized==predicted
  // is trivially true here (we read the realized proxies), but the load-bearing checks — initialize
  // locked (proxy 2nd call + impl-direct), self-UID getters == Safe-keyed computed UID, getEAS()==EAS,
  // golden-vector field strings — all run against the live Safe-keyed proxies. On failure it THROWS,
  // stopping before any registration. The gate is read-only / idempotent, so on a resume where Batch 1
  // already landed it simply re-runs harmlessly before Batch 2; it always runs at least once before the
  // first register. This is the natural gate point: Batch 1 done → VERIFY GATE → [human signs the
  // freeze table on real Sepolia; immediate on the fork] → Batch 2.
  l("Safe-native deploy: running verify gate against the on-chain Safe-keyed proxies (pre-register)...");
  await runVerifyGate({ deploys, schemaUIDs: plan.schemaUIDs, deployer });

  // ── 🔒 FREEZE GATE — on the fork this is immediate; on real Sepolia the human signs the freeze
  //    table between the verify gate and Batch 2 (the two batches are independent Safe txs). ─────────

  // ── Batch 2 (post-gate): register 9 schemas LAST + author scaffolding (ONE bootstrap leg) ────────
  // FIX 1: the scaffolding is a single SystemAccount.bootstrap leg that threads real EAS UIDs in
  // memory — timestamp-robust, no off-chain prediction, no pinned timestamp.
  const registersIncluded = SCHEMAS.length - plan.batch2RegistersOmitted;
  l(
    `Safe-native deploy: executing Batch 2 (${plan.batch2.length} legs: register×${registersIncluded}${
      plan.batch2RegistersOmitted ? ` — ${plan.batch2RegistersOmitted} register legs OMITTED (already registered)` : ""
    }${
      plan.batch2BootstrapOmitted ? " — bootstrap + seal OMITTED (already sealed)" : " + bootstrap + seal"
    }) as the Safe...`,
  );
  const b2 = await executeBatchAsSafe(safeContract, plan.batch2, owners, deployer);
  l(`  Batch 2 executed (SafeTx ${b2.txHash})`);

  // ── Assert: 9 schemas registered against the Safe-keyed proxies ──────────────────────────────────
  const reg = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
    deployer,
  );
  for (const s of SCHEMAS) {
    const rec = await reg.getSchema(plan.schemaUIDs[s.name]);
    if (rec.resolver.toLowerCase() !== plan.proxies[s.resolver].toLowerCase()) {
      throw new Error(`SAFE-DEPLOY: ${s.name} getSchema.resolver ${rec.resolver} != Safe-keyed proxy`);
    }
  }

  // ── Read back the realized scaffolding UIDs (whatever EAS returned — no prediction to assert) ────
  // The bootstrap call authored the tree with real, timestamp-correct UIDs; we read them from the
  // index for the result and to feed setTransportsAnchor. The tree must be present + correctly parented
  // (root non-zero; every child resolves under its parent), which is the meaningful post-write check.
  const indexer = (await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer)) as unknown as Contract;
  const realizedUIDs: Record<string, string> = {};
  const rootRealized: string = await indexer.rootAnchorUID();
  if (rootRealized === ethers.ZeroHash) throw new Error("SAFE-DEPLOY: bootstrap left rootAnchorUID unset");
  realizedUIDs.root = rootRealized;
  const transportsRealized: string = await indexer.resolvePath(rootRealized, "transports");
  if (transportsRealized === ethers.ZeroHash)
    throw new Error("SAFE-DEPLOY: /transports anchor missing after bootstrap");
  realizedUIDs.transports = transportsRealized;
  realizedUIDs.tags = await indexer.resolvePath(rootRealized, "tags");
  // Verify every /transports/* child the bootstrap authored (all 11 allowed schemes). Derived from
  // SCAFFOLDING so this can't drift from the spec the bootstrap call actually seeded.
  const transportChildren = SCAFFOLDING.filter(a => a.parentIndex === TRANSPORTS_INDEX).map(a => a.name);
  for (const t of transportChildren) {
    const realized: string = await indexer.resolvePath(transportsRealized, t);
    if (realized === ethers.ZeroHash) throw new Error(`SAFE-DEPLOY: /transports/${t} anchor missing after bootstrap`);
    realizedUIDs[t] = realized;
  }

  // ── Batch 3 (post-gate): MirrorResolver.setTransportsAnchor(<realized /transports UID>) ───────────
  // Fed the REAL transports UID the bootstrap call produced (read back above) — owner-gated; the Safe
  // (born owner) executes it. Separate from Batch 2 because the UID isn't known until bootstrap runs.
  // Idempotent on a re-run (analogous to the Batch 1/Batch 2 omits): setTransportsAnchor is ONE-SHOT
  // (`require(transportsAnchorUID == EMPTY_UID)`), so a re-run after Batch 3 landed reverts even though
  // the system is correctly wired. Read the anchor first; if it is already set, ASSERT it equals the
  // realized /transports UID (consistency — the landed Batch 3 matches THIS plan) and SKIP the tx.
  const mirror = await ethers.getContractAt("MirrorResolver", plan.proxies.MirrorResolver, deployer);
  const existingAnchor: string = await mirror.transportsAnchorUID();
  let b3: { txHash: string };
  if (existingAnchor !== ethers.ZeroHash) {
    if (existingAnchor.toLowerCase() !== transportsRealized.toLowerCase())
      throw new Error(
        `SAFE-DEPLOY: MirrorResolver.transportsAnchorUID ${existingAnchor} != realized /transports UID ${transportsRealized}`,
      );
    l("Safe-native deploy: MirrorResolver already wired to the realized /transports UID — SKIPPING Batch 3.");
    b3 = { txHash: "0x0 (Batch 3 skipped — already wired)" };
  } else {
    l("Safe-native deploy: executing Batch 3 (setTransportsAnchor) as the Safe...");
    b3 = await executeBatchAsSafe(
      safeContract,
      [await buildSetTransportsAnchorCall(deployer, plan.proxies.MirrorResolver, transportsRealized)],
      owners,
      deployer,
    );
    l(`  Batch 3 executed (SafeTx ${b3.txHash})`);
    if ((await mirror.transportsAnchorUID()).toLowerCase() !== transportsRealized.toLowerCase()) {
      throw new Error("SAFE-DEPLOY: MirrorResolver.transportsAnchorUID != realized /transports UID after Batch 3");
    }
  }

  // ── Assert: BORN Safe-owned — every ProxyAdmin + Ownable resolver + SystemAccount owner == Safe,
  //    and the deployer EOA holds NOTHING. No transfer step ran (this path has none). ──────────────
  for (const d of Object.values(deploys)) {
    const pa = await ethers.getContractAt(
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
      d.proxyAdmin,
      deployer,
    );
    const owner = (await pa.owner()).toLowerCase();
    if (owner !== safe.toLowerCase()) throw new Error(`SAFE-DEPLOY: ${d.resolver} ProxyAdmin owner ${owner} != Safe`);
    if (owner === deployerAddr.toLowerCase())
      throw new Error(`SAFE-DEPLOY: ${d.resolver} ProxyAdmin owned by deployer`);
  }
  for (const r of ["EFSIndexer", "MirrorResolver"] as ResolverName[]) {
    const c = await ethers.getContractAt(r, plan.proxies[r], deployer);
    if ((await c.owner()).toLowerCase() !== safe.toLowerCase()) throw new Error(`SAFE-DEPLOY: ${r} owner != Safe`);
  }
  {
    const sa = await ethers.getContractAt("SystemAccount", plan.systemAccount, deployer);
    if ((await sa.owner()).toLowerCase() !== safe.toLowerCase())
      throw new Error("SAFE-DEPLOY: SystemAccount owner != Safe");
    // PR #24 P1 fix: bootstrap ceremony permanently sealed by the Batch-2 seal() leg — the relay is
    // now module-only and the owner (the Safe) can never emit/revoke arbitrary payloads as `system`.
    if (!(await sa.bootstrapSealed())) throw new Error("SAFE-DEPLOY: SystemAccount bootstrap not sealed after Batch 2");
  }

  l(
    "Safe-native deploy: BORN Safe-owned ✓ (ProxyAdmins + resolvers + SystemAccount owner == Safe; deployer holds nothing).",
  );

  const result: SafeOrchestrationResult = {
    mode: "execute",
    deploys,
    proxies: plan.proxies,
    systemAccount: plan.systemAccount,
    schemaUIDs: plan.schemaUIDs,
    transportsAnchorUID: realizedUIDs.transports,
    safe,
    registered: true,
    ownershipTransferred: false, // born-owned — there is no transfer phase on the Safe path
    plan,
    safeTxHashes: { batch1: b1.txHash, batch2: b2.txHash, batch3: b3.txHash },
    scaffoldingUIDs: realizedUIDs,
  };
  return result;
}

/// FIX A (PR #24): real-network build/propose. The precompute (buildSafePlan) is already done —
/// impls deployed by the gas-paying EOA, Safe-keyed addresses/UIDs predicted, the register/bootstrap
/// idempotency omits resolved against on-chain state. Here we BUILD the two proposable MultiSend
/// SafeTxs (Batch 1 = deploy + wire at the Safe's current nonce; Batch 2 = register-last + bootstrap +
/// seal at nonce+1) WITHOUT executing them, emit the build/propose artifact (safe-batches.json) + a
/// console ceremony summary, and return. Batch 3 (setTransportsAnchor) is NOT pre-built: its argument
/// is the realized /transports UID, only minted when Batch 2 runs on-chain, so the operator builds it
/// last (read `indexer.resolvePath(root,"transports")`, then propose setTransportsAnchor). No
/// execTransaction is ever called — the non-owner EOA never reaches safe.ts's signing path.
async function proposeViaSafe(
  safeContract: Contract,
  safe: string,
  plan: SafePlan,
  artifactPath: string | undefined,
  log: boolean,
): Promise<SafeProposeResult> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();

  // Build the two batches at sequential nonces (Batch 1 at the Safe's live nonce, Batch 2 at +1 — the
  // on-chain nonce only advances as the operator executes each prior batch). Batch 2 may be empty on a
  // resume (all registers omitted + bootstrap/seal omitted); we still emit it for a faithful record.
  const batches: ProposedBatch[] = [];
  batches.push(await buildProposedBatch(safeContract, plan.batch1, "Batch 1 (deploy + wire)", 0n));
  batches.push(
    await buildProposedBatch(safeContract, plan.batch2, "Batch 2 (register-last + SystemAccount.bootstrap + seal)", 1n),
  );

  const ceremony = [
    "EFS Safe-native deploy — BUILD/PROPOSE (real network; no owner keys in-process).",
    "Propose + sign + execute each batch in Safe{Wallet} / the Safe Tx Service, IN ORDER:",
    "  1. Batch 1 (deploy + wire) — execute as the Safe.",
    "  2. VERIFY GATE — re-run `deploy:efs --via-safe` (or runVerifyGate) against the now-live",
    "     Safe-keyed proxies; it is read-only and aborts on any drift before any register.",
    "  3. FREEZE GATE (HUMAN) — fill + sign docs/SEPOLIA_FREEZE_TABLE.md with the addresses/UIDs",
    "     and the Batch-1/2/3 SafeTx hashes. No schema is registered before this signature.",
    "  4. Batch 2 (register-last + one SystemAccount.bootstrap + seal) — execute as the Safe.",
    "  5. Batch 3 (setTransportsAnchor) — read the realized /transports UID back from the index",
    '     (`indexer.resolvePath(root,"transports")`), then propose + execute',
    "     MirrorResolver.setTransportsAnchor(thatUID). Not pre-built: the UID is only known after",
    "     Batch 2 runs. No transfer phase — everything is born Safe-owned.",
  ];

  const artifact = {
    note:
      "EFS Safe-native deploy — build/propose artifact (FIX A, PR #24). Import each batch into " +
      "Safe{Wallet}; sign with the real owner keys; execute in order. Batch 3 (setTransportsAnchor) " +
      "is built by the operator after Batch 2 (its arg is the realized /transports UID).",
    chainId,
    safe,
    proxies: plan.proxies,
    systemAccount: plan.systemAccount,
    schemaUIDs: plan.schemaUIDs,
    batch2RegistersOmitted: plan.batch2RegistersOmitted,
    batch2BootstrapOmitted: plan.batch2BootstrapOmitted,
    ceremony,
    batches,
  };

  if (artifactPath) {
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    l(`Safe-native deploy (propose): wrote build/propose artifact → ${artifactPath}`);
  }

  l("");
  for (const line of ceremony) l(line);
  l("");
  for (const b of batches) {
    l(`  ${b.label}: nonce=${b.nonce} safeTxHash=${b.safeTxHash} to=${b.to} (${b.legs.length} legs)`);
  }
  l("");
  l("Safe-native deploy (propose): batches BUILT, no execTransaction sent (non-owner EOA, real network).");

  return {
    mode: "propose",
    safe,
    chainId,
    proxies: plan.proxies,
    systemAccount: plan.systemAccount,
    schemaUIDs: plan.schemaUIDs,
    plan,
    batches,
    ceremony,
  };
}
