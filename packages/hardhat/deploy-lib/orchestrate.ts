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

// ── Bootstrap scaffolding tree (root → tags/transports → 5 transport children) ────────────────────
// The whole tree is authored by ONE timestamp-robust SystemAccount.bootstrap call (FIX 1, PR #24):
// each child's refUID is threaded from the parent UID the prior EAS.attest returned in the same call,
// so nothing is predicted off-chain. parentIndex indexes into this array; -1 = root (refUID=ZeroHash).
const BOOTSTRAP_SCAFFOLDING: { name: string; parentIndex: number }[] = [
  { name: "root", parentIndex: -1 }, // 0
  { name: "tags", parentIndex: 0 }, // 1 → root
  { name: "transports", parentIndex: 0 }, // 2 → root
  { name: "onchain", parentIndex: 2 }, // 3 → transports
  { name: "ipfs", parentIndex: 2 }, // 4 → transports
  { name: "arweave", parentIndex: 2 }, // 5 → transports
  { name: "magnet", parentIndex: 2 }, // 6 → transports
  { name: "https", parentIndex: 2 }, // 7 → transports
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
      deploys[r] = {
        resolver: r,
        impl: ZeroAddress, // impl not needed post-freeze; verify gate already ran pre-gate
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
    deploys.SystemAccount = {
      resolver: "SystemAccount",
      impl: ZeroAddress,
      proxy: systemAccountAddr,
      predicted: systemAccountAddr,
      proxyAdmin: await readProxyAdmin(systemAccountAddr),
      rawSalt: rawSalts.SystemAccount,
    };
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
