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
//   --- 🔒 freeze-table signing between batches (human on real Sepolia; immediate on the fork) ---
//   Batch 2 (post-gate)  → register 9 schemas LAST + author scaffolding (SystemAccount) + transports
//   assert born-owned    → ProxyAdmins + Ownable resolvers + SystemAccount owner == Safe; deployer holds
//                          nothing; realized scaffolding UIDs == precomputed (the bump-0 assertion).
//
// The EOA orchestrate.ts is untouched and remains the simpler fallback for local/devnet/fork-without-Safe
// and the unit suite.

import { Contract, Signer } from "ethers";
import { ethers } from "hardhat";
import { ResolverName, SCHEMAS } from "./schemas";
import { Create3DeployResult, Create3Name } from "./create3";
import { OrchestrationResult } from "./orchestrate";
import { buildSetTransportsAnchorCall, buildSafePlan, SafePlan } from "./safePlan";
import { executeBatchAsSafe, getSafe } from "./safe";

// EIP-1967 admin slot — bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1).
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
async function readProxyAdmin(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_ADMIN_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

export interface SafeOrchestrationResult extends OrchestrationResult {
  /// The full precomputed plan (Safe-keyed addresses + the deploy/register batches).
  plan: SafePlan;
  /// The Safe transaction hashes (Batch 1 deploys, Batch 2 register+bootstrap, Batch 3
  /// setTransportsAnchor) — for the freeze ledger.
  safeTxHashes: { batch1: string; batch2: string; batch3: string };
  /// Realized scaffolding UIDs (anchor name → UID), read back from the index after bootstrap.
  scaffoldingUIDs: Record<string, string>;
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
  opts: { log?: boolean } = {},
): Promise<SafeOrchestrationResult> {
  const log = opts.log ?? true;
  const l = (...a: unknown[]) => log && console.log(...a);
  const deployerAddr = await deployer.getAddress();

  // ── Precompute the whole graph + assemble batches ────────────────────────────────────────────────
  const plan = await buildSafePlan(deployer, safe, log);
  const safeContract = await getSafe(safe, deployer);

  // ── Batch 1 (pre-gate): CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts ──────
  l(`Safe-native deploy: executing Batch 1 (${plan.batch1.length} legs) as the Safe...`);
  const b1 = await executeBatchAsSafe(safeContract, plan.batch1, owners, deployer);
  l(`  Batch 1 executed (SafeTx ${b1.txHash})`);

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

  // ── 🔒 FREEZE GATE — on the fork this is immediate; on real Sepolia the human signs the freeze
  //    table between Batch 1 and Batch 2 (the two batches are independent Safe txs). ────────────────

  // ── Batch 2 (post-gate): register 9 schemas LAST + author scaffolding (ONE bootstrap leg) ────────
  // FIX 1: the scaffolding is a single SystemAccount.bootstrap leg that threads real EAS UIDs in
  // memory — timestamp-robust, no off-chain prediction, no pinned timestamp.
  l(
    `Safe-native deploy: executing Batch 2 (${plan.batch2.length} legs: register×9${
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
  for (const t of ["onchain", "ipfs", "arweave", "magnet", "https"]) {
    const realized: string = await indexer.resolvePath(transportsRealized, t);
    if (realized === ethers.ZeroHash) throw new Error(`SAFE-DEPLOY: /transports/${t} anchor missing after bootstrap`);
    realizedUIDs[t] = realized;
  }

  // ── Batch 3 (post-gate): MirrorResolver.setTransportsAnchor(<realized /transports UID>) ───────────
  // Fed the REAL transports UID the bootstrap call produced (read back above) — owner-gated; the Safe
  // (born owner) executes it. Separate from Batch 2 because the UID isn't known until bootstrap runs.
  l("Safe-native deploy: executing Batch 3 (setTransportsAnchor) as the Safe...");
  const b3 = await executeBatchAsSafe(
    safeContract,
    [await buildSetTransportsAnchorCall(deployer, plan.proxies.MirrorResolver, transportsRealized)],
    owners,
    deployer,
  );
  l(`  Batch 3 executed (SafeTx ${b3.txHash})`);
  const mirror = await ethers.getContractAt("MirrorResolver", plan.proxies.MirrorResolver, deployer);
  if ((await mirror.transportsAnchorUID()).toLowerCase() !== transportsRealized.toLowerCase()) {
    throw new Error("SAFE-DEPLOY: MirrorResolver.transportsAnchorUID != realized /transports UID after Batch 3");
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
