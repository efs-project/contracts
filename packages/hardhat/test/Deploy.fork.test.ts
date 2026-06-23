import { expect } from "chai";
import { ethers, network } from "hardhat";
import { takeSnapshot, SnapshotRestorer } from "@nomicfoundation/hardhat-network-helpers";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy-lib/addresses";
import { orchestrate } from "../deploy-lib/orchestrate";
import { RESOLVERS, SCHEMAS } from "../deploy-lib/schemas";

// Fork rehearsal for the Phase D orchestrated CREATE3 deploy (docs/DEPLOYMENT.md §3, ADR-0048).
//
// Requires the pinned Sepolia fork (CreateX + EAS must be present). Run with:
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/Deploy.fork.test.ts --network hardhat
//
// When not forking (CreateX absent), the suite skips itself so the default `yarn hardhat test`
// (the 429-test unit suite, which deploys contracts directly and never touches deploy scripts)
// stays unaffected.
describe("Deploy.fork — orchestrated CREATE3 deploy + register-last", function () {
  this.timeout(180_000);

  let forked = false;
  // Clean-fork snapshot taken before any deploy. The CREATE3 addresses are deterministic, so two `full`
  // orchestrations in the same fork session would collide on the second deploy (CreateX reverts on a
  // taken address). The post-seal-retry test restores this snapshot so it deploys into a clean fork.
  let cleanFork: SnapshotRestorer;

  before(async function () {
    const code = await ethers.provider.getCode(CREATEX_ADDRESS);
    forked = code !== "0x";
    if (!forked) {
      console.log("    (skipping Deploy.fork — CreateX not present; run with MAINNET_FORKING_ENABLED=true)");
      this.skip();
    }
    cleanFork = await takeSnapshot();
  });

  it("stands up the whole ceremony: 6 proxies @predicted, verify green, 9 schemas registered, owner==Safe, 9 smokes", async function () {
    const [deployer, safeSigner] = await ethers.getSigners();
    process.env.EFS_SAFE_ADDRESS = await safeSigner.getAddress();

    const result = await orchestrate(deployer, "full", false);

    // 6 proxies at their predicted CREATE3 addresses, with code.
    expect(Object.keys(result.proxies)).to.have.lengthOf(6);
    for (const r of RESOLVERS) {
      const d = result.deploys[r];
      expect(d.proxy.toLowerCase(), `${r} realized==predicted`).to.equal(d.predicted.toLowerCase());
      expect(await ethers.provider.getCode(d.proxy), `${r} has code`).to.not.equal("0x");
      // getEAS() == canonical EAS
      const proxy = await ethers.getContractAt(r, d.proxy, deployer);
      expect((await proxy.getEAS()).toLowerCase()).to.equal(EAS_ADDRESS.toLowerCase());
    }

    // verify gate is exercised inside orchestrate(); reaching here means it passed. Re-assert the
    // two self-UID getters explicitly.
    const listEntry = await ethers.getContractAt("ListEntryResolver", result.proxies.ListEntryResolver, deployer);
    expect((await listEntry.listEntrySchemaUID()).toLowerCase()).to.equal(result.schemaUIDs.LIST_ENTRY.toLowerCase());
    const aliasR = await ethers.getContractAt("AliasResolver", result.proxies.AliasResolver, deployer);
    expect((await aliasR.redirectSchemaUID()).toLowerCase()).to.equal(result.schemaUIDs.REDIRECT.toLowerCase());

    // 9 schemas registered against the proxies.
    expect(result.registered).to.equal(true);
    const reg = await ethers.getContractAt(
      "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
      "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
      deployer,
    );
    const proxyByResolver = result.proxies as Record<string, string>;
    for (const s of SCHEMAS) {
      const rec = await reg.getSchema(result.schemaUIDs[s.name]);
      expect(rec.resolver.toLowerCase(), `${s.name} registered resolver`).to.equal(
        proxyByResolver[s.resolver].toLowerCase(),
      );
      expect(rec.revocable, `${s.name} revocable`).to.equal(s.revocable);
      expect(rec.schema, `${s.name} field string`).to.equal(s.fieldString);
    }

    // ownership == Safe; deployer holds nothing.
    expect(result.ownershipTransferred).to.equal(true);
    const safe = (await safeSigner.getAddress()).toLowerCase();
    const deployerAddr = (await deployer.getAddress()).toLowerCase();
    for (const d of Object.values(result.deploys)) {
      const pa = await ethers.getContractAt(
        "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
        d.proxyAdmin,
        deployer,
      );
      const owner = (await pa.owner()).toLowerCase();
      expect(owner, `${d.resolver} ProxyAdmin owner == Safe`).to.equal(safe);
      expect(owner).to.not.equal(deployerAddr);
    }
    for (const r of ["EFSIndexer", "MirrorResolver"] as const) {
      const c = await ethers.getContractAt(r, proxyByResolver[r], deployer);
      expect((await c.owner()).toLowerCase(), `${r} owner == Safe`).to.equal(safe);
    }

    // per-schema smokes ran inside orchestrate() (reaching here without throw == 9/9 passed); the
    // index write was asserted there too. Spot-check the file anchor still resolves under root.
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, deployer);
    const root = await indexer.rootAnchorUID();
    expect(await indexer.resolvePath(root, "smoke.txt")).to.not.equal(ethers.ZeroHash);

    // ── SystemAccount (ADR-0053): deployed at predicted CREATE3 addr, owner==Safe after transfer,
    //    and the bootstrap scaffolding (root, /transports/*) is authored BY it (attester check). ──
    const sa = result.deploys.SystemAccount;
    expect(sa, "SystemAccount in deploys").to.not.equal(undefined);
    expect(sa.proxy.toLowerCase(), "SystemAccount realized==predicted").to.equal(sa.predicted.toLowerCase());
    expect(result.systemAccount.toLowerCase()).to.equal(sa.proxy.toLowerCase());
    expect(await ethers.provider.getCode(sa.proxy), "SystemAccount has code").to.not.equal("0x");

    const systemAccount = await ethers.getContractAt("SystemAccount", result.systemAccount, deployer);
    expect((await systemAccount.getEAS()).toLowerCase(), "SystemAccount EAS").to.equal(EAS_ADDRESS.toLowerCase());
    expect((await systemAccount.owner()).toLowerCase(), "SystemAccount owner == Safe").to.equal(safe);
    // Its ProxyAdmin transferred to the Safe alongside the resolvers (covered by the loop above,
    // which iterates all of result.deploys including SystemAccount).
    const saPa = await ethers.getContractAt(
      "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin",
      sa.proxyAdmin,
      deployer,
    );
    expect((await saPa.owner()).toLowerCase(), "SystemAccount ProxyAdmin owner == Safe").to.equal(safe);

    // Bootstrap scaffolding authored by SystemAccount: read the root + a /transports/* anchor UID
    // off the index, fetch the EAS attestation, assert attester == SystemAccount (NOT the deployer).
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
    const ipfsTransport = await indexer.resolvePath(result.transportsAnchorUID, "ipfs");
    const ipfsAtt = await easRead.getAttestation(ipfsTransport);
    expect(ipfsAtt.attester.toLowerCase(), "/transports/ipfs authored by SystemAccount").to.equal(
      result.systemAccount.toLowerCase(),
    );
    // PR #24 P2 fix + ADR-0063: bootstrap seeds ALL 12 default transport anchors
    // so the common schemes resolve out of the box. Names = client TransportType.
    const ALL_TRANSPORTS = [
      "onchain",
      "ipfs",
      "arweave",
      "magnet",
      "https",
      "data",
      "ftp",
      "s3",
      "gs",
      "dat",
      "rsync",
      "bittorrent",
    ];
    for (const t of ALL_TRANSPORTS) {
      const uid = await indexer.resolvePath(result.transportsAnchorUID, t);
      expect(uid, `/transports/${t} anchor seeded by bootstrap`).to.not.equal(ethers.ZeroHash);
      const att = await easRead.getAttestation(uid);
      expect(att.attester.toLowerCase(), `/transports/${t} authored by SystemAccount`).to.equal(
        result.systemAccount.toLowerCase(),
      );
    }

    // ── PR #24 P1 fix: bootstrap sealed + owner-cannot-relay after the ceremony ──────────────────
    // The deploy called seal() after bootstrap and before transfer; the bootstrap ceremony is now
    // permanently locked and the steady-state relay is module-only. Assert the owner (the Safe) can
    // neither relay-write nor re-open the ceremony — this is the on-chain guard for the finding.
    expect(await systemAccount.bootstrapSealed(), "bootstrap sealed at deploy").to.equal(true);
    const saAsOwner = systemAccount.connect(safeSigner);
    await expect(
      saAsOwner.attest({
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
      "owner (Safe) cannot relay attest as `system`",
    ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");
    await expect(
      saAsOwner.bootstrap(result.proxies.EFSIndexer, result.schemaUIDs.ANCHOR, [
        { name: "evil", parentIndex: -1, anchorSchemaToRegister: ethers.ZeroHash },
      ]),
      "bootstrap reverts after seal even for the owner",
    ).to.be.revertedWithCustomError(systemAccount, "BootstrapSealed");
  });

  // ── PR #24 P1 follow-up: post-seal --after-freeze-gate retry must NOT revert BootstrapSealed ──────
  // Earlier this session bootstrap was made onlyOwner + whenNotSealed and the deploy calls seal() right
  // after bootstrap. If an --after-freeze-gate run reaches seal() and then fails BEFORE ownership
  // transfer completes (e.g. resolveSafe() throwing on a bad EFS_SAFE_ADDRESS, or a partial transfer),
  // the next retry re-enters registerAndTransfer and — without this fix — would unconditionally call
  // bootstrap() and revert BootstrapSealed, so recovery could never finish. This test stands the system
  // up to the sealed state (a `full` run seals + transfers), then RE-INVOKES the --after-freeze-gate
  // path and asserts it completes cleanly: bootstrap is skipped (already sealed), anchors are reused,
  // ownership still ends at the Safe.
  it("post-seal --after-freeze-gate retry completes without reverting (skips bootstrap, reuses anchors)", async function () {
    // Restore the clean pre-deploy fork: the first test already deployed at these deterministic CREATE3
    // addresses, so without this restore our own `full` deploy below would collide (CreateX reverts).
    await cleanFork.restore();

    const [deployer, safeSigner] = await ethers.getSigners();
    process.env.EFS_SAFE_ADDRESS = await safeSigner.getAddress();
    const safe = (await safeSigner.getAddress()).toLowerCase();

    // Stand the whole system up to the sealed + transferred state.
    const first = await orchestrate(deployer, "full", false);
    const systemAccount = await ethers.getContractAt("SystemAccount", first.systemAccount, deployer);
    expect(await systemAccount.bootstrapSealed(), "sealed after the full run").to.equal(true);
    const rootBefore = await (
      await ethers.getContractAt("EFSIndexer", first.proxies.EFSIndexer, deployer)
    ).rootAnchorUID();

    // Re-invoke the after-gate path. The proxies + SystemAccount already exist (re-bound, not
    // redeployed), the schemas are already registered (register tolerates AlreadyExists), the ceremony
    // is already sealed, and ownership is already the Safe. The fix makes registerAndTransfer SKIP
    // bootstrap + seal on the sealed branch and resolve anchors from the index instead of re-attesting,
    // so this must NOT throw (pre-fix it reverted BootstrapSealed).
    const retry = await orchestrate(deployer, "after-freeze-gate", false);

    // Completed cleanly: bootstrap skipped (still sealed, root unchanged — reused, not re-attested),
    // ownership still the Safe, transports anchor resolved from the index.
    expect(await systemAccount.bootstrapSealed(), "still sealed after retry").to.equal(true);
    const indexer = await ethers.getContractAt("EFSIndexer", retry.proxies.EFSIndexer, deployer);
    expect((await indexer.rootAnchorUID()).toLowerCase(), "root reused, not re-attested").to.equal(
      rootBefore.toLowerCase(),
    );
    expect(retry.transportsAnchorUID, "transports UID resolved from index on retry").to.not.equal(ethers.ZeroHash);
    expect(retry.ownershipTransferred, "ownership idempotently ends at the Safe").to.equal(true);
    const sa = await ethers.getContractAt("SystemAccount", retry.systemAccount, deployer);
    expect((await sa.owner()).toLowerCase(), "SystemAccount owner == Safe after retry").to.equal(safe);
    const mirror = await ethers.getContractAt("MirrorResolver", retry.proxies.MirrorResolver, deployer);
    expect((await mirror.transportsAnchorUID()).toLowerCase(), "MirrorResolver transports set").to.equal(
      retry.transportsAnchorUID.toLowerCase(),
    );
  });

  after(function () {
    delete process.env.EFS_SAFE_ADDRESS;
    void network;
  });
});
