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
            data: [
              {
                recipient: ZeroAddress,
                expirationTime: 0n,
                revocable: true,
                refUID: ZeroHash,
                data: enc.encode(["string"], ["m"]),
                value: 0n,
              },
            ],
          },
        ]),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      const tx = await systemAccount.multiAttest([
        {
          schema: plainSchemaUID,
          data: [
            {
              recipient: ZeroAddress,
              expirationTime: 0n,
              revocable: true,
              refUID: ZeroHash,
              data: enc.encode(["string"], ["m"]),
              value: 0n,
            },
          ],
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

  describe("bootstrap scaffolding tree (FIX 1, PR #24)", function () {
    // An ANCHOR-shaped schema (no resolver) so we can read attester/refUID off the raw EAS records
    // without standing up the full EFSIndexer + EdgeResolver chain. Idempotency reads go to a mock
    // index (MockAnchorIndex) that the test seeds to simulate prior (partial) bootstraps.
    let anchorSchemaUID: string;
    let mockIndex: any;

    // SCAFFOLDING (orchestrate.ts / safePlan.ts): root → tags/transports → 5 transport children.
    const SPECS = [
      { name: "root", parentIndex: -1, anchorSchemaToRegister: ZeroHash },
      { name: "tags", parentIndex: 0, anchorSchemaToRegister: ZeroHash },
      { name: "transports", parentIndex: 0, anchorSchemaToRegister: ZeroHash },
      { name: "onchain", parentIndex: 2, anchorSchemaToRegister: ZeroHash },
      { name: "ipfs", parentIndex: 2, anchorSchemaToRegister: ZeroHash },
      { name: "arweave", parentIndex: 2, anchorSchemaToRegister: ZeroHash },
      { name: "magnet", parentIndex: 2, anchorSchemaToRegister: ZeroHash },
      { name: "https", parentIndex: 2, anchorSchemaToRegister: ZeroHash },
    ];

    // Collect the UIDs of every Attested event in a receipt, in emission order.
    const attestedUIDs = (receipt: any): string[] => {
      const out: string[] = [];
      for (const log of receipt.logs) {
        try {
          const parsed = eas.interface.parseLog(log);
          if (parsed?.name === "Attested") out.push(parsed.args.uid);
        } catch {
          /* not an Attested log */
        }
      }
      return out;
    };

    beforeEach(async function () {
      await (await registry.register("string name, bytes32 schemaUID", ZeroAddress, false)).wait();
      anchorSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["string name, bytes32 schemaUID", ZeroAddress, false],
      );
      const MockFactory = await ethers.getContractFactory("MockAnchorIndex");
      mockIndex = await MockFactory.deploy();
      await mockIndex.waitForDeployment();
    });

    it("authors the whole tree in one call, attester == SystemAccount, correctly parented", async function () {
      const tx = await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS);
      const receipt = await tx.wait();
      const uids = attestedUIDs(receipt);
      // 8 fresh anchors (mock index reports nothing exists yet) → 8 Attested events.
      expect(uids.length).to.equal(8);

      // Every anchor authored by SystemAccount, each child's refUID == its parent's UID, root.refUID==0.
      for (let i = 0; i < SPECS.length; i++) {
        const att = await eas.getAttestation(uids[i]);
        expect(att.attester, `${SPECS[i].name} attester`).to.equal(systemAccountAddr);
        expect(att.schema).to.equal(anchorSchemaUID);
        const expectedParent = SPECS[i].parentIndex < 0 ? ZeroHash : uids[SPECS[i].parentIndex];
        expect(att.refUID, `${SPECS[i].name} refUID == parent`).to.equal(expectedParent);
        // ANCHOR data == abi.encode(name, ZeroHash).
        expect(att.data).to.equal(enc.encode(["string", "bytes32"], [SPECS[i].name, ZeroHash]));
      }
    });

    it("is idempotent: reuses already-created anchors (root + a child) instead of re-attesting", async function () {
      // First call: everything fresh.
      const r1 = await (await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS)).wait();
      const uids1 = attestedUIDs(r1);
      expect(uids1.length).to.equal(8);

      // Seed the mock to report the root + /transports as already existing (a partial prior bootstrap),
      // so a retry must REUSE them and only fill gaps — but here we report ALL as existing for a full
      // no-op retry. We map each spec's realized UID into the mock's path index.
      await (await mockIndex.setRoot(uids1[0])).wait();
      // children: setPath(parentUID, name, uid)
      for (let i = 1; i < SPECS.length; i++) {
        const parentUID = uids1[SPECS[i].parentIndex];
        await (await mockIndex.setPath(parentUID, SPECS[i].name, uids1[i])).wait();
      }

      // Second call: fully seeded → ZERO new attestations (idempotent no-op), returns the same UIDs.
      const r2 = await (await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS)).wait();
      expect(attestedUIDs(r2).length, "fully-seeded retry attests nothing").to.equal(0);
    });

    it("bootstrap is gated (onlyAuthorizedModuleOrOwner)", async function () {
      await expect(
        systemAccount.connect(stranger).bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");
    });
  });

  describe("nonReentrant guard", function () {
    // Shared rig: a SystemAccount bound to a malicious EAS that, when its callback target is set,
    // re-enters SystemAccount during attest/multiAttest/revoke. The attacker is an authorized
    // module so the re-entry clears `onlyAuthorizedModuleOrOwner` and is stopped by `nonReentrant`
    // specifically — not by the auth gate.
    let reentrantEAS: any;
    let saReentrant: any;
    let attacker: any;

    beforeEach(async function () {
      const ReentrantEASFactory = await ethers.getContractFactory("ReentrantEAS");
      reentrantEAS = await ReentrantEASFactory.deploy();
      await reentrantEAS.waitForDeployment();

      saReentrant = await deployResolverProxy("SystemAccount", [await reentrantEAS.getAddress()], [ownerAddr], owner);

      const AttackerFactory = await ethers.getContractFactory("SystemAccountReentrancyAttacker");
      attacker = await AttackerFactory.deploy(await (saReentrant as any).getAddress());
      await attacker.waitForDeployment();

      await (await (saReentrant as any).setModuleAuthorization(await attacker.getAddress(), true)).wait();
    });

    // mode: 0 = attest, 1 = multiAttest, 2 = revoke (matches the attacker's selector).
    const ENTRYPOINTS: Array<[string, number]> = [
      ["attest", 0],
      ["multiAttest", 1],
      ["revoke", 2],
    ];

    for (const [name, mode] of ENTRYPOINTS) {
      it(`reverts a re-entry into ${name} with the guard's custom error`, async function () {
        // Point the EAS callback at the attacker so the relayed call re-enters the same entrypoint.
        await (await reentrantEAS.setReentryTarget(await attacker.getAddress())).wait();

        // Assert the SPECIFIC guard error rather than a bare `reverted`: this is what distinguishes
        // a real ReentrancyGuard trip from a false-green (stack-too-deep / out-of-gas recursion),
        // which would NOT carry this custom error. The error is decoded against SystemAccount's
        // ABI (it inherits ReentrancyGuardUpgradeable), proving the revert came from the guard.
        await expect(attacker.attack(mode)).to.be.revertedWithCustomError(saReentrant, "ReentrancyGuardReentrantCall");
      });
    }

    it("positive control: a single non-reentrant attest through SystemAccount succeeds", async function () {
      // Same authorized attacker + same SystemAccount, but the EAS callback is left UNSET, so the
      // relayed attest does not re-enter. This proves the guard blocks reentry specifically — it
      // does not block ordinary single calls — so the reverts above are the guard, not a mock that
      // refuses every call.
      expect(await reentrantEAS.reentryTarget()).to.equal(ZeroAddress);
      await expect(attacker.attack(0)).to.not.be.reverted;
    });
  });
});
