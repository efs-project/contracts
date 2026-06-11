import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer, ZeroAddress, ZeroHash } from "ethers";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

// SystemAccount unit tests (ADR-0053). Proves the thin attester-relay + the authorization seam:
//   - authorized-module gating (unauthorized reverts; owner + authorized module succeed)
//   - setModuleAuthorization is onlyOwner
//   - an attest-through actually creates an EAS attestation whose attester == SystemAccount addr
//   - the nonReentrant guard holds on the attest path
//   - getEAS() / isAuthorized() views
//
// Non-fork: deploys a real EAS + SchemaRegistry locally (the same pattern the resolver tests use).
describe("SystemAccount (ADR-0053)", function () {
  let owner: Signer;
  let module: Signer;
  let stranger: Signer;
  let ownerAddr: string;
  let moduleAddr: string;

  let eas: any;
  let registry: any;
  let systemAccount: any;
  let systemAccountAddr: string;

  // A simple no-resolver schema to attest through (proves attester == SystemAccount).
  let plainSchemaUID: string;

  const enc = new ethers.AbiCoder();

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        /* not an Attested log */
      }
    }
    throw new Error("No Attested event found");
  };

  const attestRequest = (schema: string, data: string, revocable = true, refUID = ZeroHash) => ({
    schema,
    data: { recipient: ZeroAddress, expirationTime: 0n, revocable, refUID, data, value: 0n },
  });

  beforeEach(async function () {
    [owner, module, stranger] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();
    moduleAddr = await module.getAddress();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // A plain revocable schema with no resolver — anyone can attest; we read back the attester.
    await (await registry.register("string value", ZeroAddress, true)).wait();
    plainSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], ["string value", ZeroAddress, true]);

    // Deploy SystemAccount behind a proxy; initialize(owner_=ownerAddr).
    systemAccount = await deployResolverProxy("SystemAccount", [await eas.getAddress()], [ownerAddr], owner);
    systemAccountAddr = await systemAccount.getAddress();
  });

  describe("config + views", function () {
    it("initializes with the deployer as owner and binds EAS", async function () {
      expect(await systemAccount.owner()).to.equal(ownerAddr);
      expect(await systemAccount.getEAS()).to.equal(await eas.getAddress());
    });

    it("isAuthorized: owner always; module only after authorization", async function () {
      expect(await systemAccount.isAuthorized(ownerAddr)).to.equal(true);
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(false);
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(true);
      await (await systemAccount.setModuleAuthorization(moduleAddr, false)).wait();
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(false);
    });

    it("setModuleAuthorization is onlyOwner", async function () {
      await expect(systemAccount.connect(module).setModuleAuthorization(moduleAddr, true)).to.be.reverted;
      // owner succeeds + emits
      await expect(systemAccount.setModuleAuthorization(moduleAddr, true))
        .to.emit(systemAccount, "ModuleAuthorizationSet")
        .withArgs(moduleAddr, true);
    });

    it("setModuleAuthorization rejects the zero address", async function () {
      await expect(systemAccount.setModuleAuthorization(ZeroAddress, true)).to.be.revertedWithCustomError(
        systemAccount,
        "ZeroAddress",
      );
    });
  });

  describe("attester-relay gating", function () {
    it("reverts for an unauthorized caller", async function () {
      await expect(
        systemAccount.connect(stranger).attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["x"]))),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");
    });

    it("owner can author; the EAS attester == SystemAccount address", async function () {
      const tx = await systemAccount.attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["from-owner"])));
      const uid = getUID(await tx.wait());
      const att = await eas.getAttestation(uid);
      expect(att.attester).to.equal(systemAccountAddr);
      expect(att.schema).to.equal(plainSchemaUID);
    });

    it("an authorized module can author; the EAS attester == SystemAccount address", async function () {
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      const tx = await systemAccount
        .connect(module)
        .attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["from-module"])));
      const uid = getUID(await tx.wait());
      const att = await eas.getAttestation(uid);
      expect(att.attester).to.equal(systemAccountAddr);
    });

    it("multiAttest is gated and attests under SystemAccount", async function () {
      await expect(
        systemAccount.connect(stranger).multiAttest([
          {
            schema: plainSchemaUID,
            data: [{ recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: ZeroHash, data: enc.encode(["string"], ["m"]), value: 0n }],
          },
        ]),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      const tx = await systemAccount.multiAttest([
        {
          schema: plainSchemaUID,
          data: [{ recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: ZeroHash, data: enc.encode(["string"], ["m"]), value: 0n }],
        },
      ]);
      const uid = getUID(await tx.wait());
      const att = await eas.getAttestation(uid);
      expect(att.attester).to.equal(systemAccountAddr);
    });

    it("revoke is gated; SystemAccount can revoke what it authored", async function () {
      const tx = await systemAccount.attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["to-revoke"])));
      const uid = getUID(await tx.wait());

      await expect(
        systemAccount.connect(stranger).revoke({ schema: plainSchemaUID, data: { uid, value: 0n } }),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      await (await systemAccount.revoke({ schema: plainSchemaUID, data: { uid, value: 0n } })).wait();
      const att = await eas.getAttestation(uid);
      expect(att.revocationTime).to.be.greaterThan(0n);
    });
  });

  describe("registerAnchor typed sugar", function () {
    // Register an ANCHOR-shaped schema (no resolver) to exercise the typed ANCHOR encoding.
    it("builds the ANCHOR request and authors it under SystemAccount", async function () {
      await (await registry.register("string name, bytes32 schemaUID", ZeroAddress, false)).wait();
      const anchorSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["string name, bytes32 schemaUID", ZeroAddress, false],
      );

      const tx = await systemAccount.registerAnchor(ZeroHash, "root", anchorSchemaUID, ZeroHash);
      const uid = getUID(await tx.wait());
      const att = await eas.getAttestation(uid);
      expect(att.attester).to.equal(systemAccountAddr);
      // ANCHOR data == abi.encode("root", ZeroHash) — matches orchestrate.ts ensureAnchor encoding.
      expect(att.data).to.equal(enc.encode(["string", "bytes32"], ["root", ZeroHash]));

      await expect(
        systemAccount.connect(stranger).registerAnchor(ZeroHash, "x", anchorSchemaUID, ZeroHash),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");
    });
  });

  describe("nonReentrant guard", function () {
    it("reverts a re-entry into attest", async function () {
      // Deploy a SystemAccount bound to a malicious EAS that re-enters during attest.
      const ReentrantEASFactory = await ethers.getContractFactory("ReentrantEAS");
      const reentrantEAS = await ReentrantEASFactory.deploy();
      await reentrantEAS.waitForDeployment();

      const saReentrant = await deployResolverProxy(
        "SystemAccount",
        [await reentrantEAS.getAddress()],
        [ownerAddr],
        owner,
      );

      const AttackerFactory = await ethers.getContractFactory("SystemAccountReentrancyAttacker");
      const attacker = await AttackerFactory.deploy(await (saReentrant as any).getAddress());
      await attacker.waitForDeployment();

      // Authorize the attacker as a module, point the EAS callback at it, then attack.
      await (await (saReentrant as any).setModuleAuthorization(await attacker.getAddress(), true)).wait();
      await (await reentrantEAS.setReentryTarget(await attacker.getAddress())).wait();

      // The re-entry trips ReentrancyGuardUpgradeable, bubbling up to revert the outer attest.
      await expect(attacker.attack()).to.be.reverted;
    });
  });
});
