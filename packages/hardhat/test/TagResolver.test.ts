import { expect } from "chai";
import { ethers } from "hardhat";
import { TagResolver, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

/**
 * TagResolver tests.
 *
 * Key EAS constraint: `refUID` must be an EXISTING attestation UID.
 * EAS throws NotFound() if refUID is non-zero and not a real attestation.
 * Therefore, tests that need a "target" must either:
 *   a) Use a real attestation UID (created with the dummy schema), OR
 *   b) Target via `recipient` address (refUID=0, recipient=someAddress).
 */
describe("TagResolver", function () {
  let tagResolver: TagResolver;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let tagSchemaUID: string;
  let dummySchemaUID: string; // schema with no resolver, used to mint target attestations

  const enc = new ethers.AbiCoder();
  const encodeTag = (definition: string, applies: boolean) => enc.encode(["bytes32", "bool"], [definition, applies]);

  // ─── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const TagResolverFactory = await ethers.getContractFactory("TagResolver");
    tagResolver = await TagResolverFactory.deploy(await eas.getAddress());
    await tagResolver.waitForDeployment();

    // TAG schema: registered with TagResolver
    const tagSchemaTx = await registry.register(
      "bytes32 definition, bool applies",
      await tagResolver.getAddress(),
      true,
    );
    tagSchemaUID = (await tagSchemaTx.wait())!.logs[0].topics[1];

    // Dummy schema: no resolver, used to create target attestations with real UIDs
    const dummySchemaTx = await registry.register("string label", ZeroAddress, false);
    dummySchemaUID = (await dummySchemaTx.wait())!.logs[0].topics[1];
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Extract the first EAS Attested UID from a receipt. */
  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("No Attested event found in receipt");
  };

  /**
   * Create a real EAS attestation using the dummy schema.
   * Returns its UID, which can be used as a valid refUID.
   */
  const createTarget = async (label = "target"): Promise<string> => {
    const tx = await eas.attest({
      schema: dummySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: enc.encode(["string"], [label]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Attest a TAG (via refUID) from a specific signer. */
  const tagByRef = async (signer: Signer, targetUID: string, definition: string, applies: boolean): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodeTag(definition, applies),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Attest a TAG targeting a recipient address (refUID=0). */
  const tagByAddress = async (
    signer: Signer,
    recipient: string,
    definition: string,
    applies: boolean,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeTag(definition, applies),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Revoke a TAG attestation. */
  const revoke = async (signer: Signer, uid: string) => {
    const tx = await eas.connect(signer).revoke({ schema: tagSchemaUID, data: { uid, value: 0n } });
    await tx.wait();
  };

  // ─── Basic attesting ───────────────────────────────────────────────────────

  describe("Basic attesting", function () {
    it("Should accept a tag with applies=true targeting a real refUID", async function () {
      const definition = ethers.id("favs");
      const target = await createTarget("file-1");

      const tagUID = await tagByRef(user1, target, definition, true);
      expect(tagUID).to.not.equal(ZERO_BYTES32);

      const active = await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition);
      expect(active).to.equal(tagUID);
    });

    it("Should accept a tag with applies=false (negation)", async function () {
      const definition = ethers.id("nsfw");
      const target = await createTarget("file-neg");

      const tagUID = await tagByRef(user1, target, definition, false);
      expect(tagUID).to.not.equal(ZERO_BYTES32);

      const active = await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition);
      expect(active).to.equal(tagUID);
    });

    it("Should revert MustTargetSomething when both refUID and recipient are zero", async function () {
      await expect(
        eas.attest({
          schema: tagSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeTag(ethers.ZeroHash, true),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(tagResolver, "MustTargetSomething");
    });
  });

  // ─── Targeting ─────────────────────────────────────────────────────────────

  describe("Targeting", function () {
    it("Should resolve target via refUID", async function () {
      const definition = ethers.id("def-ref");
      const target = await createTarget("ref-target");

      const tagUID = await tagByRef(user1, target, definition, true);
      const active = await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition);
      expect(active).to.equal(tagUID);
    });

    it("Should resolve target via recipient address when refUID is zero", async function () {
      const definition = ethers.id("def-addr");
      const recipientAddr = await user2.getAddress();
      // targetID in TagResolver = bytes32(uint256(uint160(recipient)))
      const targetID = ethers.zeroPadValue(recipientAddr, 32);

      const tagUID = await tagByAddress(user1, recipientAddr, definition, true);
      const active = await tagResolver.getActiveTagUID(await user1.getAddress(), targetID, definition);
      expect(active).to.equal(tagUID);
    });

    it("Should prefer refUID over recipient when both are non-zero", async function () {
      const definition = ethers.id("def-prefer-ref");
      const refTarget = await createTarget("prefer-ref");
      const recipientAddr = await user2.getAddress();
      const recipientTargetID = ethers.zeroPadValue(recipientAddr, 32);

      const tx = await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: recipientAddr,   // non-zero recipient
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: refTarget,          // non-zero refUID takes priority
          data: encodeTag(definition, true),
          value: 0n,
        },
      });
      const tagUID = getUID(await tx.wait());

      // Indexed under refTarget
      expect(await tagResolver.getActiveTagUID(await owner.getAddress(), refTarget, definition)).to.equal(tagUID);
      // NOT indexed under recipient
      expect(await tagResolver.getActiveTagUID(await owner.getAddress(), recipientTargetID, definition)).to.equal(ZERO_BYTES32);
    });
  });

  // ─── Singleton (logical superseding) ───────────────────────────────────────

  describe("Singleton (logical superseding)", function () {
    it("Should overwrite active UID when same (attester, target, definition) attests again", async function () {
      const target = await createTarget("singleton-target");
      const definition = ethers.id("def-singleton");

      const uid1 = await tagByRef(user1, target, definition, true);
      const uid2 = await tagByRef(user1, target, definition, true);

      expect(uid1).to.not.equal(uid2);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(uid2);
    });

    it("Should keep superseded UID on-chain (just no longer active)", async function () {
      const target = await createTarget("supersede-persist");
      const definition = ethers.id("def-persist");

      const uid1 = await tagByRef(user1, target, definition, true);
      await tagByRef(user1, target, definition, true); // uid2 supersedes

      // uid1 is still a valid on-chain attestation
      const attestation = await eas.getAttestation(uid1);
      expect(attestation.uid).to.equal(uid1);
    });

    it("Should allow different attesters to independently tag the same target", async function () {
      const target = await createTarget("shared-target");
      const definition = ethers.id("shared-def");

      const uid1 = await tagByRef(user1, target, definition, true);
      const uid2 = await tagByRef(user2, target, definition, true);

      expect(uid1).to.not.equal(uid2);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(uid1);
      expect(await tagResolver.getActiveTagUID(await user2.getAddress(), target, definition)).to.equal(uid2);
    });

    it("Should allow same attester to tag different targets with the same definition independently", async function () {
      const target1 = await createTarget("multi-A");
      const target2 = await createTarget("multi-B");
      const definition = ethers.id("def-multi-target");

      const uid1 = await tagByRef(user1, target1, definition, true);
      const uid2 = await tagByRef(user1, target2, definition, true);

      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target1, definition)).to.equal(uid1);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target2, definition)).to.equal(uid2);
    });

    it("Should allow same attester+target pair with different definitions independently", async function () {
      const target = await createTarget("multi-def-target");
      const def1 = ethers.id("def-X");
      const def2 = ethers.id("def-Y");

      const uid1 = await tagByRef(user1, target, def1, true);
      const uid2 = await tagByRef(user1, target, def2, true);

      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, def1)).to.equal(uid1);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, def2)).to.equal(uid2);
    });
  });

  // ─── Revocation ────────────────────────────────────────────────────────────

  describe("Revocation", function () {
    it("Should clear active UID when the active attestation is revoked", async function () {
      const target = await createTarget("revoke-target");
      const definition = ethers.id("def-revoke");

      const uid = await tagByRef(user1, target, definition, true);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(uid);

      await revoke(user1, uid);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(ZERO_BYTES32);
    });

    it("Should NOT clear active UID when a superseded (old) UID is revoked", async function () {
      const target = await createTarget("old-revoke-target");
      const definition = ethers.id("def-old-revoke");

      const uid1 = await tagByRef(user1, target, definition, true);
      const uid2 = await tagByRef(user1, target, definition, true); // supersedes uid1

      await revoke(user1, uid1); // revoke the old, now-superseded attestation

      // uid2 should remain active
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(uid2);
    });

    it("Should clear correctly after multiple superseding rounds", async function () {
      const target = await createTarget("multi-round-target");
      const definition = ethers.id("def-multi-round");

      await tagByRef(user1, target, definition, true);  // uid1 (will be superseded)
      await tagByRef(user1, target, definition, true);  // uid2 (will be superseded)
      const uid3 = await tagByRef(user1, target, definition, true);  // uid3 (active)

      await revoke(user1, uid3);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, definition)).to.equal(ZERO_BYTES32);
    });
  });

  // ─── Discovery: Tag Definitions per Target ─────────────────────────────────

  describe("Discovery: getTagDefinitions / getTagDefinitionCount", function () {
    it("Should record a definition when first applied with applies=true", async function () {
      const target = await createTarget("disc-target-1");
      const def = ethers.id("def-disc-1");

      await tagByRef(user1, target, def, true);

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(1n);
      const defs = await tagResolver.getTagDefinitions(target, 0n, 10n);
      expect(defs.length).to.equal(1);
      expect(defs[0]).to.equal(def);
    });

    it("Should NOT duplicate a definition when the same one is applied again (superseding)", async function () {
      const target = await createTarget("disc-target-2");
      const def = ethers.id("def-disc-2");

      await tagByRef(user1, target, def, true);
      await tagByRef(user1, target, def, true); // same triple again

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(1n);
    });

    it("Should NOT duplicate when two different attesters apply the same definition", async function () {
      const target = await createTarget("disc-target-2b");
      const def = ethers.id("def-disc-2b");

      await tagByRef(user1, target, def, true);
      await tagByRef(user2, target, def, true); // different attester, same def

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(1n);
    });

    it("Should record multiple distinct definitions for the same target", async function () {
      const target = await createTarget("disc-target-3");
      const def1 = ethers.id("def-disc-3a");
      const def2 = ethers.id("def-disc-3b");
      const def3 = ethers.id("def-disc-3c");

      await tagByRef(user1, target, def1, true);
      await tagByRef(user2, target, def2, true);
      await tagByRef(user1, target, def3, true);

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(3n);
      const defs = await tagResolver.getTagDefinitions(target, 0n, 10n);
      expect(defs).to.include(def1).and.to.include(def2).and.to.include(def3);
    });

    it("Should NOT record a definition when applies=false on first attestation", async function () {
      const target = await createTarget("disc-target-4");
      const def = ethers.id("def-disc-4");

      await tagByRef(user1, target, def, false); // negation before any positive

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(0n);
    });

    it("Should keep definition in discovery list even after the tag is revoked (append-only)", async function () {
      const target = await createTarget("disc-target-5");
      const def = ethers.id("def-disc-5");

      const uid = await tagByRef(user1, target, def, true);
      await revoke(user1, uid);

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(1n);
    });

    it("Should paginate getTagDefinitions correctly", async function () {
      const target = await createTarget("disc-paginate");
      const defs = await Promise.all(
        Array.from({ length: 5 }, (_, i) => tagByRef(user1, target, ethers.id(`def-pg-${i}`), true).then(() => ethers.id(`def-pg-${i}`))),
      );
      void defs; // just to avoid lint warning

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(5n);

      const page1 = await tagResolver.getTagDefinitions(target, 0n, 3n);
      expect(page1.length).to.equal(3);

      const page2 = await tagResolver.getTagDefinitions(target, 3n, 3n);
      expect(page2.length).to.equal(2);

      const empty = await tagResolver.getTagDefinitions(target, 10n, 3n);
      expect(empty.length).to.equal(0);
    });
  });

  // ─── Discovery: Tagged Targets per Definition ──────────────────────────────

  describe("Discovery: getTaggedTargets / getTaggedTargetCount", function () {
    it("Should record a target when first tagged with a definition", async function () {
      const def = ethers.id("def-targets-1");
      const target = await createTarget("tagged-1");

      await tagByRef(user1, target, def, true);

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(1n);
      const targets = await tagResolver.getTaggedTargets(def, 0n, 10n);
      expect(targets.length).to.equal(1);
      expect(targets[0]).to.equal(target);
    });

    it("Should NOT duplicate a target when multiple attesters tag the same target with the same definition", async function () {
      const def = ethers.id("def-targets-2");
      const target = await createTarget("tagged-2");

      await tagByRef(user1, target, def, true);
      await tagByRef(user2, target, def, true);

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(1n);
    });

    it("Should record multiple distinct targets for the same definition", async function () {
      const def = ethers.id("def-targets-3");
      const t1 = await createTarget("multi-t1");
      const t2 = await createTarget("multi-t2");
      const t3 = await createTarget("multi-t3");

      await tagByRef(user1, t1, def, true);
      await tagByRef(user1, t2, def, true);
      await tagByRef(user2, t3, def, true);

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(3n);
      const targets = await tagResolver.getTaggedTargets(def, 0n, 10n);
      expect(targets).to.include(t1).and.to.include(t2).and.to.include(t3);
    });

    it("Should NOT record a target when applies=false on first attestation", async function () {
      const def = ethers.id("def-targets-4");
      const target = await createTarget("tagged-4");

      await tagByRef(user1, target, def, false);

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(0n);
    });

    it("Should keep target in discovery list even after tag is revoked (append-only)", async function () {
      const def = ethers.id("def-targets-5");
      const target = await createTarget("tagged-5");

      const uid = await tagByRef(user1, target, def, true);
      await revoke(user1, uid);

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(1n);
    });

    it("Should paginate getTaggedTargets correctly", async function () {
      const def = ethers.id("def-paginate-targets");
      const targets = await Promise.all(Array.from({ length: 5 }, (_, i) => createTarget(`pg-target-${i}`)));
      for (const t of targets) {
        await tagByRef(user1, t, def, true);
      }

      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(5n);

      const page1 = await tagResolver.getTaggedTargets(def, 0n, 3n);
      expect(page1.length).to.equal(3);

      const page2 = await tagResolver.getTaggedTargets(def, 3n, 3n);
      expect(page2.length).to.equal(2);

      const empty = await tagResolver.getTaggedTargets(def, 10n, 3n);
      expect(empty.length).to.equal(0);
    });
  });

  // ─── Superseding with applies=false ────────────────────────────────────────

  describe("Superseding with applies=false", function () {
    it("Should update active UID to applies=false attestation after superseding", async function () {
      const target = await createTarget("neg-supersede");
      const def = ethers.id("def-neg-supersede");

      await tagByRef(user1, target, def, true);   // initial apply
      const uid2 = await tagByRef(user1, target, def, false); // negation supersedes

      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, def)).to.equal(uid2);

      const attestation = await eas.getAttestation(uid2);
      const [, appliesVal] = enc.decode(["bytes32", "bool"], attestation.data);
      expect(appliesVal).to.be.false;
    });

    it("Should keep discovery lists intact after superseding with applies=false (append-only)", async function () {
      const target = await createTarget("neg-disc-persist");
      const def = ethers.id("def-neg-disc");

      await tagByRef(user1, target, def, true);
      await tagByRef(user1, target, def, false); // supersede with negation

      // Both discovery lists are append-only — should still have 1 entry each
      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(1n);
      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(1n);
    });

    it("Should NOT add to discovery when applies=false on a first-time definition", async function () {
      const target = await createTarget("neg-first");
      const def = ethers.id("def-neg-first");

      // Negation before any positive: discovery lists remain empty
      await tagByRef(user1, target, def, false);

      expect(await tagResolver.getTagDefinitionCount(target)).to.equal(0n);
      expect(await tagResolver.getTaggedTargetCount(def)).to.equal(0n);
    });
  });

  // ─── getActiveTagUID edge cases ────────────────────────────────────────────

  describe("getActiveTagUID edge cases", function () {
    it("Should return zero for an unknown (attester, target, definition) triple", async function () {
      const target = await createTarget("unknown-target");
      const active = await tagResolver.getActiveTagUID(await user1.getAddress(), target, ethers.id("no-such-def"));
      expect(active).to.equal(ZERO_BYTES32);
    });

    it("Should return zero after the active attestation is revoked", async function () {
      const target = await createTarget("revoke-check");
      const def = ethers.id("def-revoke-check");

      const uid = await tagByRef(user1, target, def, true);
      await revoke(user1, uid);

      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), target, def)).to.equal(ZERO_BYTES32);
    });

    it("Should correctly track independent state for different (attester, target, definition) combinations", async function () {
      const t1 = await createTarget("combo-t1");
      const t2 = await createTarget("combo-t2");
      const def1 = ethers.id("combo-def1");
      const def2 = ethers.id("combo-def2");

      const u1t1d1 = await tagByRef(user1, t1, def1, true);
      const u1t1d2 = await tagByRef(user1, t1, def2, true);
      const u1t2d1 = await tagByRef(user1, t2, def1, true);
      const u2t1d1 = await tagByRef(user2, t1, def1, true);

      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), t1, def1)).to.equal(u1t1d1);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), t1, def2)).to.equal(u1t1d2);
      expect(await tagResolver.getActiveTagUID(await user1.getAddress(), t2, def1)).to.equal(u1t2d1);
      expect(await tagResolver.getActiveTagUID(await user2.getAddress(), t1, def1)).to.equal(u2t1d1);
    });
  });
});
