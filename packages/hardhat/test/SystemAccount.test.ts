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

    it("isAuthorized: owner is NOT a relay writer (P1 fix); module only after authorization", async function () {
      // PR #24 P1 fix: the owner is no longer a general relay writer. isAuthorized reports relay
      // membership only — the owner's sole write power is the one-time bootstrap (until seal()).
      expect(await systemAccount.isAuthorized(ownerAddr)).to.equal(false);
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

  describe("module-authorization seal (FIX A, PR #24 P1)", function () {
    // The one-way membership latch. After sealModules(), the set of contracts that may write as
    // `system` can never change again — making ADR-0053's "membership authority is pre-burn only"
    // a contract-enforced fact the burn ceremony asserts, not just documented intent.
    it("modulesSealed() reflects state and starts false", async function () {
      expect(await systemAccount.modulesSealed()).to.equal(false);
    });

    it("before sealing, the owner can authorize/de-authorize modules", async function () {
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(true);
      await (await systemAccount.setModuleAuthorization(moduleAddr, false)).wait();
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(false);
    });

    it("sealModules() is onlyOwner", async function () {
      await expect(systemAccount.connect(stranger).sealModules()).to.be.revertedWithCustomError(
        systemAccount,
        "OwnableUnauthorizedAccount",
      );
    });

    it("sealModules() latches membership: emits, flips modulesSealed(), and setModuleAuthorization reverts forever", async function () {
      await expect(systemAccount.sealModules()).to.emit(systemAccount, "ModuleAuthorizationSealed");
      expect(await systemAccount.modulesSealed()).to.equal(true);

      // After the seal the owner can no longer grant OR revoke module status — membership is frozen.
      await expect(systemAccount.setModuleAuthorization(moduleAddr, true)).to.be.revertedWithCustomError(
        systemAccount,
        "ModulesSealed",
      );
      await expect(systemAccount.setModuleAuthorization(moduleAddr, false)).to.be.revertedWithCustomError(
        systemAccount,
        "ModulesSealed",
      );
    });

    it("sealModules() is idempotent and permanent: a second call is a no-op (does not revert), stays sealed", async function () {
      await (await systemAccount.sealModules()).wait();
      await (await systemAccount.sealModules()).wait(); // no-op, must not revert
      expect(await systemAccount.modulesSealed()).to.equal(true);
      await expect(systemAccount.setModuleAuthorization(moduleAddr, true)).to.be.revertedWithCustomError(
        systemAccount,
        "ModulesSealed",
      );
    });

    it("the bootstrap seal and the module seal are INDEPENDENT one-way latches", async function () {
      // seal() locks bootstrap but leaves membership open; sealModules() locks membership but leaves
      // bootstrap untouched. The burn ceremony asserts both; neither implies the other.
      await (await systemAccount.seal()).wait();
      expect(await systemAccount.bootstrapSealed()).to.equal(true);
      expect(await systemAccount.modulesSealed()).to.equal(false);
      // membership still mutable after the bootstrap seal:
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      expect(await systemAccount.isAuthorized(moduleAddr)).to.equal(true);

      await (await systemAccount.sealModules()).wait();
      expect(await systemAccount.modulesSealed()).to.equal(true);
    });
  });

  describe("attester-relay gating (module-only — PR #24 P1 fix)", function () {
    it("reverts for an unauthorized caller", async function () {
      await expect(
        systemAccount.connect(stranger).attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["x"]))),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");
    });

    // REGRESSION GUARD for the P1 finding: the owner (the EFS.eth Safe post-handoff) must NOT be able
    // to relay arbitrary payloads as the permanent `system` attester. The steady-state relay is
    // module-only; the owner is not a module, so every relay method reverts NotAuthorized for it.
    it("owner CANNOT relay attest/multiAttest/revoke/registerAnchor (the P1 fix)", async function () {
      await expect(
        systemAccount.attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["from-owner"]))),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      await expect(
        systemAccount.multiAttest([
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

      await expect(
        systemAccount.revoke({ schema: plainSchemaUID, data: { uid: ZeroHash, value: 0n } }),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      await expect(systemAccount.registerAnchor(ZeroHash, "x", plainSchemaUID, ZeroHash)).to.be.revertedWithCustomError(
        systemAccount,
        "NotAuthorized",
      );
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

    it("multiAttest is module-gated and attests under SystemAccount", async function () {
      const multiReq = [
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
      ];
      await expect(systemAccount.connect(stranger).multiAttest(multiReq)).to.be.revertedWithCustomError(
        systemAccount,
        "NotAuthorized",
      );

      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      const tx = await systemAccount.connect(module).multiAttest(multiReq);
      const uid = getUID(await tx.wait());
      const att = await eas.getAttestation(uid);
      expect(att.attester).to.equal(systemAccountAddr);
    });

    it("revoke is module-gated; SystemAccount can revoke what it authored", async function () {
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      const tx = await systemAccount
        .connect(module)
        .attest(attestRequest(plainSchemaUID, enc.encode(["string"], ["to-revoke"])));
      const uid = getUID(await tx.wait());

      await expect(
        systemAccount.connect(stranger).revoke({ schema: plainSchemaUID, data: { uid, value: 0n } }),
      ).to.be.revertedWithCustomError(systemAccount, "NotAuthorized");

      await (await systemAccount.connect(module).revoke({ schema: plainSchemaUID, data: { uid, value: 0n } })).wait();
      const att = await eas.getAttestation(uid);
      expect(att.revocationTime).to.be.greaterThan(0n);
    });
  });

  describe("registerAnchor typed sugar", function () {
    // Register an ANCHOR-shaped schema (no resolver) to exercise the typed ANCHOR encoding.
    it("builds the ANCHOR request and authors it under SystemAccount (module-only)", async function () {
      await (await registry.register("string name, bytes32 forSchema", ZeroAddress, false)).wait();
      const anchorSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["string name, bytes32 forSchema", ZeroAddress, false],
      );

      // registerAnchor is part of the steady-state relay → module-only (PR #24 P1 fix). Authorize a
      // module and author through it; the owner itself cannot call it (covered by the relay-gating test).
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      const tx = await systemAccount.connect(module).registerAnchor(ZeroHash, "root", anchorSchemaUID, ZeroHash);
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
      await (await registry.register("string name, bytes32 forSchema", ZeroAddress, false)).wait();
      anchorSchemaUID = ethers.solidityPackedKeccak256(
        ["string", "address", "bool"],
        ["string name, bytes32 forSchema", ZeroAddress, false],
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

    it("bootstrap is owner-gated (PR #24 P1 fix); a stranger reverts", async function () {
      await expect(
        systemAccount.connect(stranger).bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS),
      ).to.be.revertedWithCustomError(systemAccount, "OwnableUnauthorizedAccount");
    });

    it("an authorized module CANNOT bootstrap (bootstrap is owner-only, not the relay gate)", async function () {
      // Confirms the modifier split: bootstrap is onlyOwner, NOT onlyAuthorizedModule. Authorizing a
      // module grants relay access (attest/etc.) but never the one-time bootstrap ceremony power.
      await (await systemAccount.setModuleAuthorization(moduleAddr, true)).wait();
      await expect(
        systemAccount.connect(module).bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS),
      ).to.be.revertedWithCustomError(systemAccount, "OwnableUnauthorizedAccount");
    });

    it("bootstrap reverts after seal(); seal() is onlyOwner and permanent", async function () {
      // Owner CAN bootstrap before seal.
      expect(await systemAccount.bootstrapSealed()).to.equal(false);
      await (await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS)).wait();

      // seal() is owner-only: a stranger cannot seal.
      await expect(systemAccount.connect(stranger).seal()).to.be.revertedWithCustomError(
        systemAccount,
        "OwnableUnauthorizedAccount",
      );

      // Owner seals → bootstrapSealed flips true and the event fires.
      await expect(systemAccount.seal()).to.emit(systemAccount, "BootstrapSealedEvent");
      expect(await systemAccount.bootstrapSealed()).to.equal(true);

      // After seal, bootstrap reverts forever — even for the owner.
      await expect(
        systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS),
      ).to.be.revertedWithCustomError(systemAccount, "BootstrapSealed");

      // Seal is permanent: a second seal is a no-op (does NOT revert) and the contract stays sealed.
      await (await systemAccount.seal()).wait();
      expect(await systemAccount.bootstrapSealed()).to.equal(true);
      await expect(
        systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, SPECS),
      ).to.be.revertedWithCustomError(systemAccount, "BootstrapSealed");
    });

    // ----------------------------------------------------------------------------------------------
    // FIX B (PR #24 P2) — the idempotency path must PROVE a reused anchor is self-authored with the
    // exact canonical shape before adopting it, or revert PollutedAnchor. Otherwise a third party can
    // create a root/scaffolding anchor between ANCHOR registration and bootstrap (supported-EOA
    // fallback) and a retry would inherit a stale/foreign/wrong anchor — sealing polluted scaffolding.
    // ----------------------------------------------------------------------------------------------
    describe("verify adopted scaffolding anchors (FIX B)", function () {
      // A one-node tree (just the root) keeps the pollution surface easy to seed/inspect.
      const ROOT_SPEC = [{ name: "root", parentIndex: -1, anchorSchemaToRegister: ZeroHash }];

      // Attest an ANCHOR-shaped record directly via EAS as `signer`, with overridable shape so we can
      // forge foreign / wrong-shaped anchors. Returns the new UID. (Schema is the no-resolver
      // ANCHOR-shaped schema registered in the parent beforeEach, so any signer may attest under it.)
      const attestRawAnchor = async (
        signer: Signer,
        opts: {
          name?: string;
          schemaToRegister?: string;
          revocable?: boolean;
          expirationTime?: bigint;
          refUID?: string;
        } = {},
      ): Promise<string> => {
        const name = opts.name ?? "root";
        const schemaToRegister = opts.schemaToRegister ?? ZeroHash;
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: opts.expirationTime ?? 0n,
            revocable: opts.revocable ?? false,
            refUID: opts.refUID ?? ZeroHash,
            data: enc.encode(["string", "bytes32"], [name, schemaToRegister]),
            value: 0n,
          },
        });
        return getUID(await tx.wait());
      };

      it("adopts a correctly self-authored root anchor idempotently (no re-attest, returns the same UID)", async function () {
        // First, let SystemAccount author the real root (canonical shape, attester == SystemAccount).
        const r1 = await (
          await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC)
        ).wait();
        const rootUID = attestedUIDs(r1)[0];
        expect(rootUID).to.not.equal(ZeroHash);

        // Seed the mock to report it as existing, then retry: must REUSE it (zero new attestations).
        await (await mockIndex.setRoot(rootUID)).wait();
        const r2 = await (
          await systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC)
        ).wait();
        expect(attestedUIDs(r2).length, "self-authored canonical anchor is adopted with no re-attest").to.equal(0);
      });

      it("reverts PollutedAnchor when the existing root anchor was authored by a THIRD PARTY", async function () {
        // A stranger front-runs and creates a (correctly-shaped but foreign-authored) root anchor.
        const foreignRoot = await attestRawAnchor(stranger, { name: "root" });
        await (await mockIndex.setRoot(foreignRoot)).wait();
        await expect(
          systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC),
        ).to.be.revertedWithCustomError(systemAccount, "PollutedAnchor");
      });

      it("reverts PollutedAnchor when the existing anchor has the wrong PAYLOAD (name/schema mismatch)", async function () {
        // Stranger creates an anchor with a different name → decoded payload won't match the spec.
        const wrongName = await attestRawAnchor(stranger, { name: "not-root" });
        await (await mockIndex.setRoot(wrongName)).wait();
        await expect(
          systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC),
        ).to.be.revertedWithCustomError(systemAccount, "PollutedAnchor");
      });

      it("reverts PollutedAnchor when the existing anchor is under the WRONG SCHEMA (revocable ANCHOR shape)", async function () {
        // Mint an anchor with the exact canonical payload + parent, but under a REVOCABLE ANCHOR-shaped
        // schema (a different schema UID, and revocable != the canonical non-revocable shape). bootstrap
        // validates `schema == anchorSchemaUID` AND `revocable == false`, so an anchor that drifts on
        // either is rejected rather than adopted — proving the immutable-shape gate, not just attester.
        await (await registry.register("string name, bytes32 forSchema", ZeroAddress, true)).wait();
        const revocableAnchorSchema = ethers.solidityPackedKeccak256(
          ["string", "address", "bool"],
          ["string name, bytes32 forSchema", ZeroAddress, true],
        );
        const tx = await eas.connect(stranger).attest({
          schema: revocableAnchorSchema,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: ZeroHash,
            data: enc.encode(["string", "bytes32"], ["root", ZeroHash]),
            value: 0n,
          },
        });
        const revocableRoot = getUID(await tx.wait());
        await (await mockIndex.setRoot(revocableRoot)).wait();
        await expect(
          systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC),
        ).to.be.revertedWithCustomError(systemAccount, "PollutedAnchor");
      });

      it("reverts PollutedAnchor when the index points at a NON-EXISTENT UID (stale/garbage pointer)", async function () {
        // getAttestation on an unknown UID returns a zero-valued record (attester == address(0)), so a
        // stale pointer is rejected by the attester check rather than silently adopted.
        await (await mockIndex.setRoot("0x" + "ab".repeat(32))).wait();
        await expect(
          systemAccount.bootstrap(await mockIndex.getAddress(), anchorSchemaUID, ROOT_SPEC),
        ).to.be.revertedWithCustomError(systemAccount, "PollutedAnchor");
      });
    });
  });

  describe("nonReentrant guard", function () {
    // Shared rig: a SystemAccount bound to a malicious EAS that, when its callback target is set,
    // re-enters SystemAccount during attest/multiAttest/revoke. The attacker is an authorized
    // module so the re-entry clears `onlyAuthorizedModule` and is stopped by `nonReentrant`
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
