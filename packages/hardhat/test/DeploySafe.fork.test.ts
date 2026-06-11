import { expect } from "chai";
import { ethers } from "hardhat";
import { takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy-lib/addresses";
import { orchestrateViaSafe } from "../deploy-lib/orchestrateSafe";
import { predictProxyAddress } from "../deploy-lib/create3";
import { getCreateX } from "../deploy-lib/create3";
import { RESOLVERS, SCHEMAS } from "../deploy-lib/schemas";
import { buildSafePlan, buildSetTransportsAnchorCall } from "../deploy-lib/safePlan";
import { deployTestSafe, executeBatchAsSafe, getSafe, SAFE_PROXY_FACTORY_141 } from "../deploy-lib/safe";
import { runVerifyGate } from "../deploy-lib/verify";

// Fork rehearsal for the SAFE-NATIVE EFS deploy (docs/DEPLOYMENT.md §1/§3, ADR-0048, ADR-0053).
//
// Deploys a REAL Gnosis Safe v1.4.1 (canonical SafeProxyFactory + singleton, both present on the
// pinned Sepolia fork) with the test signer as the 1-of-1 owner, then drives the whole EFS deploy
// FROM that Safe as two owner-signed MultiSend batches (Batch 1 = born-Safe-owned CreateX proxy
// deploys + wire; Batch 2 = register-last + scaffolding). Asserts everything is BORN owned by the
// Safe — no transfer phase ever runs — the Safe-keyed CREATE3 addresses are at their precomputed
// values, the scaffolding is authored by SystemAccount, the realized scaffolding UIDs equal the
// off-chain precompute (the bump-0 assertion), and a basic round-trip read works.
//
// Requires the pinned Sepolia fork (CreateX + EAS + the canonical Safe contracts must be present).
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/DeploySafe.fork.test.ts --network hardhat
// When not forking, self-skips so the default unit suite is unaffected.
describe("DeploySafe.fork — Safe-native deploy, born Safe-owned", function () {
  this.timeout(240_000);

  let forked = false;
  // Snapshot of the fork AFTER the happy-path Safe deploy has run (SystemAccount deployed + sealed).
  // The omit-branch test restores this so it re-invokes buildSafePlan against the SAME deployed+sealed
  // system the happy path produced — the deterministic Safe-keyed CREATE3 addresses make a second full
  // deploy collide, so we reuse the first rather than standing up a second system.
  let sealedSystem: SnapshotRestorer;
  // The Safe address the happy-path deploy used (re-targeted by the omit-branch test post-restore).
  let deployedSafe: string;

  before(async function () {
    const createxCode = await ethers.provider.getCode(CREATEX_ADDRESS);
    const safeFactoryCode = await ethers.provider.getCode(SAFE_PROXY_FACTORY_141);
    forked = createxCode !== "0x" && safeFactoryCode !== "0x";
    if (!forked) {
      console.log(
        "    (skipping DeploySafe.fork — CreateX/Safe factory not present; run with MAINNET_FORKING_ENABLED=true)",
      );
      this.skip();
    }
  });

  it("deploys the whole system FROM the Safe, born Safe-owned, with precomputed Safe-keyed addresses/UIDs", async function () {
    const [deployer, ownerSigner] = await ethers.getSigners();
    const deployerAddr = (await deployer.getAddress()).toLowerCase();

    // 1-of-1 test Safe owned by ownerSigner (stands in for the threshold-N EFS.eth Safe).
    const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);
    expect(await ethers.provider.getCode(safe), "test Safe has code").to.not.equal("0x");
    const safeLc = safe.toLowerCase();

    // The Safe-keyed CREATE3 addresses must differ from the EOA-keyed ones (Safe-keying is real).
    const createx = await getCreateX(deployer);
    const safeKeyedIndexer = (await predictProxyAddress(createx, safe, "EFSIndexer")).predicted;
    const eoaKeyedIndexer = (await predictProxyAddress(createx, await deployer.getAddress(), "EFSIndexer")).predicted;
    expect(safeKeyedIndexer.toLowerCase(), "Safe-keyed addr differs from EOA-keyed").to.not.equal(
      eoaKeyedIndexer.toLowerCase(),
    );

    // Drive the whole deploy FROM the Safe (owner-signed MultiSend batches). FIX 1 (PR #24): the
    // scaffolding is authored by a single timestamp-robust SystemAccount.bootstrap leg threading real
    // EAS UIDs in memory — no off-chain UID prediction, no pinned timestamp.
    //
    // PR #24 P1 (FIX A): capture the orchestrator's log so we can prove the VERIFY GATE ran on the
    // Safe path BEFORE Batch 2 (which contains the 9 permanent register legs). We run with log:true and
    // tee console.log into `logLines`, then assert the gate's GREEN marker precedes "executing Batch 2".
    const logLines: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logLines.push(a.map(String).join(" "));
    };
    let raw: Awaited<ReturnType<typeof orchestrateViaSafe>>;
    try {
      raw = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: true });
    } finally {
      console.log = origLog;
    }
    // The fork rehearsal self-executes (default mode "execute"): assert + narrow to the execute result.
    expect(raw.mode, "fork rehearsal uses execute mode (test Safe owner is a local signer)").to.equal("execute");
    if (raw.mode !== "execute") throw new Error("unreachable");
    const result = raw;

    // ── PR #24 P1 (FIX A): the verify gate ran on the Safe path, and ran BEFORE Batch 2 ─────────────
    // runVerifyGate logs "[verify] GATE GREEN ✓" on success; Batch 2 (the register legs) logs
    // "executing Batch 2". The gate index must exist and precede the Batch-2 index — proof that no
    // permanent schema is registered before the Safe-keyed proxies pass the same gate the EOA path runs.
    const gateGreenIdx = logLines.findIndex(line => /\[verify\] GATE GREEN/.test(line));
    const batch2Idx = logLines.findIndex(line => /executing Batch 2/.test(line));
    expect(gateGreenIdx, "verify gate ran on the Safe path (GATE GREEN logged)").to.be.greaterThan(-1);
    expect(batch2Idx, "Batch 2 executed").to.be.greaterThan(-1);
    expect(gateGreenIdx, "verify gate ran BEFORE Batch 2 (before any register leg)").to.be.lessThan(batch2Idx);

    // ── 7 proxies at the Safe-keyed predicted CREATE3 addresses, with code ──────────────────────────
    expect(Object.keys(result.proxies)).to.have.lengthOf(6);
    for (const r of RESOLVERS) {
      const proxy = result.proxies[r];
      const predicted = (await predictProxyAddress(createx, safe, r)).predicted;
      expect(proxy.toLowerCase(), `${r} == Safe-keyed predicted`).to.equal(predicted.toLowerCase());
      expect(await ethers.provider.getCode(proxy), `${r} has code`).to.not.equal("0x");
      const c = await ethers.getContractAt(r, proxy, deployer);
      expect((await c.getEAS()).toLowerCase()).to.equal(EAS_ADDRESS.toLowerCase());
    }
    // SystemAccount also at its Safe-keyed predicted address.
    const saPredicted = (await predictProxyAddress(createx, safe, "SystemAccount")).predicted;
    expect(result.systemAccount.toLowerCase(), "SystemAccount == Safe-keyed predicted").to.equal(
      saPredicted.toLowerCase(),
    );

    // ── 9 schemas registered against the Safe-keyed proxies ─────────────────────────────────────────
    expect(result.registered).to.equal(true);
    const reg = await ethers.getContractAt(
      "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
      "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
      deployer,
    );
    const proxyByResolver = result.proxies as Record<string, string>;
    for (const s of SCHEMAS) {
      const rec = await reg.getSchema(result.schemaUIDs[s.name]);
      expect(rec.resolver.toLowerCase(), `${s.name} registered resolver == Safe-keyed proxy`).to.equal(
        proxyByResolver[s.resolver].toLowerCase(),
      );
      expect(rec.schema, `${s.name} field string`).to.equal(s.fieldString);
      expect(rec.revocable, `${s.name} revocable`).to.equal(s.revocable);
    }
    // First deploy: nothing was registered beforehand, so all 9 register legs were INCLUDED in Batch 2
    // (no register-omit happened on the initial run — the omit path is exercised by the re-run test).
    expect(result.plan.batch2RegistersOmitted, "first deploy includes all 9 register legs (none omitted)").to.equal(0);
    expect(
      result.plan.batch2.filter(leg => /^register /.test(leg.label ?? "")),
      "first deploy Batch 2 has 9 register legs",
    ).to.have.lengthOf(SCHEMAS.length);

    // ── BORN Safe-owned: ProxyAdmins + Ownable resolvers + SystemAccount owner == Safe; deployer holds
    //    nothing; NO transfer phase ran. ────────────────────────────────────────────────────────────
    expect(result.ownershipTransferred, "no transfer phase on the Safe path").to.equal(false);
    for (const d of Object.values(result.deploys)) {
      const pa = await ethers.getContractAt(
        "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
        d.proxyAdmin,
        deployer,
      );
      const owner = (await pa.owner()).toLowerCase();
      expect(owner, `${d.resolver} ProxyAdmin born owned by Safe`).to.equal(safeLc);
      expect(owner, `${d.resolver} ProxyAdmin NOT owned by deployer EOA`).to.not.equal(deployerAddr);
    }
    for (const r of ["EFSIndexer", "MirrorResolver"] as const) {
      const c = await ethers.getContractAt(r, proxyByResolver[r], deployer);
      expect((await c.owner()).toLowerCase(), `${r} born owned by Safe`).to.equal(safeLc);
    }
    const systemAccount = await ethers.getContractAt("SystemAccount", result.systemAccount, deployer);
    expect((await systemAccount.owner()).toLowerCase(), "SystemAccount born owned by Safe").to.equal(safeLc);

    // ── Scaffolding authored BY SystemAccount (attester == SystemAccount, NOT the deployer) ────────
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, deployer);
    const root = await indexer.rootAnchorUID();
    expect(root).to.not.equal(ethers.ZeroHash);
    const easRead = await ethers.getContractAt(
      "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
      EAS_ADDRESS,
      deployer,
    );
    const rootAtt = await easRead.getAttestation(root);
    expect(rootAtt.attester.toLowerCase(), "root anchor authored by SystemAccount").to.equal(
      result.systemAccount.toLowerCase(),
    );
    expect(rootAtt.attester.toLowerCase(), "root anchor NOT authored by deployer EOA").to.not.equal(deployerAddr);
    const ipfs = await indexer.resolvePath(result.transportsAnchorUID, "ipfs");
    const ipfsAtt = await easRead.getAttestation(ipfs);
    expect(ipfsAtt.attester.toLowerCase(), "/transports/ipfs authored by SystemAccount").to.equal(
      result.systemAccount.toLowerCase(),
    );

    // ── Scaffolding tree correctly parented (FIX 1: UIDs are whatever EAS returned — read back from
    //    the index, not predicted off-chain). The result's scaffoldingUIDs are the index read-back;
    //    re-assert the parenting holds: /transports and /transports/ipfs resolve under their parents,
    //    and the result map matches. ───────────────────────────────────────────────────────────────
    expect(root.toLowerCase()).to.equal(result.scaffoldingUIDs.root.toLowerCase());
    const transports = await indexer.resolvePath(root, "transports");
    expect(transports.toLowerCase()).to.equal(result.scaffoldingUIDs.transports.toLowerCase());
    expect(transports.toLowerCase()).to.equal(result.transportsAnchorUID.toLowerCase());
    expect(ipfs.toLowerCase()).to.equal(result.scaffoldingUIDs.ipfs.toLowerCase());
    // The /transports/ipfs anchor's refUID is the /transports anchor (correct parenting).
    expect(ipfsAtt.refUID.toLowerCase()).to.equal(transports.toLowerCase());
    // tags resolves under root too.
    expect((await indexer.resolvePath(root, "tags")).toLowerCase()).to.equal(result.scaffoldingUIDs.tags.toLowerCase());

    // ── Basic round-trip read: author a file anchor under root through SystemAccount (Safe-signed) is
    //    out of scope; instead prove the registered schemas accept a write — push an ANCHOR via the
    //    Safe-owned SystemAccount path is covered above. Round-trip a path resolve through the index. ─
    expect(await indexer.resolvePath(root, "transports")).to.not.equal(ethers.ZeroHash);
    expect(await indexer.resolvePath(result.transportsAnchorUID, "https")).to.not.equal(ethers.ZeroHash);

    // PR #24 P2 fix: the Safe bootstrap seeds ALL 11 allowed transport schemes
    // (MirrorResolver._isAllowedScheme), so no scheme is left squattable on a fresh deploy.
    const ALL_TRANSPORTS = [
      "onchain",
      "ipfs",
      "arweave",
      "magnet",
      "https",
      "ftp",
      "s3",
      "gs",
      "dat",
      "rsync",
      "bittorrent",
    ];
    for (const t of ALL_TRANSPORTS) {
      expect(
        await indexer.resolvePath(result.transportsAnchorUID, t),
        `/transports/${t} anchor seeded by Safe bootstrap`,
      ).to.not.equal(ethers.ZeroHash);
    }

    // The MirrorResolver knows the transports anchor (setTransportsAnchor ran in Batch 2).
    const mirror = await ethers.getContractAt("MirrorResolver", result.proxies.MirrorResolver, deployer);
    expect((await mirror.transportsAnchorUID()).toLowerCase()).to.equal(result.transportsAnchorUID.toLowerCase());

    // ── PR #24 P1 fix: bootstrap sealed in Batch 2; owner cannot relay-write as `system` ─────────
    // Batch 2's last leg was SystemAccount.seal(), so the bootstrap ceremony is permanently locked
    // and the steady-state relay is module-only. The Safe (owner) is not an authorized module, so it
    // can never emit/revoke arbitrary payloads as the permanent `system` attester. We assert the
    // sealed flag (the in-batch seal landed) and that a NON-module caller's relay attempt reverts —
    // the relay is module-gated, not owner-gated. (Re-driving a full Safe MultiSend just to prove the
    // owner-path reverts is unnecessary: the gate is `onlyAuthorizedModule`, and the Safe holds no
    // module authorization — bootstrapSealed()==true is the on-chain proof the ceremony is closed.)
    expect(await systemAccount.bootstrapSealed(), "bootstrap sealed by Batch-2 seal() leg").to.equal(true);
    await expect(
      systemAccount.connect(deployer).attest({
        schema: result.schemaUIDs.ANCHOR,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: root,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["evil", ethers.ZeroHash]),
          value: 0n,
        },
      }),
      "a non-module caller cannot relay as `system`",
    ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

    // ── PR #24 P1 (FIX A) negative: the verify gate CATCHES a drifted config ─────────────────────────
    // Re-run runVerifyGate against the live Safe-keyed proxies but with a deliberately drifted LIST_ENTRY
    // UID. The gate's self-UID getter check (ListEntryResolver.listEntrySchemaUID() == computed UID)
    // must fail and THROW — proving that on the Safe path a proxy whose self-derived UID doesn't match
    // the to-be-registered UID is caught before any registration, not after. (Read-only; no state change.)
    const driftedUIDs = { ...result.schemaUIDs, LIST_ENTRY: ethers.ZeroHash };
    await expect(
      runVerifyGate({ deploys: result.deploys, schemaUIDs: driftedUIDs, deployer }),
      "verify gate catches a drifted self-UID (would-be permanent-register against a drifted proxy)",
    ).to.be.rejectedWith(/VERIFY GATE/);

    // Capture the now-deployed + sealed system so the omit-branch test below can re-invoke
    // buildSafePlan against it (a second full deploy would collide on the deterministic addresses).
    deployedSafe = safe;
    sealedSystem = await takeSnapshot();
  });

  // ── PR #24 P1 follow-up: post-seal re-run of buildSafePlan is a fully idempotent no-op Batch 2 ────
  // The EOA after-gate retry is covered in Deploy.fork.test.ts. The Safe idempotency is exercised here:
  // buildSafePlan queries on-chain state at plan-build time — when the SystemAccount proxy already
  // exists AND bootstrapSealed() is true, Batch 2 OMITS the bootstrap + seal legs (they would revert
  // BootstrapSealed), and for each schema whose expected UID is already registered it OMITS the register
  // leg (EAS register is NOT idempotent — re-including would revert AlreadyExists on the first one and
  // abort the whole MultiSend, stranding recovery). On a fully-registered+sealed system that means ALL
  // 9 register legs AND bootstrap+seal are omitted, leaving Batch 2 empty — a clean no-op so recovery
  // proceeds to Batch 3. We restore the post-seal snapshot from the happy-path test and re-build.
  it("post-seal buildSafePlan omits all register legs + bootstrap + seal (Batch 2 is an idempotent no-op)", async function () {
    // Restore the system the happy path deployed + sealed (deterministic addresses preclude a 2nd deploy).
    await sealedSystem.restore();

    const [deployer] = await ethers.getSigners();

    // Sanity: the SystemAccount is in fact deployed AND sealed in the restored state — the two
    // preconditions the bootstrap+seal omit keys off.
    const saPredicted = (await predictProxyAddress(await getCreateX(deployer), deployedSafe, "SystemAccount"))
      .predicted;
    expect(await ethers.provider.getCode(saPredicted), "SystemAccount has code (deployed)").to.not.equal("0x");
    const systemAccount = await ethers.getContractAt("SystemAccount", saPredicted, deployer);
    expect(await systemAccount.bootstrapSealed(), "SystemAccount already sealed").to.equal(true);

    // Re-build the plan against the deployed+sealed system. This is the post-seal re-run path.
    const plan = await buildSafePlan(deployer, deployedSafe, false);

    // ── The omit flags are set: bootstrap+seal omitted, and all 9 registers omitted ─────────────────
    expect(plan.batch2BootstrapOmitted, "batch2BootstrapOmitted on a post-seal re-run").to.equal(true);
    expect(SCHEMAS.length, "freeze set is 9 schemas").to.equal(9);
    expect(
      plan.batch2RegistersOmitted,
      "all 9 register legs omitted — the schemas are already registered (register is NOT idempotent)",
    ).to.equal(9);

    // ── Batch 2 is EMPTY — every register leg + bootstrap + seal omitted (full idempotency) ─────────
    expect(plan.batch2, "Batch 2 is an empty no-op (all registers + bootstrap + seal omitted)").to.have.lengthOf(0);
    expect(
      plan.batch2.some(leg => /^register /.test(leg.label ?? "")),
      "no register leg in Batch 2",
    ).to.equal(false);
    expect(
      plan.batch2.some(leg => /bootstrap/i.test(leg.label ?? "")),
      "no bootstrap leg in Batch 2",
    ).to.equal(false);
    expect(
      plan.batch2.some(leg => /seal/i.test(leg.label ?? "")),
      "no seal leg in Batch 2",
    ).to.equal(false);

    // ── The /transports UID for setTransportsAnchor is resolved from the index (real, non-zero),
    //    NOT minted by a fresh bootstrap (which was omitted). ─────────────────────────────────────────
    const indexer = await ethers.getContractAt("EFSIndexer", plan.proxies.EFSIndexer, deployer);
    const root = await indexer.rootAnchorUID();
    expect(root, "root anchor present from the prior bootstrap").to.not.equal(ethers.ZeroHash);
    const transportsUID = await indexer.resolvePath(root, "transports");
    expect(transportsUID, "/transports UID resolves from the index (non-zero)").to.not.equal(ethers.ZeroHash);
  });

  // ── PR #24 P2: end-to-end re-run of the WHOLE Safe ceremony on an already-complete system ─────────
  // The buildSafePlan-only test above proves Batch 2's omit flags, but it never re-drives the full
  // orchestration — it can't catch Batch 1 (deployCreate3 address-taken / wireContracts one-shot) or
  // Batch 3 (setTransportsAnchor one-shot) reverting on resume. This re-invokes the SAME entry the
  // happy path used (orchestrateViaSafe) against the deployed+sealed system and asserts it completes
  // WITHOUT reverting: Batch 1 skipped (proxies present + indexer wired), Batch 2 omitted (registered +
  // sealed), Batch 3 skipped (transports wired) — a clean no-op that still verifies the system.
  // (Per the known per-file CREATE3 isolation artifact, we stay within this file's snapshot.)
  it("re-running orchestrateViaSafe on a complete system is a clean no-op (Batch 1 skipped, Batch 2 omitted, Batch 3 skipped)", async function () {
    // Restore the system the happy path deployed + sealed (deterministic addresses preclude a 2nd deploy).
    await sealedSystem.restore();

    const [deployer, ownerSigner] = await ethers.getSigners();
    const safeLc = deployedSafe.toLowerCase();

    // Re-drive the FULL Safe orchestration end-to-end against the already-complete system. The fixes
    // make this a no-op rather than a revert: skip Batch 1 (proxies exist + wired), omit Batch 2
    // (registered + sealed), skip Batch 3 (transports already wired).
    const raw = await orchestrateViaSafe(deployer, deployedSafe, [ownerSigner], { log: false });
    expect(raw.mode, "re-run uses execute mode (test Safe owner is a local signer)").to.equal("execute");
    if (raw.mode !== "execute") throw new Error("unreachable");
    const result = raw;

    // ── Batch 1 SKIPPED: the txHash sentinel marks the skip (no real Safe tx was executed) ──────────
    expect(result.safeTxHashes.batch1, "Batch 1 skipped — already deployed").to.match(/skipped/i);
    // ── Batch 2 OMITTED: bootstrap+seal omitted and all 9 register legs omitted (empty no-op batch) ──
    expect(result.plan.batch2BootstrapOmitted, "Batch 2 bootstrap+seal omitted on re-run").to.equal(true);
    expect(result.plan.batch2RegistersOmitted, "all 9 register legs omitted on re-run").to.equal(SCHEMAS.length);
    expect(result.plan.batch2, "Batch 2 is an empty no-op").to.have.lengthOf(0);
    // ── Batch 3 SKIPPED: the txHash sentinel marks the skip (setTransportsAnchor was not re-executed) ─
    expect(result.safeTxHashes.batch3, "Batch 3 skipped — already wired").to.match(/skipped/i);

    // ── The system still verifies after the no-op re-run ────────────────────────────────────────────
    // Proxies present at their Safe-keyed addresses.
    const createx = await getCreateX(deployer);
    for (const r of RESOLVERS) {
      const predicted = (await predictProxyAddress(createx, deployedSafe, r)).predicted;
      expect(result.proxies[r].toLowerCase(), `${r} == Safe-keyed predicted`).to.equal(predicted.toLowerCase());
      expect(await ethers.provider.getCode(result.proxies[r]), `${r} has code`).to.not.equal("0x");
    }
    // Schemas registered against the Safe-keyed proxies.
    expect(result.registered).to.equal(true);
    const reg = await ethers.getContractAt(
      "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
      "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
      deployer,
    );
    const proxyByResolver = result.proxies as Record<string, string>;
    for (const s of SCHEMAS) {
      const rec = await reg.getSchema(result.schemaUIDs[s.name]);
      expect(rec.resolver.toLowerCase(), `${s.name} resolver == Safe-keyed proxy`).to.equal(
        proxyByResolver[s.resolver].toLowerCase(),
      );
    }
    // Sealed, transports wired, owner == Safe.
    const systemAccount = await ethers.getContractAt("SystemAccount", result.systemAccount, deployer);
    expect(await systemAccount.bootstrapSealed(), "still sealed after re-run").to.equal(true);
    expect((await systemAccount.owner()).toLowerCase(), "SystemAccount owner == Safe").to.equal(safeLc);
    const mirror = await ethers.getContractAt("MirrorResolver", result.proxies.MirrorResolver, deployer);
    expect(
      (await mirror.transportsAnchorUID()).toLowerCase(),
      "MirrorResolver still wired to the realized /transports UID",
    ).to.equal(result.transportsAnchorUID.toLowerCase());
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, deployer);
    expect((await indexer.owner()).toLowerCase(), "EFSIndexer owner == Safe").to.equal(safeLc);
    expect(await indexer.resolvePath(await indexer.rootAnchorUID(), "transports"), "/transports present").to.not.equal(
      ethers.ZeroHash,
    );
  });

  // ── PR #24 P2 (FIX A): real-network BUILD/PROPOSE — must NOT self-execute with a non-owner EOA ────
  // On a real network the gas-paying EOA is not a Safe owner; self-signing + execTransaction would
  // produce invalid signatures and revert Batch 1. The fix routes that case through `mode: "propose"`,
  // which BUILDS the next MultiSend batch + emits the artifact and NEVER calls execTransaction.
  //
  // PR #24 P1 (PHASE-AWARE): propose mode is now phase-aware — each invocation detects the on-chain
  // phase and emits ONLY the next pending batch, never a duplicate Batch 1 on re-run. We prove it here
  // against a FRESH Safe (Phase 0): only Batch 1 is built (NOT Batch 1 + Batch 2 as the old always-emit
  // design did), with a valid Safe-derived SafeTx hash at the Safe's live nonce 0; NOTHING was executed
  // (the Safe nonce is still 0 and the EFSIndexer proxy has no code); the artifact records phase 0 + the
  // single batch.
  it("Phase 0 propose mode BUILDS only Batch 1 + artifact and does NOT call execTransaction", async function () {
    const { readFileSync, existsSync, rmSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const [deployer] = await ethers.getSigners();
    // A fresh test Safe — its address differs from the happy-path Safe, so the Safe-keyed CREATE3
    // proxy addresses differ and can't collide with the deployed system. We never execute against it.
    const safe = await deployTestSafe(deployer, [await deployer.getAddress()], 1);
    const safeContract = await ethers.getContractAt(["function nonce() view returns (uint256)"], safe, deployer);
    expect(await safeContract.nonce(), "fresh Safe nonce starts at 0").to.equal(0n);

    const artifactPath = join(tmpdir(), `efs-safe-batches-${Date.now()}.json`);

    // Drive propose mode with NO owner signatures (owners: []) — the real-network condition.
    const res = await orchestrateViaSafe(deployer, safe, [], {
      mode: "propose",
      proposeArtifactPath: artifactPath,
      log: false,
    });

    // ── It returned a PROPOSE result, not an executed one, at Phase 0 ───────────────────────────────
    expect(res.mode, "propose mode returns a propose result").to.equal("propose");
    if (res.mode !== "propose") throw new Error("unreachable");
    expect(res.phase, "fresh Safe (no proxies) is Phase 0").to.equal(0);

    // ── EXACTLY ONE proposable batch built (Batch 1 only — NOT a duplicate Batch 1 + Batch 2) ───────
    expect(res.batches, "Phase 0 emits only Batch 1").to.have.lengthOf(1);
    expect(res.batches[0].label).to.match(/Batch 1/);
    expect(res.batches[0].nonce, "Batch 1 at the Safe's live nonce (0)").to.equal("0");
    expect(res.batches[0].safeTxHash, "SafeTx hash present").to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(res.batches[0].operation, "MultiSend is a delegatecall (operation 1)").to.equal(1);
    expect(res.batches[0].to.toLowerCase(), "targets MultiSendCallOnly").to.not.equal(ethers.ZeroAddress);
    // Batch 1 carries the 7 proxy deploys + wireContracts (8 legs). No register leg is proposed at Phase 0.
    expect(res.batches[0].legs.length, "Batch 1 has 8 legs (7 deploys + wire)").to.equal(8);
    expect(
      res.batches[0].legs.filter(leg => /^register /.test(leg.label ?? "")).length,
      "no register legs proposed at Phase 0 (Batch 2 is not emitted until Phase 1)",
    ).to.equal(0);

    // ── NOTHING was executed: the Safe nonce is still 0, and no Safe-keyed proxy has code ────────────
    expect(await safeContract.nonce(), "Safe nonce unchanged — execTransaction never called").to.equal(0n);
    expect(
      await ethers.provider.getCode(res.proxies.EFSIndexer),
      "EFSIndexer proxy NOT deployed (Batch 1 was only proposed, not executed)",
    ).to.equal("0x");

    // ── The build/propose artifact was written with phase 0 + the single batch ──────────────────────
    expect(existsSync(artifactPath), "safe-batches.json artifact written").to.equal(true);
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(parsed.safe.toLowerCase()).to.equal(safe.toLowerCase());
    expect(parsed.phase, "artifact records phase 0").to.equal(0);
    expect(parsed.batches, "artifact records the single Batch 1").to.have.lengthOf(1);
    expect(parsed.ceremony.join("\n"), "ceremony documents the re-run-for-Batch-2 step").to.match(/RE-RUN/i);
    rmSync(artifactPath, { force: true });
  });

  // ── PR #24 P1 (PHASE-AWARE) — the no-duplicate-Batch-1 regression + the phase walk ─────────────────
  // The core P1 finding: on a re-run AFTER Batch 1 has landed, the old propose path re-emitted a fresh
  // Batch 1 (a DUPLICATE deploy/wire) instead of the verify gate + Batch 2. Here we drive propose mode
  // through the phases against a real Safe, APPLYING each proposed batch via executeBatchAsSafe (the
  // test owner IS a local signer, so we can execute what propose merely builds), and assert each
  // invocation emits ONLY the correct next batch:
  //   Phase 0 → Batch 1; apply it.
  //   Phase 1 → verify gate runs, then Batch 2 (NOT a duplicate Batch 1); apply it.
  //   Phase 2 → Batch 3 (setTransportsAnchor); apply it.
  //   Phase 3 → clean no-op (empty batches).
  // We snapshot first so this self-contained system doesn't collide with the happy-path one (per-file
  // CREATE3 isolation). buildSafePlan is rebuilt each re-run, matching how the real operator re-invokes
  // the task; the proposed Batch N is executed with the real (test) owner key to advance the phase.
  it("propose mode is phase-aware: re-run after Batch 1 emits Batch 2 (verify gate), not a duplicate Batch 1", async function () {
    const phaseWalkSnap = await takeSnapshot();
    try {
      const [deployer, ownerSigner] = await ethers.getSigners();
      const safe = await deployTestSafe(deployer, [await ownerSigner.getAddress()], 1);
      const safeContract = await getSafe(safe, deployer);

      // ── Phase 0: fresh Safe → propose emits Batch 1 only ──────────────────────────────────────────
      const p0 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      if (p0.mode !== "propose") throw new Error("unreachable");
      expect(p0.phase, "fresh Safe is Phase 0").to.equal(0);
      expect(p0.batches, "Phase 0 emits only Batch 1").to.have.lengthOf(1);
      expect(p0.batches[0].label).to.match(/Batch 1/);
      // The proxies are not deployed yet.
      expect(await ethers.provider.getCode(p0.proxies.EFSIndexer), "no proxy code at Phase 0").to.equal("0x");

      // Apply Batch 1 on-chain (the operator's Safe{Wallet} execution; here via the test owner key).
      await executeBatchAsSafe(safeContract, p0.plan.batch1, [ownerSigner], deployer);
      expect(await ethers.provider.getCode(p0.proxies.EFSIndexer), "proxies deployed after Batch 1").to.not.equal("0x");

      // ── Phase 1: RE-RUN → propose runs the verify gate, then emits Batch 2 (NOT a duplicate Batch 1) ─
      // Tee console.log to prove the verify gate ran (its GREEN marker) during this propose invocation.
      const logLines: string[] = [];
      const origLog = console.log;
      console.log = (...a: unknown[]) => {
        logLines.push(a.map(String).join(" "));
      };
      let p1: Awaited<ReturnType<typeof orchestrateViaSafe>>;
      try {
        p1 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: true });
      } finally {
        console.log = origLog;
      }
      if (p1.mode !== "propose") throw new Error("unreachable");
      expect(p1.phase, "proxies live + unregistered → Phase 1").to.equal(1);
      expect(p1.batches, "Phase 1 emits exactly one batch").to.have.lengthOf(1);
      // THE REGRESSION ASSERTION: the emitted batch is Batch 2, NOT a duplicate Batch 1.
      expect(p1.batches[0].label, "Phase 1 emits Batch 2, not a duplicate Batch 1").to.match(/Batch 2/);
      expect(p1.batches[0].label, "Phase 1 does NOT re-emit Batch 1").to.not.match(/Batch 1/);
      expect(
        p1.batches[0].legs.filter(leg => /^register /.test(leg.label ?? "")).length,
        "Batch 2 carries the 9 register legs",
      ).to.equal(SCHEMAS.length);
      expect(
        p1.batches[0].legs.some(leg => /deployCreate3/.test(leg.label ?? "")),
        "Batch 2 carries NO deployCreate3 leg (it is not a duplicate Batch 1)",
      ).to.equal(false);
      // The verify gate ran during this propose invocation (read-only, before Batch 2 is proposed).
      expect(
        logLines.findIndex(line => /\[verify\] GATE GREEN/.test(line)),
        "verify gate ran at Phase 1 before proposing Batch 2",
      ).to.be.greaterThan(-1);

      // Apply Batch 2 on-chain to advance to Phase 2.
      await executeBatchAsSafe(safeContract, p1.plan.batch2, [ownerSigner], deployer);

      // ── Phase 2: RE-RUN → propose emits Batch 3 (setTransportsAnchor) ───────────────────────────────
      const p2 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      if (p2.mode !== "propose") throw new Error("unreachable");
      expect(p2.phase, "registered + sealed → Phase 2").to.equal(2);
      expect(p2.batches, "Phase 2 emits exactly one batch").to.have.lengthOf(1);
      expect(p2.batches[0].label, "Phase 2 emits Batch 3 (setTransportsAnchor)").to.match(/Batch 3/);
      expect(
        p2.batches[0].legs.some(leg => /setTransportsAnchor/.test(leg.label ?? "")),
        "Batch 3 carries the setTransportsAnchor leg",
      ).to.equal(true);

      // Apply Batch 3 (read the realized /transports UID, set it) to advance to Phase 3.
      const indexer = await ethers.getContractAt("EFSIndexer", p2.proxies.EFSIndexer, deployer);
      const root = await indexer.rootAnchorUID();
      const transportsUID = await indexer.resolvePath(root, "transports");
      await executeBatchAsSafe(
        safeContract,
        [await buildSetTransportsAnchorCall(deployer, p2.proxies.MirrorResolver, transportsUID)],
        [ownerSigner],
        deployer,
      );

      // ── Phase 3: RE-RUN → clean no-op (nothing to propose) ──────────────────────────────────────────
      const p3 = await orchestrateViaSafe(deployer, safe, [], { mode: "propose", log: false });
      if (p3.mode !== "propose") throw new Error("unreachable");
      expect(p3.phase, "transports wired → Phase 3 (complete)").to.equal(3);
      expect(p3.batches, "Phase 3 emits NO batch (clean no-op)").to.have.lengthOf(0);
      expect(p3.ceremony.join("\n"), "Phase 3 ceremony reports completion").to.match(/complete/i);
    } finally {
      await phaseWalkSnap.restore();
    }
  });
});
