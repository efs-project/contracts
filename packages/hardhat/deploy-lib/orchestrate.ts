// EFS orchestrated CREATE3 deploy (Phase D core) — docs/DEPLOYMENT.md §3 steps 1-4, 6, 7, + a
// per-schema smoke from step 8. ADR-0048. This is the single source of truth for standing up the
// upgradeable EFS system; it is fork-rehearsable on `--network hardhat` (Sepolia fork, SE-2 default
// RPC, no private key).
//
// Sequence:
//   1. Predict all 6 proxy CREATE3 addresses (depend only on deployer+salt) → compute all 9 UIDs.
//   2. Deploy each resolver impl + its CREATE3 proxy (atomic initialize via the proxy constructor),
//      passing the precomputed UIDs/partner refs as init args.
//   3. VERIFY GATE (deploy-lib/verify.ts) — abort on any failure.
//   4. Wire: EFSIndexer.wireContracts(...), MirrorResolver.setTransportsAnchor(...), /transports/*.
//   --- FREEZE GATE (human on real Sepolia; auto on fork) ---
//   6. Register the 9 schemas LAST against the proxy addresses; assert getSchema(uid).resolver==proxy.
//   7. Transfer every ProxyAdmin owner + resolver Ownable owner to the Safe; assert owner()==Safe.
//   8. Per-schema smoke: push one attestation through each of the 9 schemas; assert no revert.

import { Contract, Signer, ZeroAddress, ZeroHash } from "ethers";
import { ethers } from "hardhat";
import { EAS_ADDRESS, SCHEMA_REGISTRY_ADDRESS } from "./addresses";
import { Create3DeployResult, Create3Name, deployResolverViaCreate3, getCreateX, predictProxyAddress } from "./create3";
import { RESOLVERS, ResolverName, SCHEMAS, computeAllSchemaUIDs } from "./schemas";
import { runVerifyGate } from "./verify";

export type RunMode = "full" | "until-freeze-gate" | "after-freeze-gate";

export interface OrchestrationResult {
  deploys: Record<string, Create3DeployResult>;
  proxies: Record<ResolverName, string>;
  /// The deterministic CREATE3 address of the SystemAccount proxy (ADR-0053). Etched at first
  /// canonical write — it authors the bootstrap scaffolding and is the default-lens tail.
  systemAccount: string;
  schemaUIDs: Record<string, string>;
  transportsAnchorUID: string;
  safe: string;
  registered: boolean;
  ownershipTransferred: boolean;
}

const EAS_IFACE = [
  "function getSchemaRegistry() view returns (address)",
  "function attest((bytes32 schema,(address recipient,uint64 expirationTime,bool revocable,bytes32 refUID,bytes data,uint256 value) data)) payable returns (bytes32)",
  "function getAttestation(bytes32 uid) view returns (tuple(bytes32 uid,bytes32 schema,uint64 time,uint64 expirationTime,uint64 revocationTime,bytes32 refUID,address recipient,address attester,bool revocable,bytes data))",
  // uid is NON-indexed (in data); schemaUID is the indexed topic. See IEAS.sol.
  "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)",
];

async function getEAS(signer: Signer): Promise<Contract> {
  return new ethers.Contract(EAS_ADDRESS, EAS_IFACE, signer);
}

async function getSchemaRegistry(signer: Signer): Promise<Contract> {
  const eas = await getEAS(signer);
  let addr = SCHEMA_REGISTRY_ADDRESS;
  try {
    addr = await eas.getSchemaRegistry();
  } catch {
    /* fall back to constant */
  }
  return ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    addr,
    signer,
  );
}

function extractAttestedUID(receipt: any, eas: Contract): string {
  for (const log of receipt?.logs ?? []) {
    try {
      const parsed = eas.interface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "Attested") return parsed.args.uid; // uid is the non-indexed data field
    } catch {
      /* not an Attested log */
    }
  }
  return ZeroHash;
}

// EIP-1967 admin slot: bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1).
const EIP1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

/// Read the ProxyAdmin address from a TransparentUpgradeableProxy's EIP-1967 admin slot.
async function readProxyAdmin(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_ADMIN_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

// EIP-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1).
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/// Read the implementation address from a TransparentUpgradeableProxy's EIP-1967 impl slot. Used by
/// the --after-freeze-gate resume to hand the verify gate the LIVE impl behind each re-bound proxy, so
/// the gate's impl-direct `_disableInitializers` lock check runs on the register path too (mirrors the
/// Safe path's buildDeploysFromOnchain).
async function readImplementation(proxy: string): Promise<string> {
  const raw = await ethers.provider.getStorage(proxy, EIP1967_IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

// ── Bootstrap scaffolding tree (root → tags/transports → 11 transport children) ───────────────────
// The whole tree is authored by ONE timestamp-robust SystemAccount.bootstrap call (FIX 1, PR #24):
// each child's refUID is threaded from the parent UID the prior EAS.attest returned in the same call,
// so nothing is predicted off-chain. parentIndex indexes into this array; -1 = root (refUID=ZeroHash).
//
// The transport children = every scheme MirrorResolver._isAllowedScheme accepts (11). Each name is the
// TransportType the client's detectTransport() yields, since the explorer resolves /transports/<name>
// with that exact string before minting a MIRROR (utils/efs/transports.ts). web3:// → "onchain" and
// ar:// → "arweave" are the two where the anchor name differs from the URI scheme; the other nine match
// the scheme token. All 11 must be canonical /transports/* anchors so no scheme is left squattable
// (first-writer-wins) on a fresh deploy.
const BOOTSTRAP_SCAFFOLDING: { name: string; parentIndex: number }[] = [
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

export async function orchestrate(deployer: Signer, mode: RunMode, log = true): Promise<OrchestrationResult> {
  const deployerAddr = await deployer.getAddress();
  const l = (...a: unknown[]) => log && console.log(...a);

  const createx = await getCreateX(deployer);
  const schemaRegistry = await getSchemaRegistry(deployer);
  const eas = await getEAS(deployer);

  // ── Step 1: predict all proxy addresses, compute all UIDs ──────────────────────────────────
  // SystemAccount (ADR-0053) is predicted/deployed alongside the resolvers (own committed salt,
  // frozen for address stability) but is NOT in any schema UID — so it does NOT feed
  // computeAllSchemaUIDs. The schema UIDs depend only on the six resolver proxy addresses.
  l("EFS deploy: predicting CREATE3 proxy addresses...");
  const proxies = {} as Record<ResolverName, string>;
  const rawSalts = {} as Record<Create3Name, string>;
  for (const r of RESOLVERS) {
    const { rawSalt, predicted } = await predictProxyAddress(createx, deployerAddr, r);
    proxies[r] = predicted;
    rawSalts[r] = rawSalt;
    l(`  ${r} proxy (predicted): ${predicted}`);
  }
  const systemAccountPredict = await predictProxyAddress(createx, deployerAddr, "SystemAccount");
  rawSalts.SystemAccount = systemAccountPredict.rawSalt;
  let systemAccountAddr = systemAccountPredict.predicted;
  l(`  SystemAccount proxy (predicted): ${systemAccountAddr}`);
  const schemaUIDs = computeAllSchemaUIDs(proxies);
  l("EFS deploy: computed schema UIDs:");
  for (const s of SCHEMAS) l(`  ${s.name.padEnd(11)} ${schemaUIDs[s.name]}`);

  // ── Step 2: deploy each resolver impl + CREATE3 proxy (atomic init) ─────────────────────────
  const registryAddr = await schemaRegistry.getAddress();
  const initSpecs: Record<ResolverName, { fn: string; args: unknown[] }> = {
    EFSIndexer: {
      fn: "initialize",
      args: [schemaUIDs.ANCHOR, schemaUIDs.PROPERTY, schemaUIDs.DATA, deployerAddr],
    },
    EdgeResolver: {
      fn: "initialize",
      args: [schemaUIDs.PIN, schemaUIDs.TAG, proxies.EFSIndexer, registryAddr],
    },
    MirrorResolver: { fn: "initialize", args: [proxies.EFSIndexer, deployerAddr] },
    ListResolver: { fn: "initialize", args: [] },
    ListEntryResolver: { fn: "initialize", args: [schemaUIDs.LIST] },
    AliasResolver: { fn: "initialize", args: [schemaUIDs.DATA, schemaUIDs.ANCHOR] },
  };

  const deploys: Record<string, Create3DeployResult> = {};

  if (mode === "after-freeze-gate") {
    // Proxies were deployed in the --until-freeze-gate run. Re-bind from the predicted addresses
    // (CREATE3 is deterministic) rather than redeploying (CreateX would revert: address taken).
    l("EFS deploy: --after-freeze-gate — re-binding existing proxies (no redeploy)...");
    for (const r of RESOLVERS) {
      const proxy = proxies[r];
      const code = await ethers.provider.getCode(proxy);
      if (code === "0x") {
        throw new Error(`after-freeze-gate: no proxy at predicted ${proxy} for ${r} — run --until-freeze-gate first`);
      }
      // Read the LIVE impl from the proxy's EIP-1967 slot so the verify gate (run below, before the
      // irreversible register) can assert the impl is initializer-locked — not just blank it. (P2,
      // PR #24 50yr-review.)
      const impl = await readImplementation(proxy);
      if (impl === ZeroAddress) {
        throw new Error(`after-freeze-gate: proxy ${proxy} for ${r} has a zero EIP-1967 implementation slot`);
      }
      deploys[r] = {
        resolver: r,
        impl,
        proxy,
        predicted: proxy,
        proxyAdmin: await readProxyAdmin(proxy),
        rawSalt: rawSalts[r],
      };
    }
    // Re-bind SystemAccount too (ADR-0053) — deployed in the until-freeze-gate run.
    const saCode = await ethers.provider.getCode(systemAccountAddr);
    if (saCode === "0x") {
      throw new Error(
        `after-freeze-gate: no proxy at predicted ${systemAccountAddr} for SystemAccount — run --until-freeze-gate first`,
      );
    }
    const saImpl = await readImplementation(systemAccountAddr);
    if (saImpl === ZeroAddress) {
      throw new Error(
        `after-freeze-gate: SystemAccount proxy ${systemAccountAddr} has a zero EIP-1967 implementation slot`,
      );
    }
    deploys.SystemAccount = {
      resolver: "SystemAccount",
      impl: saImpl,
      proxy: systemAccountAddr,
      predicted: systemAccountAddr,
      proxyAdmin: await readProxyAdmin(systemAccountAddr),
      rawSalt: rawSalts.SystemAccount,
    };
    // Run the FULL verify gate against the live re-bound proxies BEFORE the irreversible register
    // (P2, PR #24 50yr-review). --until-freeze-gate and --after-freeze-gate are SEPARATE processes;
    // if the operator rebases/updates the deploy code between them, a drifted Indexer/Edge config,
    // EAS address, init-supplied cross-ref UID, or field-string could otherwise be registered
    // permanently — registerAndTransfer's own pre-register check only re-asserts the two self-derived
    // UID getters. This mirrors the Safe path (orchestrateSafe.ts: buildDeploysFromOnchain +
    // runVerifyGate at Phase 1, before Batch 2). Throws on any drift → no schema is registered.
    l("EFS deploy: --after-freeze-gate — running full verify gate against re-bound proxies (pre-register)...");
    await runVerifyGate({ deploys, schemaUIDs, deployer });
    const result: OrchestrationResult = {
      deploys,
      proxies,
      systemAccount: systemAccountAddr,
      schemaUIDs,
      transportsAnchorUID: ZeroHash,
      safe: ZeroAddress,
      registered: false,
      ownershipTransferred: false,
    };
    await registerAndTransfer(result, deployer, schemaRegistry, eas, l);
    return result;
  }

  l("EFS deploy: deploying impls + CREATE3 proxies (atomic init)...");
  for (const r of RESOLVERS) {
    const spec = initSpecs[r];
    const res = await deployResolverViaCreate3(createx, deployer, r, [EAS_ADDRESS], spec.fn, spec.args);
    deploys[r] = res;
    l(`  ${r}: impl=${res.impl} proxy=${res.proxy} proxyAdmin=${res.proxyAdmin}`);
  }

  // SystemAccount (ADR-0053): same proxy-deploy phase as the resolvers, own committed salt.
  // Constructor takes IEAS; initialize(owner_=deployer) makes the deployer the ceremony owner so it
  // can author the bootstrap scaffolding through the relay. Not a resolver (in no schema UID).
  {
    const res = await deployResolverViaCreate3(createx, deployer, "SystemAccount", [EAS_ADDRESS], "initialize", [
      deployerAddr,
    ]);
    deploys.SystemAccount = res;
    systemAccountAddr = res.proxy; // realized == predicted (asserted inside deployResolverViaCreate3)
    l(`  SystemAccount: impl=${res.impl} proxy=${res.proxy} proxyAdmin=${res.proxyAdmin}`);
  }

  // ── Step 3: VERIFY GATE ─────────────────────────────────────────────────────────────────────
  l("EFS deploy: running verify gate...");
  await runVerifyGate({ deploys, schemaUIDs, deployer });

  // ── Step 4: wire partners (no attestations) ────────────────────────────────────────────────
  // NOTE on ordering: the /transports/* anchors and the live smokes are ATTESTATIONS, which EAS
  // rejects (InvalidSchema) until the ANCHOR schema is registered — i.e. they cannot run before the
  // register-last step. So the only pre-freeze-gate wiring is EFSIndexer.wireContracts (pure storage
  // writes, no EAS call). The /transports/* anchors + MirrorResolver.setTransportsAnchor run in
  // registerAndTransfer(), AFTER registration but BEFORE ownership transfer (setTransportsAnchor is
  // onlyOwner, owner is still the deployer there). This is the correct read of DEPLOYMENT.md §3: the
  // anchor *data writes* belong with/after register-last; only the resolver-config wiring is pre-gate.
  l("EFS deploy: wiring partners (wireContracts; SORT_INFO deferred → zero)...");
  const indexer = await ethers.getContractAt("EFSIndexer", proxies.EFSIndexer, deployer);

  if ((await indexer.edgeResolver()) === ZeroAddress) {
    await (
      await indexer.wireContracts(
        proxies.EdgeResolver,
        schemaUIDs.PIN,
        schemaUIDs.TAG,
        ZeroAddress, // sortOverlay — DEFERRED
        ZeroHash, // SORT_INFO_SCHEMA_UID — DEFERRED
        proxies.MirrorResolver,
        schemaUIDs.MIRROR,
        registryAddr,
      )
    ).wait();
    l("  EFSIndexer.wireContracts done");
  }

  const result: OrchestrationResult = {
    deploys,
    proxies,
    systemAccount: systemAccountAddr,
    schemaUIDs,
    transportsAnchorUID: ZeroHash,
    safe: ZeroAddress,
    registered: false,
    ownershipTransferred: false,
  };

  // ── 🔒 FREEZE GATE ──────────────────────────────────────────────────────────────────────────
  if (mode === "until-freeze-gate") {
    l("EFS deploy: STOP — reached freeze gate (--until-freeze-gate). No schema registered.");
    l("           Fill + sign docs/SEPOLIA_FREEZE_TABLE.md, then run --after-freeze-gate.");
    return result;
  }

  await registerAndTransfer(result, deployer, schemaRegistry, eas, l);
  return result;
}

/// Steps 6 + (post-register anchors) + 7 + 8: register the 9 schemas LAST, create the /transports/*
/// anchors + setTransportsAnchor, transfer all ownership to the Safe, then the per-schema smoke.
export async function registerAndTransfer(
  result: OrchestrationResult,
  deployer: Signer,
  schemaRegistry: Contract,
  eas: Contract,
  l: (...a: unknown[]) => void,
): Promise<void> {
  const { proxies, schemaUIDs } = result;

  // ── I-4 guard: re-assert the on-chain self-UID getters against the about-to-be-registered UIDs,
  //    immediately before the irreversible register. `until-freeze-gate` and `after-freeze-gate` run
  //    as SEPARATE processes (separate schemas.ts reads), so a drift between runs could otherwise
  //    register a permanent schema whose UID doesn't match what the deployed ListEntry/Alias proxies
  //    self-derived. The verify gate does this in the until-gate run; this re-does it on the path that
  //    actually registers (after-freeze-gate re-binds proxies and skips the verify gate). Abort loudly
  //    on mismatch — no schema is registered against a drifted proxy. (docs/DEPLOYMENT.md §3 step 3.)
  l("EFS deploy: re-asserting self-UID getters on the deployed proxies before register...");
  const listEntryProxy = (await ethers.getContractAt(
    "ListEntryResolver",
    proxies.ListEntryResolver,
    deployer,
  )) as unknown as Contract;
  const onchainListEntryUID: string = await listEntryProxy.listEntrySchemaUID();
  if (onchainListEntryUID.toLowerCase() !== schemaUIDs.LIST_ENTRY.toLowerCase()) {
    throw new Error(
      `REGISTER ABORT: ListEntryResolver.listEntrySchemaUID() ${onchainListEntryUID} != to-be-registered ` +
        `LIST_ENTRY UID ${schemaUIDs.LIST_ENTRY} — proxy/schema drift between freeze-gate runs.`,
    );
  }
  const aliasProxy = (await ethers.getContractAt(
    "AliasResolver",
    proxies.AliasResolver,
    deployer,
  )) as unknown as Contract;
  const onchainRedirectUID: string = await aliasProxy.redirectSchemaUID();
  if (onchainRedirectUID.toLowerCase() !== schemaUIDs.REDIRECT.toLowerCase()) {
    throw new Error(
      `REGISTER ABORT: AliasResolver.redirectSchemaUID() ${onchainRedirectUID} != to-be-registered ` +
        `REDIRECT UID ${schemaUIDs.REDIRECT} — proxy/schema drift between freeze-gate runs.`,
    );
  }

  // ── Step 6: register LAST ─────────────────────────────────────────────────────────────────
  // FIX (PR #24 P1): the EOA path registers each schema in a SEPARATE tx and only creates the
  // canonical root LATER (SystemAccount.bootstrap). On a public network there is a mempool window
  // between ANCHOR registration and bootstrap during which `EFSIndexer.rootAnchorUID` is still zero
  // and the FIRST generic ANCHOR anyone attests is permanently accepted as root (EFSIndexer.sol:385)
  // — a front-runner can make the canonical root attacker-authored. The Safe-native ceremony closes
  // this by registering + bootstrapping ATOMICALLY in one MultiSend batch (deploy-lib/safePlan.ts
  // Batch 2). So the EOA register/bootstrap path is allowed ONLY on the local pinned fork (chainId
  // 31337, no adversarial mempool); any real network MUST use EFS_DEPLOY_VIA_SAFE=1. (Modes that
  // stop before registration — `until-freeze-gate` — already returned above and are unaffected.)
  const chainId = Number((await deployer.provider!.getNetwork()).chainId);
  if (chainId !== 31337) {
    throw new Error(
      `[orchestrate] EOA register/bootstrap is disallowed on chainId ${chainId} (front-run risk on ` +
        `root establishment before bootstrap — PR #24 P1). Real-network registration must go through ` +
        `the atomic Safe-native ceremony: set EFS_DEPLOY_VIA_SAFE=1 + EFS_SAFE_ADDRESS=<Safe> ` +
        `(docs/DEPLOYMENT.md §3). The EOA path may still deploy+wire (--until-freeze-gate) anywhere.`,
    );
  }
  l("EFS deploy: registering 9 schemas LAST...");
  for (const s of SCHEMAS) {
    const resolver = proxies[s.resolver];
    const uid = schemaUIDs[s.name];
    try {
      await (await schemaRegistry.register(s.fieldString, resolver, s.revocable)).wait();
    } catch {
      l(`  ${s.name}: register reverted (likely AlreadyExists) — continuing`);
    }
    const rec = await schemaRegistry.getSchema(uid);
    if (rec.resolver.toLowerCase() !== resolver.toLowerCase()) {
      throw new Error(`REGISTER: ${s.name} getSchema(${uid}).resolver ${rec.resolver} != proxy ${resolver}`);
    }
    l(`  ${s.name.padEnd(11)} registered @ ${uid} (resolver ${resolver})`);
  }
  result.registered = true;

  // ── Post-register scaffolding: root, tags, /transports/* via ONE SystemAccount.bootstrap call,
  //    then setTransportsAnchor (owner still deployer). ADR-0053: authored THROUGH SystemAccount
  //    (attester == SystemAccount address), not the deployer EOA — the deployer is SystemAccount's
  //    owner during the ceremony, so it may author via the relay. FIX 1 (PR #24): bootstrap threads
  //    the real EAS UIDs in memory (timestamp-robust, no off-chain prediction) and is idempotent
  //    (reuses already-created anchors — incl. the root via indexer.rootAnchorUID(), FIX 2), so an
  //    --after-freeze-gate retry after root already exists reuses it instead of re-attesting (which
  //    EFSIndexer rejects once rootAnchorUID is set).
  const indexer = (await ethers.getContractAt("EFSIndexer", proxies.EFSIndexer, deployer)) as unknown as Contract;
  const mirror = (await ethers.getContractAt(
    "MirrorResolver",
    proxies.MirrorResolver,
    deployer,
  )) as unknown as Contract;
  const systemAccount = (await ethers.getContractAt(
    "SystemAccount",
    result.systemAccount,
    deployer,
  )) as unknown as Contract;
  // ── Bootstrap + seal, sealed-aware (PR #24 P1 fix — post-seal retry safety) ─────────────────
  // A previous --after-freeze-gate run may have reached seal() and then FAILED before ownership
  // transfer completed (e.g. resolveSafe() throwing on an invalid EFS_SAFE_ADDRESS, or a partial
  // transfer). On the retry the scaffolding is already realized AND the ceremony is already sealed,
  // so calling bootstrap() again would revert `BootstrapSealed` (whenNotSealed) and strand recovery
  // forever. Branch on the on-chain sealed flag:
  //   • Not sealed (first run, or pre-seal failure): bootstrap(specs) then seal() — current behavior.
  //   • Already sealed (post-seal retry): SKIP both. The anchors are already authored; the steps below
  //     resolve the real UIDs from the index (rootAnchorUID / resolvePath) so transfer can finish.
  // bootstrap itself is idempotent (reuses existing anchors) but is gated whenNotSealed, so the SKIP
  // is what makes a post-seal retry safe — the not-sealed branch covers a pre-seal partial.
  if (!(await systemAccount.bootstrapSealed())) {
    const specs = BOOTSTRAP_SCAFFOLDING.map(a => ({
      name: a.name,
      parentIndex: a.parentIndex,
      anchorSchemaToRegister: ZeroHash,
    }));
    await (await systemAccount.bootstrap(proxies.EFSIndexer, schemaUIDs.ANCHOR, specs)).wait();
    // Permanently lock the owner's one-time bootstrap write authority BEFORE ownership transfers to
    // the Safe. After this the steady-state relay is module-only — the Safe (a human multisig) can
    // never emit/revoke arbitrary payloads as the permanent `system` attester (ADR-0053 content-
    // authority split). Ordering: deploy → wire → register → bootstrap → SEAL → transfer-ownership.
    await (await systemAccount.seal()).wait();
    l("  SystemAccount.bootstrap + seal() — scaffolding authored, ceremony permanently sealed");
  } else {
    l("  SystemAccount already sealed — skipping bootstrap + seal (post-seal retry); reusing anchors");
  }
  // Read the realized UIDs back from the index (bootstrap returns them too, but a state-changing call
  // doesn't surface its return value off-chain without a static call — the index read is canonical).
  const rootUID: string = await indexer.rootAnchorUID();
  l(`  root anchor: ${rootUID} (attester=SystemAccount ${result.systemAccount})`);
  const transportsUID: string = await indexer.resolvePath(rootUID, "transports");
  result.transportsAnchorUID = transportsUID;
  if ((await mirror.transportsAnchorUID()) === ZeroHash) {
    await (await mirror.setTransportsAnchor(transportsUID)).wait();
    l(`  MirrorResolver.transportsAnchorUID = ${transportsUID}`);
  }

  // ── Step 8 (smoke): push one attestation through each of the 9 schemas BEFORE handing off
  //     ownership (deployer is the attester; works on the fork without the Safe signer).
  await perSchemaSmoke(result, deployer, eas, indexer, rootUID, l);

  // ── Step 7: transfer ownership to the Safe ──────────────────────────────────────────────────
  const deployerAddr = await deployer.getAddress();
  const safe = await resolveSafe(deployer);
  result.safe = safe;
  l(`EFS deploy: transferring ownership to Safe ${safe}...`);

  // Each TransparentUpgradeableProxy auto-created a ProxyAdmin (Ownable) owned by the deployer.
  for (const d of Object.values(result.deploys)) {
    const pa = await ethers.getContractAt(
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
      d.proxyAdmin,
      deployer,
    );
    if ((await pa.owner()).toLowerCase() === deployerAddr.toLowerCase()) {
      await (await pa.transferOwnership(safe)).wait();
    }
    if ((await pa.owner()).toLowerCase() !== safe.toLowerCase()) {
      throw new Error(`OWNERSHIP: ProxyAdmin ${d.proxyAdmin} (${d.resolver}) owner != Safe`);
    }
  }

  // Ownable resolvers: EFSIndexer + MirrorResolver (the only two with OwnableUpgradeable).
  for (const r of ["EFSIndexer", "MirrorResolver"] as ResolverName[]) {
    const c = await ethers.getContractAt(r, proxies[r], deployer);
    if ((await c.owner()).toLowerCase() === deployerAddr.toLowerCase()) {
      await (await c.transferOwnership(safe)).wait();
    }
    if ((await c.owner()).toLowerCase() !== safe.toLowerCase()) {
      throw new Error(`OWNERSHIP: ${r} owner != Safe`);
    }
  }

  // SystemAccount (ADR-0053): OwnableUpgradeable like the resolvers. Transfer its owner to the Safe
  // alongside them (the membership authority — setModuleAuthorization — is the Safe's, pre-burn).
  {
    const sa = await ethers.getContractAt("SystemAccount", result.systemAccount, deployer);
    if ((await sa.owner()).toLowerCase() === deployerAddr.toLowerCase()) {
      await (await sa.transferOwnership(safe)).wait();
    }
    if ((await sa.owner()).toLowerCase() !== safe.toLowerCase()) {
      throw new Error("OWNERSHIP: SystemAccount owner != Safe");
    }
  }
  result.ownershipTransferred = true;
  l("  ownership transferred; deployer holds no proxy-admin or resolver ownership.");
}

/// Resolve the ownership-transfer target (the EFS.eth Safe). Single-step transfer is irreversible
/// (Ownable/OwnableUpgradeable + OZ v5 ProxyAdmin — no Ownable2Step accept), so an unset/invalid Safe
/// on a real network would hand the permanent upgrade authority to an arbitrary address (I-5a). HARD-
/// FAIL everywhere except the in-process `hardhat` fork, where a distinct second signer stands in as
/// the test Safe for the rehearsal (there is no real Safe and no human on the fork).
async function resolveSafe(deployer: Signer): Promise<string> {
  const env = process.env.EFS_SAFE_ADDRESS;
  const net = await ethers.provider.getNetwork();
  const networkName = net.name;
  // Fork-rehearsal detection: the deploy is a throwaway local rehearsal whenever it runs on the
  // chainId-31337 dev chain — whether reached as the in-process `hardhat` network (test suite) OR as
  // the `localhost` network pointed at a `yarn fork`/`yarn chain` node (the CI deploy-pin-check job:
  // `LOCALHOST_RPC_URL=… yarn deploy`). Real Sepolia/mainnet have distinct chainIds (11155111 / 1)
  // and network names, so this never loosens the hard-fail on a real target. (SE-2 also sometimes
  // reports a forked chain's name as "unknown"; accept that too.)
  const isForkRehearsal = net.chainId === 31337n || networkName === "hardhat" || networkName === "unknown";

  // A well-formed, non-zero checksummed address is required on any non-fork-rehearsal network.
  const valid = !!env && ethers.isAddress(env) && env !== ZeroAddress;
  if (valid) {
    const checksummed = ethers.getAddress(env as string);
    if (checksummed === ZeroAddress) {
      throw new Error("EFS_SAFE_ADDRESS resolves to the zero address — refusing to transfer ownership.");
    }
    // Address syntax alone is not enough on a real network (I-5a): a typo to an EOA, a self-destructed
    // contract, or a non-Safe contract would permanently transfer every ProxyAdmin/resolver/SystemAccount
    // owner to an address with no Safe governance path (single-step, irreversible). Require that the
    // target (1) has deployed code and (2) actually behaves like a Safe — getThreshold() returns nonzero
    // and getOwners() returns a non-empty owner set. On the fork rehearsal the test Safe is freshly
    // deployed via the canonical factory and this check would pass too, but we skip it there to keep the
    // rehearsal path independent of any extra RPC round-trips and degenerate test-Safe shapes.
    if (!isForkRehearsal) {
      await assertIsSafe(checksummed, networkName);
    }
    return checksummed;
  }

  if (!isForkRehearsal) {
    throw new Error(
      `EFS_SAFE_ADDRESS is unset/zero/invalid (got ${env ?? "<unset>"}) on network "${networkName}". ` +
        `The single-step ownership transfer is IRREVERSIBLE — set EFS_SAFE_ADDRESS to the checksummed ` +
        `EFS.eth Safe address before the --after-freeze-gate run. Refusing to transfer to an arbitrary address.`,
    );
  }

  // Fork rehearsal ONLY (hardhat): no real Safe — use a distinct second signer as the test Safe.
  const deployerAddr = await deployer.getAddress();
  const signers = await ethers.getSigners();
  for (const s of signers) {
    const a = await s.getAddress();
    if (a.toLowerCase() !== deployerAddr.toLowerCase()) return a;
  }
  return signers[1].getAddress();
}

/// Minimal Safe ABI for the read-only sanity check (subset of deploy-lib/safe.ts's SAFE_ABI). Reused
/// here rather than importing getSafe(), which binds to a Signer; the check needs only provider reads.
const SAFE_SANITY_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
];

/// Sanity-check that `addr` is a live Safe before accepting it as the irreversible ownership-transfer
/// target on a real network (I-5a). Throws a clear, abort-the-deploy error if `addr` has no code, or if
/// the Safe ABI probes revert or return degenerate values (threshold 0 / empty owner set). Skipped on the
/// fork rehearsal by the caller — only runs on real Sepolia/mainnet.
async function assertIsSafe(addr: string, networkName: string): Promise<void> {
  const code = await ethers.provider.getCode(addr);
  if (code === "0x" || code === "0x0") {
    throw new Error(
      `EFS_SAFE_ADDRESS ${addr} has NO deployed code on network "${networkName}" — it is an EOA or an ` +
        `unfunded/typo'd address. The single-step ownership transfer is IRREVERSIBLE; refusing to hand ` +
        `permanent upgrade authority to a non-contract. Double-check the checksummed EFS.eth Safe address.`,
    );
  }

  const safe = new ethers.Contract(addr, SAFE_SANITY_ABI, ethers.provider);
  let threshold: bigint;
  let owners: string[];
  try {
    threshold = await safe.getThreshold();
    owners = await safe.getOwners();
  } catch (e) {
    throw new Error(
      `EFS_SAFE_ADDRESS ${addr} has code but does not respond to the Safe interface ` +
        `(getThreshold()/getOwners() reverted) on network "${networkName}": ${(e as Error).message}. ` +
        `It is a contract but not a Gnosis Safe — refusing the irreversible ownership transfer.`,
    );
  }
  if (threshold === 0n) {
    throw new Error(
      `EFS_SAFE_ADDRESS ${addr} reports getThreshold() == 0 on network "${networkName}" — not a valid ` +
        `Safe configuration. Refusing the irreversible ownership transfer.`,
    );
  }
  if (owners.length === 0) {
    throw new Error(
      `EFS_SAFE_ADDRESS ${addr} reports an empty owner set (getOwners() == []) on network ` +
        `"${networkName}" — not a valid Safe configuration. Refusing the irreversible ownership transfer.`,
    );
  }
}

/// Step 8 (subset): push one attestation through each of the 9 schemas; assert no revert + index write.
async function perSchemaSmoke(
  result: OrchestrationResult,
  deployer: Signer,
  eas: Contract,
  indexer: Contract,
  rootUID: string,
  l: (...a: unknown[]) => void,
): Promise<void> {
  l("EFS deploy: per-schema smoke (1 attestation per schema)...");
  const { schemaUIDs } = result;
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const attesterAddr = await deployer.getAddress();

  const attest = async (schema: string, data: string, refUID = ZeroHash, revocable = true) => {
    const tx = await eas.attest({
      schema,
      data: { recipient: ZeroAddress, expirationTime: 0, revocable, refUID, data, value: 0 },
    });
    return extractAttestedUID(await tx.wait(), eas);
  };

  // ANCHOR (file under root) — retry-safe (FIX 3, PR #24): the smoke anchor is non-revocable and its
  // name is deterministic ("smoke.txt"), so a re-attest on an --after-freeze-gate retry would hit
  // DuplicateFileName and abort before ownership transfer. Reuse the existing anchor if the index
  // already has it; only attest when absent. (Deterministic + idempotent — no random name.)
  let fileAnchor: string = await indexer.resolvePath(rootUID, "smoke.txt");
  if (fileAnchor === ZeroHash) {
    fileAnchor = await attest(
      schemaUIDs.ANCHOR,
      abi.encode(["string", "bytes32"], ["smoke.txt", ZeroHash]),
      rootUID,
      false,
    );
  }
  if (fileAnchor === ZeroHash) throw new Error("SMOKE: ANCHOR produced no UID");

  // DATA (empty)
  const dataUID = await attest(schemaUIDs.DATA, "0x", ZeroHash, false);

  // PROPERTY (free-floating value)
  const propUID = await attest(schemaUIDs.PROPERTY, abi.encode(["string"], ["text/plain"]), ZeroHash, false);

  // PIN (place DATA at the file anchor — cardinality 1)
  await attest(schemaUIDs.PIN, abi.encode(["bytes32"], [fileAnchor]), dataUID, true);

  // TAG (visibility on root, weight 1)
  await attest(schemaUIDs.TAG, abi.encode(["bytes32", "int256"], [schemaUIDs.DATA, 1]), rootUID, true);

  // MIRROR (uri on the DATA). transportDefinition must be a DESCENDANT of /transports/ (e.g.
  // /transports/ipfs), not the /transports/ anchor itself — resolve the ipfs child.
  const ipfsTransport: string = await indexer.resolvePath(result.transportsAnchorUID, "ipfs");
  if (ipfsTransport === ZeroHash) throw new Error("SMOKE: /transports/ipfs anchor missing");
  await attest(
    schemaUIDs.MIRROR,
    abi.encode(["bytes32", "string"], [ipfsTransport, "ipfs://bafysmoke"]),
    dataUID,
    true,
  );

  // LIST (declare a collection) — ANY mode, no dup, not append-only, no cap
  const listUID = await attest(
    schemaUIDs.LIST,
    abi.encode(["bool", "bool", "uint8", "bytes32", "uint256"], [true, false, 0, ZeroHash, 0]),
    ZeroHash,
    false,
  );

  // LIST_ENTRY (member of the list)
  await attest(schemaUIDs.LIST_ENTRY, abi.encode(["bytes32", "bytes32"], [listUID, fileAnchor]), ZeroHash, true);

  // REDIRECT (symlink: source ANCHOR -> target). kind=2 (symlink) requires ANCHOR source.
  await attest(schemaUIDs.REDIRECT, abi.encode(["bytes32", "uint16"], [rootUID, 2]), fileAnchor, true);

  // index write proof: the file anchor resolves under root, and the PIN placed DATA there.
  const resolved = await indexer.resolvePath(rootUID, "smoke.txt");
  if (resolved.toLowerCase() !== fileAnchor.toLowerCase()) {
    throw new Error(`SMOKE: index write check failed — resolvePath(root,'smoke.txt') ${resolved} != ${fileAnchor}`);
  }
  void attesterAddr;
  void propUID;
  l("  9/9 per-schema smokes passed; index write confirmed.");
}
