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
import { ethers, network } from "hardhat";
import { ResolverName, SCHEMAS } from "./schemas";
import { Create3DeployResult, Create3Name } from "./create3";
import { OrchestrationResult } from "./orchestrate";
import { assembleScaffoldingCalls, assertNoBump, buildSafePlan, SafePlan } from "./safePlan";
import { executeBatchAsSafe, getSafe } from "./safe";

// EIP-1967 admin slot — bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1).
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
async function readProxyAdmin(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_ADMIN_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

export interface SafeOrchestrationResult extends OrchestrationResult {
  /// The full precomputed plan (Safe-keyed addresses/UIDs + the two batches).
  plan: SafePlan;
  /// The two Safe transaction hashes (Batch 1, Batch 2) — for the freeze ledger.
  safeTxHashes: { batch1: string; batch2: string };
  /// Realized scaffolding UIDs (anchor key → UID), asserted == precomputed.
  scaffoldingUIDs: Record<string, string>;
}

/// Predict the timestamp the next mined block will carry so the scaffolding-UID precompute is exact.
/// On the in-process hardhat fork we PIN it (evm_setNextBlockTimestamp) so realized == precomputed
/// deterministically; on a real network we cannot pin it, so we predict (latest + 1) and rely on the
/// post-exec bump/UID assertion to fail loudly if the miner chose a different timestamp.
async function nextBlockTimestamp(pin: boolean): Promise<bigint> {
  const latest = await ethers.provider.getBlock("latest");
  const t = BigInt(latest!.timestamp) + 1n;
  if (pin) {
    await network.provider.send("evm_setNextBlockTimestamp", [Number(t)]);
  }
  return t;
}

/// Run the full Safe-native deploy. `deployer` funds impl deploys + pays gas to execute the Safe txs
/// (gas only — authority is the owner signatures); `safe` is the EFS.eth Safe; `owners` are the Safe
/// owner signers (1-of-1 for the fork rehearsal, threshold-N for the real Safe). `pinTimestamp` should
/// be true on the hardhat fork (deterministic UID precompute), false on a real network.
export async function orchestrateViaSafe(
  deployer: Signer,
  safe: string,
  owners: Signer[],
  opts: { pinTimestamp?: boolean; log?: boolean } = {},
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

  // ── Batch 2 (post-gate): register 9 schemas LAST + scaffolding + setTransportsAnchor ─────────────
  // The scaffolding legs are timestamp-dependent (EAS folds block.timestamp into every UID), so we pin
  // the next block timestamp (fork) / predict it (real), assemble the legs against it, and concatenate.
  const time = await nextBlockTimestamp(opts.pinTimestamp ?? true);
  const { calls: scaffoldingCalls, uids: predictedUIDs } = await assembleScaffoldingCalls(deployer, plan, time);
  const batch2 = [...plan.batch2, ...scaffoldingCalls];
  l(`Safe-native deploy: executing Batch 2 (${batch2.length} legs) as the Safe (block.timestamp=${time})...`);
  const b2 = await executeBatchAsSafe(safeContract, batch2, owners, deployer);
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

  // ── Assert: realized scaffolding UIDs == precomputed (the bump-0 assertion) ───────────────────────
  const indexer = (await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer)) as unknown as Contract;
  const realizedUIDs: Record<string, string> = {};
  const rootRealized: string = await indexer.rootAnchorUID();
  assertNoBump(rootRealized, predictedUIDs.root, "root");
  realizedUIDs.root = rootRealized;
  // resolvePath(parent, name) walks the index; assert each scaffolding child resolves to its precompute.
  const transportsRealized: string = await indexer.resolvePath(rootRealized, "transports");
  assertNoBump(transportsRealized, predictedUIDs.transports, "transports");
  realizedUIDs.transports = transportsRealized;
  const tagsRealized: string = await indexer.resolvePath(rootRealized, "tags");
  assertNoBump(tagsRealized, predictedUIDs.tags, "tags");
  realizedUIDs.tags = tagsRealized;
  for (const t of ["onchain", "ipfs", "arweave", "magnet", "https"]) {
    const realized: string = await indexer.resolvePath(transportsRealized, t);
    assertNoBump(realized, predictedUIDs[t], `transports/${t}`);
    realizedUIDs[t] = realized;
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
    safeTxHashes: { batch1: b1.txHash, batch2: b2.txHash },
    scaffoldingUIDs: realizedUIDs,
  };
  return result;
}
