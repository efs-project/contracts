import { expect } from "chai";
import { ethers, network } from "hardhat";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy/lib/addresses";
import { orchestrate } from "../deploy/lib/orchestrate";
import { RESOLVERS, SCHEMAS } from "../deploy/lib/schemas";

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

  before(async function () {
    const code = await ethers.provider.getCode(CREATEX_ADDRESS);
    forked = code !== "0x";
    if (!forked) {
      console.log("    (skipping Deploy.fork — CreateX not present; run with MAINNET_FORKING_ENABLED=true)");
      this.skip();
    }
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
  });

  after(function () {
    delete process.env.EFS_SAFE_ADDRESS;
    void network;
  });
});
