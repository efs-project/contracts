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
// scaffolding (the Safe, as SystemAccount's owner, executes the registerAnchor calls in Batch 2).
//
// The two batches map onto the existing freeze-gate split:
//   Batch 1 (PRE-gate)  = deploy all 7 proxies via CreateX (atomic init, born Safe-owned) + wire
//                         (EFSIndexer.wireContracts — pure storage, no EAS call).
//   --- 🔒 human freeze-table signing happens between the two batches ---
//   Batch 2 (POST-gate) = register the 9 schemas LAST + author the scaffolding through SystemAccount
//                         + setTransportsAnchor. (Register-then-author, preserving orchestrate.ts's
//                         ordering: anchors/transports are attestations EAS rejects until the ANCHOR
//                         schema is registered, so they MUST follow register-last.)
//
// This module produces the call lists + the off-chain UID predictions; deploy/lib/safe.ts turns a call
// list into the executable MultiSend batch, and the deploy task / fork test drive execution.

import { AbiCoder, Contract, Interface, Signer, ZeroAddress, ZeroHash, solidityPackedKeccak256 } from "ethers";
import { ethers } from "hardhat";
import { EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS } from "./addresses";
import { Create3Name, buildProxyInitCode, getCreateX, predictProxyAddress } from "./create3";
import { RESOLVERS, ResolverName, SCHEMAS, computeAllSchemaUIDs } from "./schemas";
import { SafeCall } from "./safe";

const ABI = AbiCoder.defaultAbiCoder();

// CreateX `deployCreate3(bytes32 salt, bytes initCode)` — the leg each proxy deploy is.
const CREATEX_IFACE = new Interface(["function deployCreate3(bytes32 salt, bytes initCode) payable returns (address)"]);

// ── Scaffolding spec — the bootstrap anchors, in the EXACT order orchestrate.ts authors them ─────────
// root → (tags, transports) under root; then the five transport children under /transports/. Each is a
// SystemAccount.registerAnchor(parent, name, ANCHOR_UID, ZeroHash) call → one EAS ANCHOR attestation.
export interface AnchorSpec {
  /// key for cross-referencing parents in the precompute graph
  key: string;
  name: string;
  /// parent's key, or null for the root (refUID = ZeroHash)
  parentKey: string | null;
}

export const SCAFFOLDING: AnchorSpec[] = [
  { key: "root", name: "root", parentKey: null },
  { key: "tags", name: "tags", parentKey: "root" },
  { key: "transports", name: "transports", parentKey: "root" },
  { key: "onchain", name: "onchain", parentKey: "transports" },
  { key: "ipfs", name: "ipfs", parentKey: "transports" },
  { key: "arweave", name: "arweave", parentKey: "transports" },
  { key: "magnet", name: "magnet", parentKey: "transports" },
  { key: "https", name: "https", parentKey: "transports" },
];

/// EAS UID derivation, matching EAS.sol `_getUID(attestation, bump)` byte-for-byte:
///   keccak256(abi.encodePacked(schema, recipient, attester, time, expirationTime, revocable, refUID,
///                              data, bump))
/// For a fresh attestation EAS uses bump=0 (it only increments on a UID collision, which cannot happen
/// for these distinct fresh requests). The deploy ASSERTS post-exec that the realized UID == this
/// prediction, failing loudly if a bump ever occurred. `time` is the executing block's timestamp —
/// within a single MultiSend batch every attestation shares ONE block.timestamp, so the whole anchor
/// chain is computable from that single value.
export function computeAnchorUID(args: {
  schema: string;
  recipient: string;
  attester: string;
  time: bigint;
  expirationTime: bigint;
  revocable: boolean;
  refUID: string;
  data: string;
  bump?: number;
}): string {
  return solidityPackedKeccak256(
    ["bytes32", "address", "address", "uint64", "uint64", "bool", "bytes32", "bytes", "uint32"],
    [
      args.schema,
      args.recipient,
      args.attester,
      args.time,
      args.expirationTime,
      args.revocable,
      args.refUID,
      args.data,
      args.bump ?? 0,
    ],
  );
}

/// The ANCHOR attestation `data` field exactly as SystemAccount.registerAnchor encodes it:
/// abi.encode(string name, bytes32 schemaUID=ZeroHash).
export function anchorData(name: string): string {
  return ABI.encode(["string", "bytes32"], [name, ZeroHash]);
}

export interface SafePlan {
  safe: string;
  /// Safe-keyed CREATE3 proxy addresses (7: the 6 resolvers + SystemAccount).
  proxies: Record<ResolverName, string>;
  systemAccount: string;
  /// raw salts per CREATE3 name (leading 20 bytes = the Safe — permissioned).
  rawSalts: Record<Create3Name, string>;
  /// the 9 schema UIDs keyed against the Safe-keyed proxies.
  schemaUIDs: Record<string, string>;
  /// resolver impl addresses (deployed by the EOA pre-batch — non-deterministic, in no UID).
  impls: Record<Create3Name, string>;
  /// Batch 1: CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts.
  batch1: SafeCall[];
  /// Batch 2: register 9 schemas LAST + author scaffolding + setTransportsAnchor.
  batch2: SafeCall[];
  /// off-chain scaffolding UID predictions, keyed by AnchorSpec.key. Populated once the executing
  /// block timestamp is known (predictScaffoldingUIDs).
  predictScaffoldingUIDs: (time: bigint) => Record<string, string>;
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

/// Build the full Safe-native deploy plan: predict every Safe-keyed address + UID off-chain, deploy the
/// resolver impls from the EOA (non-deterministic, in no UID — cheaper than routing impl creation
/// through the Safe and address-irrelevant), then assemble the two MultiSend batches' call lists.
///
/// `deployer` funds the impl deploys and (in the rehearsal) executes the Safe txs; the Safe is the
/// authority + the CreateX caller + the born owner of everything.
export async function buildSafePlan(deployer: Signer, safe: string, log = true): Promise<SafePlan> {
  const l = (...a: unknown[]) => log && console.log(...a);
  const createx = await getCreateX(deployer);

  // ── Predict the 7 Safe-keyed CREATE3 proxy addresses (depend only on Safe + salt) ────────────────
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

  // ── Deploy resolver impls from the EOA (in no UID; address-irrelevant) ────────────────────────────
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

  const registryAddr = SCHEMA_REGISTRY_ADDRESS;
  const specs = initSpecs(safe, proxies, schemaUIDs, registryAddr);

  // ── Batch 1: CreateX proxy deploys (atomic init, born Safe-owned) + wireContracts ────────────────
  const batch1: SafeCall[] = [];
  for (const name of allNames) {
    const implIface = (await ethers.getContractFactory(name, deployer)).interface;
    const initCalldata = implIface.encodeFunctionData(specs[name].fn, specs[name].args);
    // initialOwner of the TransparentUpgradeableProxy (→ its ProxyAdmin owner) = the SAFE: born-owned.
    const proxyInitCode = await buildProxyInitCode(impls[name], safe, initCalldata);
    const data = CREATEX_IFACE.encodeFunctionData("deployCreate3", [rawSalts[name], proxyInitCode]);
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

  // ── Batch 2: register 9 schemas LAST + author scaffolding + setTransportsAnchor ──────────────────
  const batch2: SafeCall[] = [];
  const registryIface = new Interface([
    "function register(string schema, address resolver, bool revocable) returns (bytes32)",
  ]);
  for (const s of SCHEMAS) {
    const data = registryIface.encodeFunctionData("register", [s.fieldString, proxies[s.resolver], s.revocable]);
    batch2.push({ to: registryAddr, data, label: `register ${s.name}` });
  }
  // NOTE: the scaffolding legs (registerAnchor × 8) + MirrorResolver.setTransportsAnchor are
  // TIMESTAMP-DEPENDENT and are appended to Batch 2 by assembleScaffoldingCalls(time) at execution time
  // — each registerAnchor takes the PARENT anchor's UID as an argument, and EAS folds block.timestamp
  // into every UID, so the parent UID (hence the child's refUID arg) isn't fixed until the executing
  // block is known. They are authored THROUGH SystemAccount (attester == SystemAccount); the Safe is
  // SystemAccount's owner, so the Safe-context MultiSend leg satisfies onlyAuthorizedModuleOrOwner.
  // Batch 2 as returned here holds the 9 register legs; the caller concatenates the scaffolding legs.

  const predictScaffoldingUIDs = (time: bigint): Record<string, string> => {
    const uids: Record<string, string> = {};
    for (const a of SCAFFOLDING) {
      const refUID = a.parentKey === null ? ZeroHash : uids[a.parentKey];
      uids[a.key] = computeAnchorUID({
        schema: schemaUIDs.ANCHOR,
        recipient: ZeroAddress,
        attester: systemAccount,
        time,
        expirationTime: 0n,
        revocable: false,
        refUID,
        data: anchorData(a.name),
        bump: 0,
      });
    }
    return uids;
  };

  return {
    safe,
    proxies,
    systemAccount,
    rawSalts,
    schemaUIDs,
    impls,
    batch1,
    batch2,
    predictScaffoldingUIDs,
  };
}

/// Build the timestamp-dependent Batch-2 scaffolding + setTransportsAnchor legs. The anchor chain's
/// parent UIDs depend on the executing block's timestamp (EAS folds block.timestamp into every UID),
/// so these legs are assembled once `time` is known (the next block's timestamp). All legs in one
/// MultiSend share a single block.timestamp, so the precomputed chain matches the realized chain.
///
/// Returns the scaffolding SafeCalls (one registerAnchor per anchor, in dependency order) followed by
/// MirrorResolver.setTransportsAnchor(transportsUID), plus the predicted UID map for assertion.
export async function assembleScaffoldingCalls(
  deployer: Signer,
  plan: SafePlan,
  time: bigint,
): Promise<{ calls: SafeCall[]; uids: Record<string, string> }> {
  const uids = plan.predictScaffoldingUIDs(time);
  const saIface = (await ethers.getContractFactory("SystemAccount", deployer)).interface;
  const calls: SafeCall[] = [];
  for (const a of SCAFFOLDING) {
    const parent = a.parentKey === null ? ZeroHash : uids[a.parentKey];
    const data = saIface.encodeFunctionData("registerAnchor", [parent, a.name, plan.schemaUIDs.ANCHOR, ZeroHash]);
    calls.push({ to: plan.systemAccount, data, label: `registerAnchor ${a.name}` });
  }
  // MirrorResolver.setTransportsAnchor(transportsUID) — owner-gated; the Safe (born owner) executes it.
  const mirrorIface = (await ethers.getContractFactory("MirrorResolver", deployer)).interface;
  const data = mirrorIface.encodeFunctionData("setTransportsAnchor", [uids.transports]);
  calls.push({ to: plan.proxies.MirrorResolver, data, label: "MirrorResolver.setTransportsAnchor" });
  return { calls, uids };
}

/// Read the SystemRegistry/EAS-side realized UID for an anchor and assert it equals the precomputed
/// UID (the bump-0 assertion). Throws loudly if a bump occurred or the chain drifted.
export function assertNoBump(realized: string, predicted: string, label: string): void {
  if (realized.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(
      `SAFE-DEPLOY: scaffolding UID drift for ${label} — realized ${realized} != precomputed ${predicted}. ` +
        `A bump (UID collision) or timestamp/parent drift occurred; the off-chain prediction is invalid.`,
    );
  }
}

void Contract;
