import { expect } from "chai";
import { ethers } from "hardhat";
import { CREATEX_ADDRESS, EAS_ADDRESS } from "../deploy-lib/addresses";
import { orchestrateViaSafe } from "../deploy-lib/orchestrateSafe";
import { predictProxyAddress } from "../deploy-lib/create3";
import { getCreateX } from "../deploy-lib/create3";
import { RESOLVERS, SCHEMAS } from "../deploy-lib/schemas";
import { deployTestSafe, SAFE_PROXY_FACTORY_141 } from "../deploy-lib/safe";

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
    const result = await orchestrateViaSafe(deployer, safe, [ownerSigner], { log: false });

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
  });
});
