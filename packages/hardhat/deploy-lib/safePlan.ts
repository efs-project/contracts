// Safe-native deploy precompute + batch assembly (docs/DEPLOYMENT.md §3, ADR-0048, ADR-0053).
//
// The EFS deploy is DETERMINISTIC: every CREATE3 address, every schema UID, and (given the executing
// block's timestamp) every scaffolding attestation UID is computable off-chain BEFORE any tx. That is
// what lets the Safe path precompute the whole dependency graph and submit it as two batched MultiSend
// calls (mirroring the human freeze-gate split) instead of read-and-branch between txs the way the EOA
// orchestrator does.
//
// Safe-keying: when the Safe calls CreateX, msg.sender == the Safe, so the CREATE3 permissioned-salt
// guard mixes the SAFE address (not an EOA). The proxy addresses — and therefore the schema UIDs baked
// against them — are SAFE-KEYED and differ from the EOA-deployed canonical set. That is intended: the
// canonical addresses are now keyed to the multisig. We predict by passing the Safe as `deployer` into
// the same salt/CREATE3 helpers the EOA path uses (the salt VALUES are unchanged — only the realized
// address for a given salt moves, exactly as the freeze-safety note requires).
//
// Born-Safe-owned: every proxy initializes with owner_ = Safe, and since the Safe is the CreateX caller
// the auto-created ProxyAdmins are owned by the Safe. So there is NO transfer phase on this path —
// nothing is ever owned by a hot key. SystemAccount is likewise owned by the Safe and authors the
// scaffolding (the Safe, as SystemAccount's owner, executes the single bootstrap call in Batch 2).
//
// The two batches map onto the existing freeze-gate split:
//   Batch 1 (PRE-gate)  = deploy all 7 proxies via CreateX (atomic init, born Safe-owned) + wire
//                         (EFSIndexer.wireContracts — pure storage, no EAS call).
//   --- 🔒 human freeze-table signing happens between the two batches ---
//   Batch 2 (POST-gate) = register the 9 schemas LAST + author the scaffolding through SystemAccount
//                         (ONE SystemAccount.bootstrap leg) + SystemAccount.seal() (PR #24 P1 fix:
//                         lock the owner's bootstrap write authority; relay becomes module-only).
//                         (Register-then-author, preserving orchestrate.ts's ordering: anchors are
//                         attestations EAS rejects until the ANCHOR schema is registered, so they
//                         MUST follow register-last. Seal is the last leg, after bootstrap.)
//   Batch 3 (POST-gate) = MirrorResolver.setTransportsAnchor(<realized /transports UID>), fed the REAL
//                         transports anchor UID read back from the index after Batch 2 (the bootstrap
//                         call threads real EAS UIDs in memory, so nothing is predicted off-chain).
//
// Why bootstrap is ONE leg (FIX 1 / PR #24): the previous design precomputed every scaffolding-anchor
// UID off-chain from a *predicted* block timestamp (EAS folds block.timestamp into each UID) and then
// asserted realized == predicted. On a real network the mined Safe-tx timestamp can differ from the
// prediction, so the children would be attested under non-existent predicted parent UIDs and the bad
// writes (non-revocable!) would land BEFORE the post-exec assertion fired. `SystemAccount.bootstrap`
// authors the whole tree in one call, threading each child's `refUID` from the parent UID the prior
// `EAS.attest` returned IN THE SAME CALL — timestamp-robust by construction, no off-chain prediction.
//
// This module produces the call lists; deploy-lib/safe.ts turns a call list into the executable
// MultiSend batch, and the deploy task / fork test drive execution.

import { Contract, Interface, Signer, ZeroAddress, ZeroHash, getBytes } from "ethers";
import { ethers } from "hardhat";
import { SCHEMA_REGISTRY_ADDRESS } from "./addresses";
import { Create3Name, buildProxyInitCode, getCreateX, predictImplAddress, predictProxyAddress } from "./create3";
import { RESOLVERS, ResolverName, SCHEMAS, computeAllSchemaUIDs } from "./schemas";
import { SafeCall } from "./safe";

// CreateX `deployCreate3(bytes32 salt, bytes initCode)` — the leg each proxy deploy is.
const CREATEX_IFACE = new Interface(["function deployCreate3(bytes32 salt, bytes initCode) payable returns (address)"]);

// ── Scaffolding spec — the bootstrap anchors, in the EXACT order orchestrate.ts authors them ─────────
// root → (tags, transports) under root; then the twelve transport children under /transports/. The whole
// tree is authored by a SINGLE SystemAccount.bootstrap(indexer, ANCHOR_UID, specs[]) call: each child's
// refUID is the parent UID the prior EAS.attest returned in the same call (timestamp-robust; no
// off-chain UID prediction). `parentIndex` indexes into this same array; -1 marks the root.
//
// This list MUST stay byte-identical to orchestrate.ts's BOOTSTRAP_SCAFFOLDING (same names, same order).
// The transport children = every default transport scheme (12, ADR-0011 + ADR-0063), each named with
// the TransportType the client's detectTransport() yields (utils/efs/transports.ts) — web3:// → "onchain"
// and ar:// → "arweave" differ from the URI scheme; the other ten match the scheme token. `data`
// (ADR-0063) is the inline RFC-2397 `data:` mirror transport (small files, zero storage deploys).
export interface AnchorSpec {
  name: string;
  /// index into SCAFFOLDING of this anchor's parent, or -1 for the root (refUID = ZeroHash)
  parentIndex: number;
}

export const SCAFFOLDING: AnchorSpec[] = [
  { name: "root", parentIndex: -1 }, // 0
  { name: "tags", parentIndex: 0 }, // 1 → root
  { name: "transports", parentIndex: 0 }, // 2 → root
  { name: "onchain", parentIndex: 2 }, // 3 → transports (web3://)
  { name: "ipfs", parentIndex: 2 }, // 4 → transports
  { name: "arweave", parentIndex: 2 }, // 5 → transports (ar://)
  { name: "magnet", parentIndex: 2 }, // 6 → transports
  { name: "https", parentIndex: 2 }, // 7 → transports
  { name: "ftp", parentIndex: 2 }, // 8 → transports
  { name: "s3", parentIndex: 2 }, // 9 → transports
  { name: "gs", parentIndex: 2 }, // 10 → transports
  { name: "dat", parentIndex: 2 }, // 11 → transports
  { name: "rsync", parentIndex: 2 }, // 12 → transports
  { name: "bittorrent", parentIndex: 2 }, // 13 → transports
  { name: "data", parentIndex: 2 }, // 14 → transports (data: inline, ADR-0063)
];

/// Index of the `/transports` anchor in SCAFFOLDING (its realized UID feeds setTransportsAnchor).
export const TRANSPORTS_INDEX = SCAFFOLDING.findIndex(a => a.name === "transports");

/// The impl-FREE half of the plan (PR #24 P2): everything derivable WITHOUT deploying the 7 resolver
/// impls. CREATE3 proxy addresses are impl-independent (predictProxyAddress/CreateX derive the address
/// from salt + caller only, never the impl bytecode), so the Safe-keyed proxies, their schema UIDs, and
/// the raw salts are all computable up front. This is enough to (a) detect the on-chain deploy phase and
/// (b) build every Batch-2/Batch-3 leg (they target the LIVE proxies, not the impls). The impls + Batch 1
/// (whose CreateX initcode embeds them) are only needed for a Phase-0 deploy — see `buildSafePlan`.
export interface PredictedPlan {
  safe: string;
  /// Safe-keyed CREATE3 proxy addresses (7: the 6 resolvers + SystemAccount).
  proxies: Record<ResolverName, string>;
  systemAccount: string;
  /// raw salts per CREATE3 name (leading 20 bytes = the Safe — permissioned).
  rawSalts: Record<Create3Name, string>;
  /// the 9 schema UIDs keyed against the Safe-keyed proxies.
  schemaUIDs: Record<string, string>;
}

export interface SafePlan extends PredictedPlan {
  /// resolver impl addresses (deployed by the EOA pre-batch — non-deterministic, in no UID). Populated
  /// ONLY on a Phase-0 deploy (Batch 1 needs them as CreateX initcode); a Phase-1+ resume builds the
  /// plan WITHOUT deploying impls (PR #24 P2), so this map is empty there.
  impls: Record<Create3Name, string>;
  /// Batch 1: CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts. Empty on a Phase-1+
  /// resume (no impls deployed → no initcode to embed); only built for a Phase-0 deploy.
  batch1: SafeCall[];
  /// Batch 2: register the (up to 9) not-yet-registered schemas LAST + author the whole scaffolding
  /// tree via ONE SystemAccount.bootstrap leg (timestamp-robust — no off-chain UID prediction) +
  /// SystemAccount.seal() as the last leg (PR #24 P1 fix: relay becomes module-only).
  /// Idempotent on a re-run: register legs for already-registered schemas are OMITTED (EAS register
  /// is NOT idempotent — re-including would revert `AlreadyExists`) — see `batch2RegistersOmitted`;
  /// and on a post-seal re-run (the SystemAccount proxy already deployed AND already sealed) the
  /// bootstrap + seal legs are OMITTED (they would revert `BootstrapSealed`) — see
  /// `batch2BootstrapOmitted`. A re-run of a fully-registered+sealed system therefore yields an empty
  /// Batch 2 (a clean no-op), letting recovery proceed to Batch 3.
  batch2: SafeCall[];
  /// True when Batch 2 omitted the bootstrap + seal legs because the SystemAccount was already
  /// deployed and `bootstrapSealed()` was already true (idempotent post-seal re-run).
  batch2BootstrapOmitted: boolean;
  /// Count of `SchemaRegistry.register` legs OMITTED from Batch 2 because the schema's expected UID
  /// was already registered (`getSchema(uid).uid != bytes32(0)`). EAS register is NOT idempotent — it
  /// reverts `AlreadyExists` once a UID exists — so on a re-run after a prior Batch 2 landed (e.g. a
  /// failure between Batch 2 and Batch 3) re-including the register legs would abort the whole
  /// MultiSend on the first one and strand recovery. We query the registry at plan-build time and drop
  /// the leg for any already-registered schema (same shape as the bootstrap/seal omit above). On a
  /// FIRST deploy no proxies/schemas exist yet → all 9 legs included → this is 0; on a re-run of a
  /// fully-registered system → all 9 omitted → this is 9 and (with bootstrap+seal omitted) Batch 2 is
  /// an empty no-op, so recovery proceeds to Batch 3 instead of reverting.
  batch2RegistersOmitted: number;
}

/// Init args per CREATE3 contract — IDENTICAL shape to orchestrate.ts initSpecs, except the owner
/// argument is the SAFE (born Safe-owned) instead of the deployer EOA. The schema UIDs threaded in are
/// the Safe-keyed ones (computed against the Safe-keyed proxy addresses).
function initSpecs(
  safe: string,
  proxies: Record<ResolverName, string>,
  schemaUIDs: Record<string, string>,
  registryAddr: string,
): Record<Create3Name, { fn: string; args: unknown[] }> {
  return {
    EFSIndexer: { fn: "initialize", args: [schemaUIDs.ANCHOR, schemaUIDs.PROPERTY, schemaUIDs.DATA, safe] },
    EdgeResolver: { fn: "initialize", args: [schemaUIDs.PIN, schemaUIDs.TAG, proxies.EFSIndexer, registryAddr] },
    MirrorResolver: { fn: "initialize", args: [proxies.EFSIndexer, safe] },
    ListResolver: { fn: "initialize", args: [] },
    ListEntryResolver: { fn: "initialize", args: [schemaUIDs.LIST] },
    AliasResolver: { fn: "initialize", args: [schemaUIDs.DATA, schemaUIDs.ANCHOR] },
    // WhiteoutResolver (ADR-0055): read-only kernel ref. It self-derives its WHITEOUT schema UID +
    // snapshots ANCHOR_SCHEMA_UID from the indexer in initialize(); no kernel writes, no Ownable.
    WhiteoutResolver: { fn: "initialize", args: [proxies.EFSIndexer] },
    // SystemAccount: born Safe-owned so the Safe (its owner) can author the scaffolding in Batch 2.
    SystemAccount: { fn: "initialize", args: [safe] },
  };
}

/// Predict the impl-FREE half of the plan (PR #24 P2): the Safe-keyed CREATE3 proxy addresses, their
/// raw salts, and the 9 schema UIDs — WITHOUT deploying any impl. CREATE3 addresses depend only on
/// (CreateX caller = Safe, salt), never the impl bytecode, so the whole address/UID graph is computable
/// up front. This is enough to detect the deploy phase and to build every Batch-2/Batch-3 leg (they
/// target the live proxies). The caller deploys impls + builds Batch 1 ONLY for a Phase-0 deploy.
export async function predictPlan(deployer: Signer, safe: string, log = true): Promise<PredictedPlan> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const createx = await getCreateX(deployer);

  l(`Safe-native deploy: predicting Safe-keyed CREATE3 addresses (Safe=${safe})...`);
  const proxies = {} as Record<ResolverName, string>;
  const rawSalts = {} as Record<Create3Name, string>;
  for (const r of RESOLVERS) {
    const { rawSalt, predicted } = await predictProxyAddress(createx, safe, r);
    proxies[r] = predicted;
    rawSalts[r] = rawSalt;
    l(`  ${r} proxy (Safe-keyed): ${predicted}`);
  }
  const saPredict = await predictProxyAddress(createx, safe, "SystemAccount");
  rawSalts.SystemAccount = saPredict.rawSalt;
  const systemAccount = saPredict.predicted;
  l(`  SystemAccount proxy (Safe-keyed): ${systemAccount}`);

  const schemaUIDs = computeAllSchemaUIDs(proxies);
  l("Safe-native deploy: computed Safe-keyed schema UIDs:");
  for (const s of SCHEMAS) l(`  ${s.name.padEnd(11)} ${schemaUIDs[s.name]}`);

  return { safe, proxies, systemAccount, rawSalts, schemaUIDs };
}

/// Ensure the 7 resolver/SystemAccount impls exist on-chain, deployed by the EOA via CreateX CREATE2 at
/// CONTENT-ADDRESSED addresses (in no schema UID). PR #24 P2: this is the ONLY step that deploys impls,
/// and it is called ONLY for a Phase-0 deploy (Batch 1 embeds the impl addresses as CreateX initcode).
///
/// HARDENING (this PR): impls are now deterministic + idempotent. Each impl address is
/// `f(deployer, salt, initCode)` via `predictImplAddress`, so:
///   • a RE-RUN recomputes the same address, sees code already there, and SKIPS the deploy (no
///     double-spend — the failure mode where losing the regenerable safe-batches.json artifact forced a
///     full re-deploy of all 7 impls at fresh non-deterministic addresses);
///   • a PARTIAL run (out-of-gas mid-loop) is crash-safe — a re-run reuses the impls already on-chain
///     and only deploys the remainder;
///   • a bytecode change moves the address, so "code present ⇒ reuse" can NEVER silently reuse a stale
///     impl (CREATE2 binds the initCode into the address).
/// Before spending anything on a real network, a PREFLIGHT BALANCE GUARD estimates the gas for exactly
/// the missing impls (priced with spike headroom) and throws a clear "fund N more ETH" error if the
/// deployer can't afford them — so an UNDERFUNDED run fails before the first tx rather than dying half-way
/// and orphaning impls already paid for. (It guards funding, not later logic: a throw in buildBatch1/2
/// after the impls deploy still spends that gas — but the content-addressed impls are reused on the
/// re-run, so it is never wasted.)
export async function ensureImpls(deployer: Signer, log = true): Promise<Record<Create3Name, string>> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const createx = await getCreateX(deployer);
  const deployerAddr = await deployer.getAddress();
  const allNames: Create3Name[] = [...RESOLVERS, "SystemAccount"];

  // (1) Predict every impl address (content-addressed) and split into reuse-vs-deploy by on-chain code.
  l("Safe-native deploy: ensuring resolver impls (EOA; CreateX CREATE2, content-addressed, in no UID)...");
  const plan = {} as Record<Create3Name, { rawSalt: string; initCode: string; predicted: string }>;
  const missing: Create3Name[] = [];
  for (const name of allNames) {
    const p = await predictImplAddress(createx, deployerAddr, name);
    plan[name] = p;
    if ((await ethers.provider.getCode(p.predicted)) === "0x") missing.push(name);
    else l(`  ${name} impl: ${p.predicted} (reused — already on-chain)`);
  }

  // (2) Preflight balance guard — on a real network, fail BEFORE spending if we can't finish all of the
  //     missing impls. A fully-deployed set (re-run/recovery) skips this with zero gas.
  if (missing.length === 0) {
    l("Safe-native deploy: all impls already on-chain (content-addressed) — nothing to deploy, no gas spent.");
  } else {
    await assertCanAffordImpls(createx, deployer, deployerAddr, missing, plan, log);
  }

  // (3) Deploy the missing impls deterministically. CreateX is permissioned to `deployer`, so no foreign
  //     sender can occupy these addresses — but a CONCURRENT run by the SAME deployer (two worktrees, a
  //     double-invoke) could deploy a given impl between our getCode check above and our deployCreate2
  //     here, making deployCreate2 revert "address already taken". That is benign — the impl we wanted is
  //     now on-chain — so on any deploy failure we re-check the predicted address and CONVERGE if code is
  //     present, instead of propagating a raw CreateX revert. Only a still-empty address is a real error.
  const impls = {} as Record<Create3Name, string>;
  for (const name of allNames) {
    const { rawSalt, initCode, predicted } = plan[name];
    if (!missing.includes(name)) {
      impls[name] = predicted;
      continue;
    }
    try {
      const tx = await createx["deployCreate2(bytes32,bytes)"](rawSalt, initCode);
      await tx.wait();
      l(`  ${name} impl: ${predicted} (deployed)`);
    } catch (e) {
      if ((await ethers.provider.getCode(predicted)) === "0x") throw e; // genuine failure — address still empty
      l(`  ${name} impl: ${predicted} (converged — deployed by a concurrent run)`);
    }
    if ((await ethers.provider.getCode(predicted)) === "0x") {
      throw new Error(`CREATE2 ${name}: no code at predicted impl ${predicted} after deployCreate2`);
    }
    impls[name] = predicted;
  }
  return impls;
}

/// Preflight gas/funding check for the impls about to be deployed. Sums an eth_estimateGas per missing
/// impl, adds gas-unit headroom, and prices it at a MULTIPLE of the current maxFeePerGas — then throws a
/// precise, actionable error if the deployer's balance is short, so the run fails before the first deploy
/// tx instead of dying half-way. The price multiple matters: the impls deploy as SEQUENTIAL txs over many
/// blocks, and EIP-1559 base fee can climb ~12.5%/block, so a one-shot snapshot of the current price would
/// under-fund a run that spans a rising market. We therefore require the balance to cover the estimate at
/// PREFLIGHT_PRICE_MULTIPLE × the snapshot price. (Even so, an extreme spike can strand a run mid-loop —
/// but that is fully recoverable: a re-run reuses the content-addressed impls already on-chain and only
/// deploys the remainder, so no gas is ever wasted.) No-ops harmlessly where gas is ~free (in-process
/// hardhat) or the balance is ample.
const PREFLIGHT_PRICE_MULTIPLE = 3n; // headroom for base-fee rise across the sequential impl deploys
async function assertCanAffordImpls(
  createx: Contract,
  deployer: Signer,
  deployerAddr: string,
  missing: Create3Name[],
  plan: Record<Create3Name, { rawSalt: string; initCode: string; predicted: string }>,
  log = true,
): Promise<void> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const fee = await ethers.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  let totalGas = 0n;
  for (const name of missing) {
    const { rawSalt, initCode } = plan[name];
    let gas: bigint;
    try {
      gas = await createx.getFunction("deployCreate2(bytes32,bytes)").estimateGas(rawSalt, initCode);
    } catch {
      // Fall back to a conservative size heuristic if estimateGas can't simulate (e.g. transient RPC).
      gas = BigInt(getBytes(initCode).length) * 250n + 200_000n;
    }
    totalGas += (gas * 12n) / 10n; // +20% gas-unit headroom per impl
  }
  const need = totalGas * price * PREFLIGHT_PRICE_MULTIPLE;
  const have = await ethers.provider.getBalance(deployerAddr);
  const gwei = (x: bigint) => (Number(x) / 1e9).toFixed(2);
  l(
    `Safe-native deploy: preflight — ${missing.length} impl(s) to deploy, ~${totalGas} gas; ` +
      `require ${ethers.formatEther(need)} ETH (${PREFLIGHT_PRICE_MULTIPLE}× the ${gwei(price)} gwei snapshot, ` +
      `spike headroom), have ${ethers.formatEther(have)}.`,
  );
  if (have < need) {
    throw new Error(
      `INSUFFICIENT FUNDS to deploy ${missing.length} impl(s) [${missing.join(", ")}]: deployer ${deployerAddr} ` +
        `has ${ethers.formatEther(have)} ETH but needs ~${ethers.formatEther(need)} ETH ` +
        `(${totalGas} gas at ${PREFLIGHT_PRICE_MULTIPLE}× the ${gwei(price)} gwei snapshot, for base-fee headroom). ` +
        `Fund the deployer ~${ethers.formatEther(need - have)} ETH more and re-run — already-deployed impls are ` +
        `reused (content-addressed), so no gas is wasted on a retry.`,
    );
  }
}

/// Build Batch 1 (CreateX proxy deploys, atomic init, born Safe-owned + wireContracts) from a predicted
/// plan + the impl addresses. Only used on a Phase-0 deploy — Batch 1's CreateX initcode embeds the impl
/// addresses, so it cannot be built without `ensureImpls` having run (which deploys-or-reuses them).
async function buildBatch1(
  deployer: Signer,
  predicted: PredictedPlan,
  impls: Record<Create3Name, string>,
): Promise<SafeCall[]> {
  const { safe, proxies, schemaUIDs } = predicted;
  const createx = await getCreateX(deployer);
  const registryAddr = SCHEMA_REGISTRY_ADDRESS;
  const specs = initSpecs(safe, proxies, schemaUIDs, registryAddr);
  const allNames: Create3Name[] = [...RESOLVERS, "SystemAccount"];

  const batch1: SafeCall[] = [];
  for (const name of allNames) {
    const implIface = (await ethers.getContractFactory(name, deployer)).interface;
    const initCalldata = implIface.encodeFunctionData(specs[name].fn, specs[name].args);
    // initialOwner of the TransparentUpgradeableProxy (→ its ProxyAdmin owner) = the SAFE: born-owned.
    const proxyInitCode = await buildProxyInitCode(impls[name], safe, initCalldata);
    const data = CREATEX_IFACE.encodeFunctionData("deployCreate3", [predicted.rawSalts[name], proxyInitCode]);
    batch1.push({ to: await createx.getAddress(), data, label: `deployCreate3 ${name}` });
  }
  // EFSIndexer.wireContracts — pure storage writes, no EAS call → safe pre-gate.
  {
    const indexerIface = (await ethers.getContractFactory("EFSIndexer", deployer)).interface;
    const data = indexerIface.encodeFunctionData("wireContracts", [
      proxies.EdgeResolver,
      schemaUIDs.PIN,
      schemaUIDs.TAG,
      ZeroAddress, // sortOverlay — DEFERRED
      ZeroHash, // SORT_INFO_SCHEMA_UID — DEFERRED
      proxies.MirrorResolver,
      schemaUIDs.MIRROR,
      registryAddr,
    ]);
    batch1.push({ to: proxies.EFSIndexer, data, label: "EFSIndexer.wireContracts" });
  }
  return batch1;
}

/// Build Batch 2 (register the not-yet-registered schemas LAST + author the scaffolding tree via ONE
/// SystemAccount.bootstrap leg + SystemAccount.seal()) from a predicted plan. PR #24 P2: this is
/// IMPL-FREE — every leg targets the live Safe-keyed proxies (the registry, the SystemAccount proxy),
/// never an impl. So a Phase-1 resume builds it WITHOUT deploying impls. The per-leg idempotency omits
/// (register-already-done, bootstrap-already-sealed) are resolved against on-chain state here.
export async function buildBatch2(
  deployer: Signer,
  predicted: PredictedPlan,
  log = true,
): Promise<{ batch2: SafeCall[]; batch2RegistersOmitted: number; batch2BootstrapOmitted: boolean }> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const { proxies, schemaUIDs, systemAccount } = predicted;
  const registryAddr = SCHEMA_REGISTRY_ADDRESS;

  // ── Register 9 schemas LAST. EAS SchemaRegistry.register is NOT idempotent — it reverts
  // `AlreadyExists` once a UID is registered. A *failed* Batch 2 is atomic and lands nothing, but a
  // re-run after a *successful* register (e.g. a failure between a complete Batch 2 and Batch 3) would
  // re-include the legs and revert the whole MultiSend on the first one, stranding recovery. So we query
  // the registry for each schema's expected UID and OMIT any already-registered leg. On a first deploy
  // the proxies/schemas don't exist yet → every leg is included.
  const batch2: SafeCall[] = [];
  const registryIface = new Interface([
    "function register(string schema, address resolver, bool revocable) returns (bytes32)",
  ]);
  const registry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    registryAddr,
    deployer,
  );
  let batch2RegistersOmitted = 0;
  for (const s of SCHEMAS) {
    const existing = await registry.getSchema(schemaUIDs[s.name]);
    if (existing.uid !== ZeroHash) {
      batch2RegistersOmitted++;
      l(`  register ${s.name} OMITTED — already registered (${schemaUIDs[s.name]})`);
      continue;
    }
    const data = registryIface.encodeFunctionData("register", [s.fieldString, proxies[s.resolver], s.revocable]);
    batch2.push({ to: registryAddr, data, label: `register ${s.name}` });
  }

  // Sealed-aware Batch 2 (PR #24 P1 fix — post-seal re-run safety). A *failed* Batch 2 is atomic and
  // lands nothing (no partial seal), but a re-run after a *successful* Batch 2 would rebuild a batch
  // containing bootstrap + seal and revert `BootstrapSealed` (whenNotSealed) — stranding any recovery
  // re-drive. So if the SystemAccount proxy is already deployed AND already sealed, OMIT both legs; the
  // scaffolding is already authored and the orchestrator resolves the /transports UID from the index
  // for setTransportsAnchor regardless. On a first run the proxy has no code yet (it is deployed in
  // Batch 1), so the read is guarded — absent code means not-yet-sealed → include the legs.
  let batch2BootstrapOmitted = false;
  const saCode = await ethers.provider.getCode(systemAccount);
  if (saCode !== "0x") {
    const sa = await ethers.getContractAt("SystemAccount", systemAccount, deployer);
    if (await sa.bootstrapSealed()) batch2BootstrapOmitted = true;
  }

  if (!batch2BootstrapOmitted) {
    // Scaffolding: a SINGLE SystemAccount.bootstrap leg. The whole anchor tree (root → tags/transports →
    // 12 transport children) is authored in one call that threads each child's refUID from the parent UID
    // the prior EAS.attest returned in the same call — so it is timestamp-robust (FIX 1, PR #24): no
    // off-chain UID prediction, nothing to drift against. The call is idempotent (reuses already-created
    // anchors via the index), authored THROUGH SystemAccount (attester == SystemAccount); the Safe is
    // SystemAccount's owner, so the Safe-context MultiSend leg satisfies bootstrap's onlyOwner gate
    // (bootstrap is owner-gated + whenNotSealed — PR #24 P1 fix — sealed by the seal() leg below).
    // MirrorResolver.setTransportsAnchor needs the REALIZED /transports UID, only known after Batch 2
    // executes, so it is a separate post-gate Safe tx the orchestrator issues after reading it back.
    batch2.push(await buildBootstrapCall(deployer, systemAccount, proxies.EFSIndexer, schemaUIDs.ANCHOR));
    // Seal the bootstrap ceremony as the LAST Batch-2 leg (PR #24 P1 fix): after bootstrap authors the
    // scaffolding, `seal()` permanently locks the owner's one-time write authority. The Safe is born the
    // owner here, so there is no later transfer to gate before — sealing in-batch is the equivalent of
    // the EOA path's seal-before-transfer. After this leg the steady-state relay is module-only and the
    // Safe can never emit/revoke arbitrary payloads as the permanent `system` attester (ADR-0053).
    batch2.push(await buildSealCall(deployer, systemAccount));
  } else {
    l("Safe-native deploy: SystemAccount already sealed — Batch 2 omits bootstrap + seal (post-seal re-run).");
  }

  return { batch2, batch2RegistersOmitted, batch2BootstrapOmitted };
}

/// Build the full Safe-native deploy plan for a Phase-0 deploy: predict every Safe-keyed address + UID
/// off-chain (impl-free), deploy the resolver impls from the EOA, then assemble Batch 1 (needs the
/// impls as CreateX initcode) + Batch 2 (impl-free).
///
/// PR #24 P2: impl deployment is now coupled ONLY to Batch 1. A Phase-1+ propose resume must NOT call
/// this — it would deploy 7 fresh impls no remaining batch uses (wasted gas, or an outright failure on
/// an unfunded gas EOA during a supposedly read-only resume). Such resumes use `predictPlan` +
/// `buildBatch2` directly (see orchestrateSafe.ts → proposeViaSafe). `buildSafePlan` remains the entry
/// point for the execute path (the fork rehearsal always self-deploys from Phase 0) and for a Phase-0
/// propose.
///
/// `deployer` funds the impl deploys and (in the rehearsal) executes the Safe txs; the Safe is the
/// authority + the CreateX caller + the born owner of everything.
export async function buildSafePlan(deployer: Signer, safe: string, log = true): Promise<SafePlan> {
  const predicted = await predictPlan(deployer, safe, log);
  const impls = await ensureImpls(deployer, log);
  const batch1 = await buildBatch1(deployer, predicted, impls);
  const { batch2, batch2RegistersOmitted, batch2BootstrapOmitted } = await buildBatch2(deployer, predicted, log);

  return {
    ...predicted,
    impls,
    batch1,
    batch2,
    batch2BootstrapOmitted,
    batch2RegistersOmitted,
  };
}

// ── Additive resolver deploy (ADR-0055 — adding WHITEOUT to a LIVE core) ──────────────────────────────
//
// The documented additive post-freeze case: the original frozen core (the 9 schemas on the 6 core
// resolvers) is ALREADY live on Sepolia, and only a later-appended resolver (WhiteoutResolver, or any
// future additive primitive) + its schema are missing. There is no full-core redeploy: we deploy ONLY
// the missing resolver proxies (born Safe-owned, same CreateX path Batch 1 uses) and register ONLY their
// schemas. None of the core ceremony (wireContracts / bootstrap / seal / setTransportsAnchor) re-runs —
// an additive resolver is self-contained (WhiteoutResolver's initialize(indexer) only READS the live
// kernel; its WHITEOUT schema has no scaffolding dependency). This is exactly how the local/devnet path
// (deploy/08_whiteout.ts) already handles it; this is its Safe-native counterpart.

/// The additive deploy plan: deploy + register ONLY the named missing resolvers. Two batches mirroring
/// the fresh split — Batch A1 = CreateX proxy deploys (atomic init, born Safe-owned); Batch A2 = register
/// the missing resolvers' schemas. No core ceremony. `impls` holds ONLY the missing resolvers' impls
/// (deployed from the EOA, content-addressed, in no UID). `registersOmitted` counts schema registers
/// dropped because the schema was already registered (idempotent re-run after Batch A2 landed).
export interface AdditivePlan {
  resolvers: ResolverName[];
  impls: Record<string, string>;
  batchA1: SafeCall[];
  batchA2: SafeCall[];
  registersOmitted: number;
}

/// Ensure the impls for ONLY the named additive resolvers exist on-chain (EOA, CreateX CREATE2,
/// content-addressed, in no UID) — the resolver-scoped sibling of `ensureImpls`. Idempotent + crash-safe
/// (reuses an impl already on-chain; converges on a concurrent-deploy "address taken" revert).
async function ensureImplsFor(
  deployer: Signer,
  resolvers: ResolverName[],
  log = true,
): Promise<Record<string, string>> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const createx = await getCreateX(deployer);
  const deployerAddr = await deployer.getAddress();
  const impls: Record<string, string> = {};
  for (const name of resolvers) {
    const { rawSalt, initCode, predicted } = await predictImplAddress(createx, deployerAddr, name);
    if ((await ethers.provider.getCode(predicted)) !== "0x") {
      l(`  ${name} impl: ${predicted} (reused — already on-chain)`);
      impls[name] = predicted;
      continue;
    }
    try {
      const tx = await createx["deployCreate2(bytes32,bytes)"](rawSalt, initCode);
      await tx.wait();
      l(`  ${name} impl: ${predicted} (deployed)`);
    } catch (e) {
      if ((await ethers.provider.getCode(predicted)) === "0x") throw e;
      l(`  ${name} impl: ${predicted} (converged — deployed by a concurrent run)`);
    }
    if ((await ethers.provider.getCode(predicted)) === "0x") {
      throw new Error(`CREATE2 ${name}: no code at predicted impl ${predicted} after deployCreate2`);
    }
    impls[name] = predicted;
  }
  return impls;
}

/// Build the additive deploy plan for the named missing resolvers against a LIVE core. Predicts (reuses)
/// the impl-free `predicted` plan, deploys ONLY the missing resolvers' impls, assembles Batch A1
/// (CreateX proxy deploys, atomic init, born Safe-owned) + Batch A2 (register only the missing
/// resolvers' schemas, idempotency-omitting any already registered). Throws if `resolvers` is empty
/// (caller must gate on `detectMissingResolvers`).
export async function buildAdditivePlan(
  deployer: Signer,
  predicted: PredictedPlan,
  resolvers: ResolverName[],
  log = true,
): Promise<AdditivePlan> {
  const l = (...a: unknown[]) => log && console.log(...a);
  if (resolvers.length === 0) throw new Error("buildAdditivePlan: no additive resolvers (caller must gate)");
  const { safe, proxies, schemaUIDs } = predicted;
  const createx = await getCreateX(deployer);
  const registryAddr = SCHEMA_REGISTRY_ADDRESS;

  l(`Safe-native deploy (additive): deploying ${resolvers.length} missing resolver(s): [${resolvers.join(", ")}]`);
  const impls = await ensureImplsFor(deployer, resolvers, log);
  const specs = initSpecs(safe, proxies, schemaUIDs, registryAddr);

  // ── Batch A1: CreateX proxy deploys (atomic init, born Safe-owned) for the missing resolvers only ──
  const batchA1: SafeCall[] = [];
  for (const name of resolvers) {
    const implIface = (await ethers.getContractFactory(name, deployer)).interface;
    const initCalldata = implIface.encodeFunctionData(specs[name].fn, specs[name].args);
    // initialOwner of the proxy (→ its ProxyAdmin owner) = the SAFE: born-owned, exactly like Batch 1.
    const proxyInitCode = await buildProxyInitCode(impls[name], safe, initCalldata);
    const data = CREATEX_IFACE.encodeFunctionData("deployCreate3", [predicted.rawSalts[name], proxyInitCode]);
    batchA1.push({ to: await createx.getAddress(), data, label: `deployCreate3 ${name} (additive)` });
  }

  // ── Batch A2: register ONLY the missing resolvers' schemas (idempotency-omit already-registered) ──
  const batchA2: SafeCall[] = [];
  const registryIface = new Interface([
    "function register(string schema, address resolver, bool revocable) returns (bytes32)",
  ]);
  const registry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    registryAddr,
    deployer,
  );
  const additiveSchemas = SCHEMAS.filter(s => resolvers.includes(s.resolver));
  let registersOmitted = 0;
  for (const s of additiveSchemas) {
    const existing = await registry.getSchema(schemaUIDs[s.name]);
    if (existing.uid !== ZeroHash) {
      registersOmitted++;
      l(`  register ${s.name} OMITTED — already registered (${schemaUIDs[s.name]})`);
      continue;
    }
    const data = registryIface.encodeFunctionData("register", [s.fieldString, proxies[s.resolver], s.revocable]);
    batchA2.push({ to: registryAddr, data, label: `register ${s.name} (additive)` });
  }

  return { resolvers, impls, batchA1, batchA2, registersOmitted };
}

/// The deploy phase of a (Safe-keyed) EFS system, derived from the SAME on-chain signals the execute
/// path reads (proxy code present; schema registered via SchemaRegistry.getSchema; bootstrapSealed();
/// MirrorResolver.transportsAnchorUID()). PR #24 P1: the propose path computes this to emit ONLY the
/// next un-done batch (instead of always re-emitting a fresh Batch 1).
///   0 — proxies NOT deployed                                → next: Batch 1 (deploy + wire)
///   1 — proxies live, schemas NOT all registered            → next: verify gate, then Batch 2
///   2 — registered + sealed, transports NOT wired           → next: Batch 3 (setTransportsAnchor)
///   3 — transports wired (system complete)                  → next: nothing (clean no-op)
export type DeployPhase = 0 | 1 | 2 | 3;

/// Detect the resolvers in the canonical set whose Safe-keyed proxy has NO on-chain code while the core
/// EFSIndexer IS live (ADR-0055 additive post-freeze case). On a FRESH deploy all proxies land atomically
/// in Batch 1, so this is empty for an in-progress fresh deploy. It is non-empty ONLY in the documented
/// additive case: the original frozen core is already live on-chain and a later-appended resolver
/// (WhiteoutResolver / any future additive primitive) is the only thing missing. Caller MUST have already
/// confirmed the EFSIndexer proxy has code (i.e. NOT Phase 0) — a fresh chain has no core to be additive
/// against. Read-only.
export async function detectMissingResolvers(deployer: Signer, plan: PredictedPlan): Promise<ResolverName[]> {
  void deployer;
  const missing: ResolverName[] = [];
  for (const r of RESOLVERS) {
    if (r === "EFSIndexer") continue; // the kernel; its presence is the precondition, not a candidate.
    if ((await ethers.provider.getCode(plan.proxies[r])) === "0x") missing.push(r);
  }
  return missing;
}

/// Detect the current deploy phase of `plan`'s Safe-keyed system from on-chain state. Reuses the exact
/// detection signals the execute path keys off (orchestrateSafe.ts): EFSIndexer proxy code presence
/// (all 7 proxies deploy atomically in Batch 1 — indexer code ⇒ Batch 1 landed), every schema's
/// expected UID registered in the SchemaRegistry, SystemAccount.bootstrapSealed(), and
/// MirrorResolver.transportsAnchorUID(). Read-only; no state change. Note Phase 1 is "any schema not
/// yet registered" — Batch 2's per-leg omits (batch2RegistersOmitted / batch2BootstrapOmitted, resolved
/// in buildSafePlan) handle a partially-landed Batch 2 so re-emitting Batch 2 only proposes the
/// remaining register/bootstrap/seal legs, never a duplicate of an already-landed leg.
///
/// ADDITIVE-AWARE (ADR-0055): a schema only forces Phase 1 if ITS RESOLVER PROXY IS DEPLOYED but the
/// schema isn't registered (a genuinely incomplete fresh-deploy Batch 2). A schema whose resolver proxy
/// has NO code is the additive post-freeze case (the core is already live; a later-appended resolver +
/// its schema were never deployed) — that is handled by the dedicated additive step (deploy the missing
/// resolver + register only its schema), NOT by treating the complete core as a fresh Phase-1 deploy. So
/// on a live core where only WhiteoutResolver is missing, the core phase correctly resolves to 3
/// (sealed + transports wired) and `detectMissingResolvers` drives the additive deploy.
export async function detectDeployPhase(deployer: Signer, plan: PredictedPlan): Promise<DeployPhase> {
  // Phase 0 — proxies not deployed. Key off EFSIndexer (all 7 proxies land atomically in Batch 1).
  const indexerCode = await ethers.provider.getCode(plan.proxies.EFSIndexer);
  if (indexerCode === "0x") return 0;

  // Phase 1 — proxies live but not all of their schemas registered yet. EAS register is not idempotent,
  // so a single missing registration (for a schema whose resolver proxy IS deployed) means Batch 2's
  // register legs (minus the per-leg omits) are still owed. A schema whose resolver proxy is ABSENT is
  // the additive case — skipped here, handled by the additive step — so it never masquerades as a
  // fresh-deploy Phase 1 on an already-complete core.
  const registry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    SCHEMA_REGISTRY_ADDRESS,
    deployer,
  );
  for (const s of SCHEMAS) {
    if ((await ethers.provider.getCode(plan.proxies[s.resolver])) === "0x") continue; // additive — not a Phase-1 owe
    const existing = await registry.getSchema(plan.schemaUIDs[s.name]);
    if (existing.uid === ZeroHash) return 1;
  }
  // All schemas registered — is the bootstrap ceremony sealed yet? (Batch 2's bootstrap + seal legs.)
  const sa = await ethers.getContractAt("SystemAccount", plan.systemAccount, deployer);
  if (!(await sa.bootstrapSealed())) return 1;

  // Phase 2 — registered + sealed but transports not wired (Batch 3 / setTransportsAnchor still owed).
  const mirror = await ethers.getContractAt("MirrorResolver", plan.proxies.MirrorResolver, deployer);
  const wiredTransports = await mirror.transportsAnchorUID();
  if (wiredTransports === ZeroHash) return 2;

  // Phase 3 — transports wired; the system is complete. BUT setTransportsAnchor is ONE-SHOT, so a
  // stale or hand-edited Batch 3 could have welded in the WRONG UID, which this resume would otherwise
  // accept as "done" and emit an empty artifact — while every MIRROR write then validates transport
  // ancestry against the wrong subtree (PR #24 P2). So verify the wired UID is the REALIZED /transports
  // anchor (resolvePath(root, "transports") — the exact value the execute path feeds setTransportsAnchor
  // in orchestrate.ts). A mismatch is unrecoverable on this proxy (one-shot setter already consumed), so
  // throw loudly rather than report success.
  const indexer = await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer);
  const root = await indexer.rootAnchorUID();
  const realizedTransports = await indexer.resolvePath(root, "transports");
  if (realizedTransports === ZeroHash || wiredTransports.toLowerCase() !== realizedTransports.toLowerCase()) {
    throw new Error(
      `[detectDeployPhase] MirrorResolver.transportsAnchorUID() ${wiredTransports} != realized ` +
        `/transports anchor ${realizedTransports} (root ${root}). Batch 3 wired the wrong UID into the ` +
        `one-shot setter — MIRROR ancestry validation would resolve against the wrong subtree, and this ` +
        `is unrecoverable on this proxy. Investigate before treating the ceremony as complete.`,
    );
  }
  return 3;
}

/// Encode the single `SystemAccount.bootstrap(indexer, ANCHOR_UID, specs[])` MultiSend leg that authors
/// the whole scaffolding tree. The BootstrapAnchor[] is SCAFFOLDING mapped to the on-chain struct
/// (`{ name, parentIndex, anchorSchemaToRegister=ZeroHash }`). Timestamp-robust + idempotent on-chain.
export async function buildBootstrapCall(
  deployer: Signer,
  systemAccount: string,
  indexer: string,
  anchorSchemaUID: string,
): Promise<SafeCall> {
  const saIface = (await ethers.getContractFactory("SystemAccount", deployer)).interface;
  const specs = SCAFFOLDING.map(a => ({ name: a.name, parentIndex: a.parentIndex, anchorSchemaToRegister: ZeroHash }));
  const data = saIface.encodeFunctionData("bootstrap", [indexer, anchorSchemaUID, specs]);
  return { to: systemAccount, data, label: "SystemAccount.bootstrap (scaffolding tree)" };
}

/// Encode the `SystemAccount.seal()` leg (PR #24 P1 fix) — owner-only, one-way. Permanently locks the
/// owner's bootstrap write authority; executed by the Safe (born owner) as the last Batch-2 leg, after
/// the bootstrap scaffolding. After it, the steady-state relay is module-only.
export async function buildSealCall(deployer: Signer, systemAccount: string): Promise<SafeCall> {
  const saIface = (await ethers.getContractFactory("SystemAccount", deployer)).interface;
  const data = saIface.encodeFunctionData("seal", []);
  return { to: systemAccount, data, label: "SystemAccount.seal (lock bootstrap ceremony)" };
}

/// Encode the `MirrorResolver.setTransportsAnchor(transportsUID)` leg — owner-gated; the Safe (born
/// owner) executes it with the REAL /transports UID read back from the index after Batch 2.
export async function buildSetTransportsAnchorCall(
  deployer: Signer,
  mirrorResolver: string,
  transportsUID: string,
): Promise<SafeCall> {
  const mirrorIface = (await ethers.getContractFactory("MirrorResolver", deployer)).interface;
  const data = mirrorIface.encodeFunctionData("setTransportsAnchor", [transportsUID]);
  return { to: mirrorResolver, data, label: "MirrorResolver.setTransportsAnchor" };
}
