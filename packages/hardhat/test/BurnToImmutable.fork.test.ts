import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy-lib/addresses";
import { orchestrate, OrchestrationResult } from "../deploy-lib/orchestrate";
import { upgradeProxy } from "./helpers/deployUpgradeableProxy";

// Burn-to-immutable ceremony (docs/DEPLOYMENT.md §4, docs/SEPOLIA_FREEZE_TABLE.md; ADR-0048/0030/0053).
//
// The single most irreversible action in the project is the burn that turns the upgradeable devnet
// foundation into a permanently immutable mainnet one. ADR-0030 promises "no upgrades, no admin
// override" once burned; the burn ceremony is what delivers that promise. This test proves BOTH
// halves of the promise end to end against a real deploy, so when this PR merges we know the
// contracts are (a) genuinely upgradeable beforehand and (b) can DEFINITELY be made immutable:
//
//   1. PRE-BURN  — every one of the 7 proxies (6 resolvers + SystemAccount) is upgradeable by the
//                  owner: all 7 ProxyAdmins are owner-controlled, and a real EFSIndexer V1→V2→V1
//                  ProxyAdmin.upgradeAndCall round-trip succeeds.
//   2. BURN      — the exact documented sequence: SystemAccount.sealModules(), then renounce all 7
//                  ProxyAdmins, then renounce the three Ownable contracts (EFSIndexer, MirrorResolver,
//                  SystemAccount). Every owner ends at address(0).
//   3. POST-BURN — immutability is real: every ProxyAdmin.upgradeAndCall and every owner-gated setter
//                  reverts OwnableUnauthorizedAccount, and the module set is sealed. There is no path
//                  left to change code or owner.
//   4. FUNCTIONAL— immutable is not bricked: reads through the frozen proxies still work.
//
// The real ceremony hands ownership to the EFS.eth Safe and the Safe executes the burn; here the
// fork rehearsal stands a second signer in as that Safe (orchestrate's resolveSafe), and that signer
// performs the burn directly. The renounce → owner==0 → revert mechanics this asserts are identical
// whether the caller is a Safe or an EOA — the Safe execution plumbing itself is covered by
// DeploySafe.fork.test.ts. Here we prove the burn's EFFECT on the EFS contracts.
//
// Requires the pinned Sepolia fork (CreateX + EAS must be present). Run with:
//   MAINNET_FORKING_ENABLED=true npx hardhat test test/BurnToImmutable.fork.test.ts --network hardhat
// When not forking (CreateX absent), the suite skips itself so the default `yarn hardhat test` stays
// unaffected. Run as its OWN invocation — two `full` orchestrations in one fork session collide on the
// deterministic CREATE3 addresses (see Deploy.fork.test.ts).

const PROXY_ADMIN_FQN = "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol:ProxyAdmin";

// A non-zero throwaway bytes32 / address for the post-burn setter probes. The onlyOwner modifier
// fires BEFORE any body guard (one-shot AlreadySet, EOA/zero checks), so the argument value never
// matters — the ownership revert is what we assert.
const DUMMY_UID = "0x" + "11".repeat(32);

describe("BurnToImmutable.fork — upgradeable pre-burn, permanently immutable post-burn", function () {
  this.timeout(300_000);

  let forked = false;
  let deployer: Signer;
  let owner: Signer; // the stand-in "Safe" the deploy transfers ownership to (orchestrate.resolveSafe)
  let ownerAddr: string;
  let result: OrchestrationResult;

  // Bind a ProxyAdmin (OZ 5.x) to a signer.
  const proxyAdminAs = (admin: string, signer: Signer) => ethers.getContractAt(PROXY_ADMIN_FQN, admin, signer);

  before(async function () {
    const code = await ethers.provider.getCode(CREATEX_ADDRESS);
    forked = code !== "0x";
    if (!forked) {
      console.log("    (skipping BurnToImmutable.fork — CreateX not present; run with MAINNET_FORKING_ENABLED=true)");
      this.skip();
    }

    [deployer, owner] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();
    // EOA path: ownership transfers to `owner` (the second signer stands in as the EFS.eth Safe on the
    // fork). On a real network this must be the checksummed Safe; on the fork it's just a signer we can
    // drive the burn from.
    process.env.EFS_SAFE_ADDRESS = ownerAddr;

    result = await orchestrate(deployer, "full", false);
    expect(result.registered, "9 schemas registered").to.equal(true);
    expect(result.ownershipTransferred, "ownership handed to the stand-in Safe").to.equal(true);
    expect(result.safe.toLowerCase(), "owner is the stand-in Safe signer").to.equal(ownerAddr.toLowerCase());
  });

  it("is UPGRADEABLE pre-burn: all 7 ProxyAdmins owner-controlled + a real EFSIndexer V1→V2→V1 upgrade", async function () {
    // (a) Every proxy is upgrade-controllable by the owner: all 7 ProxyAdmins are owned by the owner,
    //     and the deployer (who created them) holds nothing.
    const deployerAddr = await deployer.getAddress();
    expect(Object.keys(result.deploys), "7 CREATE3 deploys (6 resolvers + SystemAccount)").to.have.lengthOf(7);
    for (const [name, d] of Object.entries(result.deploys)) {
      const pa = await proxyAdminAs(d.proxyAdmin, owner);
      expect((await pa.owner()).toLowerCase(), `${name} ProxyAdmin owned by Safe`).to.equal(ownerAddr.toLowerCase());
      expect((await pa.owner()).toLowerCase(), `${name} ProxyAdmin not deployer`).to.not.equal(
        deployerAddr.toLowerCase(),
      );
    }

    // (b) Concrete proof the upgrade path actually works: swap EFSIndexer's implementation to a V2 and
    //     back, through its ProxyAdmin, as the owner.
    const indexerProxy = result.proxies.EFSIndexer;
    const indexerAdmin = result.deploys.EFSIndexer.proxyAdmin;
    const v1Impl = result.deploys.EFSIndexer.impl;
    const anchorUidBefore = await (await ethers.getContractAt("EFSIndexer", indexerProxy, owner)).ANCHOR_SCHEMA_UID();

    // V1 → V2 (deploys a fresh MockEFSIndexerV2 impl and points the proxy at it).
    await upgradeProxy(indexerProxy, indexerAdmin, "MockEFSIndexerV2", [EAS_ADDRESS], owner);
    const v2 = await ethers.getContractAt("MockEFSIndexerV2", indexerProxy, owner);
    expect(await v2.mockVersion(), "V2 logic is live behind the proxy").to.equal(2n);
    // Existing namespaced state survived the upgrade (the schema UID the kernel was initialized with).
    expect((await v2.ANCHOR_SCHEMA_UID()).toLowerCase(), "state preserved across upgrade").to.equal(
      anchorUidBefore.toLowerCase(),
    );

    // V2 → V1 (restore the canonical implementation before the burn).
    const adminAsOwner = await proxyAdminAs(indexerAdmin, owner);
    await (await adminAsOwner.upgradeAndCall(indexerProxy, v1Impl, "0x")).wait();
    const restored = await ethers.getContractAt("EFSIndexer", indexerProxy, owner);
    expect((await restored.ANCHOR_SCHEMA_UID()).toLowerCase(), "back on V1, state intact").to.equal(
      anchorUidBefore.toLowerCase(),
    );
  });

  it("BURNS to immutable: sealModules + renounce 7 ProxyAdmins + 3 contract owners → every owner == 0", async function () {
    const sa = await ethers.getContractAt("SystemAccount", result.systemAccount, owner);

    // Pre-conditions documented in SEPOLIA_FREEZE_TABLE.md: bootstrap already sealed by the deploy,
    // modules not yet sealed.
    expect(await sa.bootstrapSealed(), "bootstrap sealed at deploy").to.equal(true);
    expect(await sa.modulesSealed(), "modules not yet sealed").to.equal(false);

    // Step 1: seal module-authorization membership (must precede the renounces).
    await (await sa.sealModules()).wait();
    expect(await sa.modulesSealed(), "modules sealed").to.equal(true);

    // Step 2: renounce all 7 ProxyAdmins — freezes the upgrade capability of every proxy.
    for (const [name, d] of Object.entries(result.deploys)) {
      const pa = await proxyAdminAs(d.proxyAdmin, owner);
      await (await pa.renounceOwnership()).wait();
      expect(await pa.owner(), `${name} ProxyAdmin owner == 0`).to.equal(ethers.ZeroAddress);
    }

    // Step 3: renounce the three Ownable contracts (their own OwnableUpgradeable owner, distinct from
    // the ProxyAdmin) — EFSIndexer, MirrorResolver, SystemAccount.
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, owner);
    const mirror = await ethers.getContractAt("MirrorResolver", result.proxies.MirrorResolver, owner);
    await (await indexer.renounceOwnership()).wait();
    await (await mirror.renounceOwnership()).wait();
    await (await sa.renounceOwnership()).wait();
    expect(await indexer.owner(), "EFSIndexer owner == 0").to.equal(ethers.ZeroAddress);
    expect(await mirror.owner(), "MirrorResolver owner == 0").to.equal(ethers.ZeroAddress);
    expect(await sa.owner(), "SystemAccount owner == 0").to.equal(ethers.ZeroAddress);
  });

  it("is IMMUTABLE post-burn: every upgrade path and owner-gated setter reverts", async function () {
    // (a) No proxy can be upgraded — every ProxyAdmin.upgradeAndCall reverts on ownership. The impl
    //     argument is the contract's current impl (the ownership check fires before it is touched).
    for (const [name, d] of Object.entries(result.deploys)) {
      const pa = await proxyAdminAs(d.proxyAdmin, owner);
      await expect(pa.upgradeAndCall(d.proxy, d.impl, "0x"), `${name} upgrade blocked`).to.be.revertedWithCustomError(
        pa,
        "OwnableUnauthorizedAccount",
      );
    }

    // (b) Every owner-gated setter reverts on ownership (onlyOwner fires before any body guard).
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, owner);
    const mirror = await ethers.getContractAt("MirrorResolver", result.proxies.MirrorResolver, owner);
    const sa = await ethers.getContractAt("SystemAccount", result.systemAccount, owner);

    await expect(indexer.setSortsAnchor(DUMMY_UID), "setSortsAnchor blocked").to.be.revertedWithCustomError(
      indexer,
      "OwnableUnauthorizedAccount",
    );
    await expect(mirror.setTransportsAnchor(DUMMY_UID), "setTransportsAnchor blocked").to.be.revertedWithCustomError(
      mirror,
      "OwnableUnauthorizedAccount",
    );
    await expect(
      sa.setModuleAuthorization(result.proxies.EFSIndexer, true),
      "setModuleAuthorization blocked",
    ).to.be.revertedWithCustomError(sa, "OwnableUnauthorizedAccount");
    // renounceOwnership and sealModules are themselves onlyOwner — re-calling reverts on ownership too,
    // so there is no residual authority hiding behind an idempotent path.
    await expect(sa.sealModules(), "sealModules blocked").to.be.revertedWithCustomError(
      sa,
      "OwnableUnauthorizedAccount",
    );
    await expect(indexer.renounceOwnership(), "re-renounce blocked").to.be.revertedWithCustomError(
      indexer,
      "OwnableUnauthorizedAccount",
    );
  });

  it("remains FUNCTIONAL post-burn: reads through the frozen proxies still work", async function () {
    // Immutable is not bricked — the proxies keep serving. The implementation pointer is simply frozen.
    const indexer = await ethers.getContractAt("EFSIndexer", result.proxies.EFSIndexer, owner);
    const mirror = await ethers.getContractAt("MirrorResolver", result.proxies.MirrorResolver, owner);
    const sa = await ethers.getContractAt("SystemAccount", result.systemAccount, owner);

    expect((await indexer.ANCHOR_SCHEMA_UID()).toLowerCase(), "kernel still reads its schema UIDs").to.equal(
      result.schemaUIDs.ANCHOR.toLowerCase(),
    );
    expect(await mirror.transportsAnchorUID(), "MirrorResolver still serves the transports anchor").to.not.equal(
      ethers.ZeroHash,
    );
    // SystemAccount still reports its frozen authority state; the sealed module set is auditable.
    expect(await sa.modulesSealed(), "module set stays sealed").to.equal(true);
    expect(Array.isArray(await sa.getAuthorizedModules()), "authorized-module enumeration still readable").to.equal(
      true,
    );
  });
});
