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

import { Contract, Interface, Signer, ZeroAddress, ZeroHash } from "ethers";
import { ethers } from "hardhat";
import { EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS } from "./addresses";
import { Create3Name, buildProxyInitCode, getCreateX, predictProxyAddress } from "./create3";
import { RESOLVERS, ResolverName, SCHEMAS, computeAllSchemaUIDs } from "./schemas";
import { SafeCall } from "./safe";

// CreateX `deployCreate3(bytes32 salt, bytes initCode)` — the leg each proxy deploy is.
const CREATEX_IFACE = new Interface(["function deployCreate3(bytes32 salt, bytes initCode) payable returns (address)"]);

// ── Scaffolding spec — the bootstrap anchors, in the EXACT order orchestrate.ts authors them ─────────
// root → (tags, transports) under root; then the eleven transport children under /transports/. The whole
// tree is authored by a SINGLE SystemAccount.bootstrap(indexer, ANCHOR_UID, specs[]) call: each child's
// refUID is the parent UID the prior EAS.attest returned in the same call (timestamp-robust; no
// off-chain UID prediction). `parentIndex` indexes into this same array; -1 marks the root.
//
// This list MUST stay byte-identical to orchestrate.ts's BOOTSTRAP_SCAFFOLDING (same names, same order).
// The transport children = every scheme MirrorResolver._isAllowedScheme accepts (11), each named with
// the TransportType the client's detectTransport() yields (utils/efs/transports.ts) — web3:// → "onchain"
// and ar:// → "arweave" differ from the URI scheme; the other nine match the scheme token.
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

/// Deploy the 7 resolver/SystemAccount impls from the EOA (non-deterministic addresses, in no UID —
/// cheaper than routing impl creation through the Safe and address-irrelevant). PR #24 P2: this is the
/// ONLY step that deploys impls, and it is called ONLY for a Phase-0 deploy (Batch 1 needs the impls as
/// CreateX initcode). A Phase-1+ resume NEVER calls this — it spends no gas deploying impls no remaining
/// batch consumes (the bug this fix closes — a read-only resume on an unfunded gas EOA could fail here).
export async function deployImpls(deployer: Signer, log = true): Promise<Record<Create3Name, string>> {
  const l = (...a: unknown[]) => log && console.log(...a);
  l("Safe-native deploy: deploying resolver impls (EOA; non-deterministic, in no UID)...");
  const impls = {} as Record<Create3Name, string>;
  const allNames: Create3Name[] = [...RESOLVERS, "SystemAccount"];
  for (const name of allNames) {
    const Factory = await ethers.getContractFactory(name, deployer);
    const impl = await Factory.deploy(EAS_ADDRESS);
    await impl.waitForDeployment();
    impls[name] = await impl.getAddress();
    l(`  ${name} impl: ${impls[name]}`);
  }
  return impls;
}

/// Build Batch 1 (CreateX proxy deploys, atomic init, born Safe-owned + wireContracts) from a predicted
/// plan + the freshly-deployed impls. Only used on a Phase-0 deploy — Batch 1's CreateX initcode embeds
/// the impl addresses, so it cannot be built without `deployImpls` having run.
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
    // 5 transport children) is authored in one call that threads each child's refUID from the parent UID
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
  const impls = await deployImpls(deployer, log);
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

/// The deploy phase of a (Safe-keyed) EFS system, derived from the SAME on-chain signals the execute
/// path reads (proxy code present; schema registered via SchemaRegistry.getSchema; bootstrapSealed();
/// MirrorResolver.transportsAnchorUID()). PR #24 P1: the propose path computes this to emit ONLY the
/// next un-done batch (instead of always re-emitting a fresh Batch 1).
///   0 — proxies NOT deployed                                → next: Batch 1 (deploy + wire)
///   1 — proxies live, schemas NOT all registered            → next: verify gate, then Batch 2
///   2 — registered + sealed, transports NOT wired           → next: Batch 3 (setTransportsAnchor)
///   3 — transports wired (system complete)                  → next: nothing (clean no-op)
export type DeployPhase = 0 | 1 | 2 | 3;

/// Detect the current deploy phase of `plan`'s Safe-keyed system from on-chain state. Reuses the exact
/// detection signals the execute path keys off (orchestrateSafe.ts): EFSIndexer proxy code presence
/// (all 7 proxies deploy atomically in Batch 1 — indexer code ⇒ Batch 1 landed), every schema's
/// expected UID registered in the SchemaRegistry, SystemAccount.bootstrapSealed(), and
/// MirrorResolver.transportsAnchorUID(). Read-only; no state change. Note Phase 1 is "any schema not
/// yet registered" — Batch 2's per-leg omits (batch2RegistersOmitted / batch2BootstrapOmitted, resolved
/// in buildSafePlan) handle a partially-landed Batch 2 so re-emitting Batch 2 only proposes the
/// remaining register/bootstrap/seal legs, never a duplicate of an already-landed leg.
export async function detectDeployPhase(deployer: Signer, plan: PredictedPlan): Promise<DeployPhase> {
  // Phase 0 — proxies not deployed. Key off EFSIndexer (all 7 proxies land atomically in Batch 1).
  const indexerCode = await ethers.provider.getCode(plan.proxies.EFSIndexer);
  if (indexerCode === "0x") return 0;

  // Phase 1 — proxies live but not all 9 schemas registered yet. EAS register is not idempotent, so a
  // single missing registration means Batch 2's register legs (minus the per-leg omits) are still owed.
  const registry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    SCHEMA_REGISTRY_ADDRESS,
    deployer,
  );
  for (const s of SCHEMAS) {
    const existing = await registry.getSchema(plan.schemaUIDs[s.name]);
    if (existing.uid === ZeroHash) return 1;
  }
  // All schemas registered — is the bootstrap ceremony sealed yet? (Batch 2's bootstrap + seal legs.)
  const sa = await ethers.getContractAt("SystemAccount", plan.systemAccount, deployer);
  if (!(await sa.bootstrapSealed())) return 1;

  // Phase 2 — registered + sealed but transports not wired (Batch 3 / setTransportsAnchor still owed).
  const mirror = await ethers.getContractAt("MirrorResolver", plan.proxies.MirrorResolver, deployer);
  if ((await mirror.transportsAnchorUID()) === ZeroHash) return 2;

  // Phase 3 — transports wired; the system is complete.
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

void Contract;
