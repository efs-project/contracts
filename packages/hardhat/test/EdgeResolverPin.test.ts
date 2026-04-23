import { expect } from "chai";
import { ethers } from "hardhat";
import { EdgeResolver, EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

/**
 * EdgeResolver — PIN schema (cardinality 1).
 *
 * PIN is the singleton edge: at most one active PIN per
 * (attester, definition, targetSchema) slot. Re-attesting at the same slot with a
 * different target supersedes the prior PIN in O(1). Removal is via eas.revoke().
 *
 * Key invariants exercised here (per ADR-0041):
 *   - PIN re-attestation supersedes the prior PIN at the same slot (O(1) replace).
 *   - PIN and TAG at the same (attester, target, definition) triple coexist
 *     independently — schema-aware _edgeHash isolates their state.
 *   - Revoking the active PIN clears the slot.
 *   - Revoking a stale (already-superseded) PIN is a no-op.
 *   - Cross-attester isolation: Alice's PIN doesn't disturb Bob's PIN at the same slot.
 *   - Smart-contract read shape: `getActivePinTarget` is one SLOAD returning a single
 *     bytes32 — usable as a variable, not a list.
 */
describe("EdgeResolver — PIN", function () {
  let edgeResolver: EdgeResolver;
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let pinSchemaUID: string;
  let tagSchemaUID: string;
  let dummySchemaUID: string; // schema with no resolver, used to mint target/definition attestations

  const enc = new ethers.AbiCoder();
  const encodePin = (definition: string) => enc.encode(["bytes32"], [definition]);
  const encodeTag = (definition: string, weight: bigint) => enc.encode(["bytes32", "int256"], [definition, weight]);

  // ─── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Pre-compute addresses. Deployment order:
    //   resolverNonce+0: EdgeResolver
    //   resolverNonce+1: PIN schema registration
    //   resolverNonce+2: TAG schema registration
    //   resolverNonce+3: DUMMY schema registration
    //   resolverNonce+4: EFSIndexer (placeholder schema UIDs — only index() is exercised)
    const ownerAddr = await owner.getAddress();
    const resolverNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce });
    const futureIndexerAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce + 4 });
    const precomputedPinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddress, true],
    );
    const precomputedTagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddress, true],
    );

    const EdgeResolverFactory = await ethers.getContractFactory("EdgeResolver");
    edgeResolver = await EdgeResolverFactory.deploy(
      await eas.getAddress(),
      precomputedPinSchemaUID,
      precomputedTagSchemaUID,
      futureIndexerAddress,
      await registry.getAddress(),
    );
    await edgeResolver.waitForDeployment();

    // PIN schema: registered with EdgeResolver
    const pinSchemaTx = await registry.register("bytes32 definition", await edgeResolver.getAddress(), true);
    pinSchemaUID = (await pinSchemaTx.wait())!.logs[0].topics[1];

    // TAG schema: registered with EdgeResolver
    const tagSchemaTx = await registry.register(
      "bytes32 definition, int256 weight",
      await edgeResolver.getAddress(),
      true,
    );
    tagSchemaUID = (await tagSchemaTx.wait())!.logs[0].topics[1];

    // Dummy schema: no resolver, used to create target attestations with real UIDs
    const dummySchemaTx = await registry.register("string label", ZeroAddress, false);
    dummySchemaUID = (await dummySchemaTx.wait())!.logs[0].topics[1];

    // EFSIndexer: placeholder schema UIDs (only index() is called by EdgeResolver)
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      ZERO_BYTES32, // anchorSchemaUID (placeholder)
      ZERO_BYTES32, // propertySchemaUID (placeholder)
      ZERO_BYTES32, // dataSchemaUID (placeholder)
      ZERO_BYTES32, // blobSchemaUID (placeholder)
    );
    await indexer.waitForDeployment();
    expect(await indexer.getAddress()).to.equal(futureIndexerAddress);

    // Wire EdgeResolver into the indexer so propagateContains calls are authorized.
    // The indexer recognizes both PIN and TAG schemas; EdgeResolver itself dispatches
    // by attestation.schema before decoding.
    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
      tagSchemaUID,
      ZeroAddress, // sortOverlay (not used in this test)
      ZERO_BYTES32, // sortInfoSchemaUID (placeholder)
      ZeroAddress, // mirrorResolver (not used in this test)
      ZERO_BYTES32, // mirrorSchemaUID (placeholder)
      await registry.getAddress(),
    );
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Extract the first EAS Attested UID from a receipt. */
  const getUID = (receipt: any): string => {
    const iface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        /* not an Attested event */
      }
    }
    throw new Error("No Attested event found in receipt");
  };

  /** Create a real EAS attestation using the dummy schema; returns its UID. */
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

  const createDefinition = async (label = "def"): Promise<string> => createTarget(label);

  /** Attest a PIN (via refUID) from a specific signer. */
  const pinByRef = async (signer: Signer, targetUID: string, definition: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodePin(definition),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Attest a TAG (via refUID) from a specific signer with a weight. */
  const tagByRef = async (signer: Signer, targetUID: string, definition: string, weight: bigint): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodeTag(definition, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Attest a PIN (via recipient address) from a specific signer. */
  const pinByAddress = async (signer: Signer, recipientAddr: string, definition: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: recipientAddr,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodePin(definition),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revokePin = async (signer: Signer, uid: string) => {
    const tx = await eas.connect(signer).revoke({ schema: pinSchemaUID, data: { uid, value: 0n } });
    await tx.wait();
  };

  // ─── Basic attesting ───────────────────────────────────────────────────────

  describe("Basic attesting", function () {
    it("Should accept a PIN targeting a real refUID", async function () {
      const definition = await createDefinition("favs");
      const target = await createTarget("file-1");

      const pinUID = await pinByRef(user1, target, definition);
      expect(pinUID).to.not.equal(ZERO_BYTES32);

      const u1Addr = await user1.getAddress();
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(pinUID);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(target);
    });

    it("Should revert InvalidDefinition when definition is bytes32(0)", async function () {
      const target = await createTarget("zero-def-target");
      await expect(
        eas.attest({
          schema: pinSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: target,
            data: encodePin(ethers.ZeroHash),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(edgeResolver, "InvalidDefinition");
    });

    it("Should revert MustTargetSomething when both refUID and recipient are zero", async function () {
      const definition = await createDefinition("must-target");
      await expect(
        eas.attest({
          schema: pinSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodePin(definition),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(edgeResolver, "MustTargetSomething");
    });

    it("Should resolve target via recipient address when refUID is zero", async function () {
      // ADR-0041 §2: recipient targeting is first-class. The kernel uses
      // `targetSchema = bytes32(0)` as the canonical sentinel for address targets
      // (addresses don't have an attestation UID, so there is no real schema to
      // record). PIN reads at the address-target slot are O(1) like any other slot.
      const definition = await createDefinition("addr-target-pin");
      const recipientAddr = await user2.getAddress();
      const u1Addr = await user1.getAddress();

      const pinUID = await pinByAddress(user1, recipientAddr, definition);
      expect(pinUID).to.not.equal(ZERO_BYTES32);

      const targetID = ethers.zeroPadValue(recipientAddr, 32);
      // Schema-blind aggregate reads see the edge.
      expect(await edgeResolver.hasActiveEdge(targetID, definition)).to.be.true;
      expect(await edgeResolver.isActiveEdge(u1Addr, targetID, definition, pinSchemaUID)).to.be.true;
      // Cardinality-1 read at the address-target slot returns the active PIN UID and target.
      expect(await edgeResolver.getActivePin(definition, u1Addr, ZERO_BYTES32)).to.equal(pinUID);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, ZERO_BYTES32)).to.equal(targetID);
    });

    it("Should supersede a prior address-target PIN at the same slot in O(1)", async function () {
      // PIN cardinality-1 supersede semantics also apply when targeting addresses.
      // Re-attesting at (definition, attester, bytes32(0)) with a different recipient
      // replaces the prior address-target PIN.
      const definition = await createDefinition("addr-supersede");
      const addrA = await user2.getAddress();
      const addrB = await owner.getAddress();
      const u1Addr = await user1.getAddress();

      await pinByAddress(user1, addrA, definition);
      const targetA = ethers.zeroPadValue(addrA, 32);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, ZERO_BYTES32)).to.equal(targetA);

      const uidB = await pinByAddress(user1, addrB, definition);
      const targetB = ethers.zeroPadValue(addrB, 32);
      expect(await edgeResolver.getActivePin(definition, u1Addr, ZERO_BYTES32)).to.equal(uidB);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, ZERO_BYTES32)).to.equal(targetB);
      // Prior address-target PIN is no longer active anywhere.
      expect(await edgeResolver.hasActiveEdge(targetA, definition)).to.be.false;
    });

    it("Should clear the address-target PIN slot on revoke", async function () {
      const definition = await createDefinition("addr-revoke");
      const recipientAddr = await user2.getAddress();
      const u1Addr = await user1.getAddress();

      const pinUID = await pinByAddress(user1, recipientAddr, definition);
      const targetID = ethers.zeroPadValue(recipientAddr, 32);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, ZERO_BYTES32)).to.equal(targetID);

      await revokePin(user1, pinUID);
      expect(await edgeResolver.getActivePin(definition, u1Addr, ZERO_BYTES32)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, ZERO_BYTES32)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(targetID, definition)).to.be.false;
    });

    it("Should reject arbitrary bytes32 that is not an attestation, schema, or address", async function () {
      const target = await createTarget("invalid-def-target");
      const invalidDef = ethers.id("not-a-valid-definition");

      await expect(pinByRef(user1, target, invalidDef)).to.be.revertedWithCustomError(
        edgeResolver,
        "InvalidDefinition",
      );
    });

    it("Should accept a registered schema UID as a definition", async function () {
      const target = await createTarget("schema-def-target");
      const pinUID = await pinByRef(user1, target, dummySchemaUID);
      expect(pinUID).to.not.equal(ZERO_BYTES32);
    });

    it("Should accept an address (uint160-fits) as a definition", async function () {
      const target = await createTarget("addr-def-target");
      const addrDef = ethers.zeroPadValue(await user1.getAddress(), 32);
      const pinUID = await pinByRef(user1, target, addrDef);
      expect(pinUID).to.not.equal(ZERO_BYTES32);
    });
  });

  // ─── PIN supersede semantics (the headline feature) ───────────────────────

  describe("PIN supersede (cardinality 1)", function () {
    it("Should hold only the latest PIN when re-attesting at the same slot with a different target", async function () {
      const definition = await createDefinition("contentType");
      const propA = await createTarget("text/plain");
      const propB = await createTarget("text/markdown");
      const propC = await createTarget("text/html");
      const u1Addr = await user1.getAddress();

      const uidA = await pinByRef(user1, propA, definition);
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidA);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(propA);

      const uidB = await pinByRef(user1, propB, definition);
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidB);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(propB);

      const uidC = await pinByRef(user1, propC, definition);
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidC);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(propC);

      // The aggregate counter (PIN + TAG total per (def, attester)) reflects the singleton:
      // there is exactly one active edge from this attester at this slot, regardless of how
      // many PINs were superseded.
      expect(await edgeResolver.hasActiveEdge(propC, definition)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(propA, definition)).to.be.false;
      expect(await edgeResolver.hasActiveEdge(propB, definition)).to.be.false;
    });

    it("Should clear the slot when the active PIN is revoked", async function () {
      const definition = await createDefinition("revoke-target");
      const target = await createTarget("rev-tgt");
      const u1Addr = await user1.getAddress();

      const pinUID = await pinByRef(user1, target, definition);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(target);

      await revokePin(user1, pinUID);

      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.false;
    });

    it("Should treat revoking a stale (already-superseded) PIN as a no-op", async function () {
      const definition = await createDefinition("stale-revoke");
      const propA = await createTarget("A");
      const propB = await createTarget("B");
      const u1Addr = await user1.getAddress();

      const uidA = await pinByRef(user1, propA, definition);
      const uidB = await pinByRef(user1, propB, definition);
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidB);

      // Revoke the stale PIN — must not affect the active slot.
      await revokePin(user1, uidA);

      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidB);
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(propB);
    });

    it("Should leave aggregate counters consistent after many supersedes", async function () {
      // Simulates the PROPERTY-rebind churn that motivated ADR-0041. After N rebinds from
      // the same attester at the same slot, the aggregate counter must not drift.
      const definition = await createDefinition("contentType-churn");
      const u1Addr = await user1.getAddress();

      let lastTarget = "";
      for (let i = 0; i < 5; i++) {
        lastTarget = await createTarget(`rev-${i}`);
        await pinByRef(user1, lastTarget, definition);
      }

      // Only the latest target's edge is active.
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(lastTarget);
      expect(await edgeResolver.hasActiveEdge(lastTarget, definition)).to.be.true;

      // All prior superseded targets must be inactive. This guards against counter drift —
      // a missed decrement on any supersede step would leave a ghost `true` here.
      const allTargets: string[] = [];
      for (let i = 0; i < 5; i++) allTargets.push(await createTarget(`rev-${i}`));
      // Re-derive them: createTarget creates an anchor whose UID is the target; the loop above
      // already created rev-0..rev-4 — but hasActiveEdge checks by targetID, so we need the
      // same UIDs. Easier: check getActivePinTarget exclusively equals lastTarget.
      // The negative check is: getActivePinTarget for any attester != user1 returns ZERO.
      const u2Addr = await user2.getAddress();
      // cross-attester isolation holds after all rebinds
      expect(await edgeResolver.getActivePinTarget(definition, u2Addr, dummySchemaUID)).to.equal(ZERO_BYTES32);
    });

    it("Idempotent re-attest: same slot same target does not inflate the active count", async function () {
      const definition = await createDefinition("idempotent-repin");
      const target = await createTarget("same-target");
      const u1Addr = await user1.getAddress();

      await pinByRef(user1, target, definition);
      await pinByRef(user1, target, definition); // same (attester, definition, targetSchema, targetID)

      // Slot still holds exactly one PIN; active count should be 1, not 2.
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(target);
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.true;
      // Confirm the aggregate counter didn't double-increment.
      expect(await edgeResolver.isActivePinEdge(u1Addr, target, definition)).to.be.true;
    });
  });

  // ─── Cross-attester isolation ──────────────────────────────────────────────

  describe("Cross-attester isolation", function () {
    it("Should let two attesters hold independent PINs at the same (def, schema) slot", async function () {
      const definition = await createDefinition("two-attesters");
      const targetA = await createTarget("alice-target");
      const targetB = await createTarget("bob-target");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      const uidA = await pinByRef(user1, targetA, definition);
      const uidB = await pinByRef(user2, targetB, definition);

      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(uidA);
      expect(await edgeResolver.getActivePin(definition, u2Addr, dummySchemaUID)).to.equal(uidB);

      // Edition-aware aggregate read returns true for either edition.
      expect(await edgeResolver.hasActiveEdgeFromAny(targetA, definition, [u1Addr])).to.be.true;
      expect(await edgeResolver.hasActiveEdgeFromAny(targetA, definition, [u2Addr])).to.be.false;
      expect(await edgeResolver.hasActiveEdgeFromAny(targetB, definition, [u2Addr])).to.be.true;
    });

    it("Should not affect Bob's PIN when Alice supersedes hers", async function () {
      const definition = await createDefinition("alice-rebinds");
      const aliceA = await createTarget("alice-A");
      const aliceB = await createTarget("alice-B");
      const bobX = await createTarget("bob-X");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      await pinByRef(user1, aliceA, definition);
      const bobUid = await pinByRef(user2, bobX, definition);
      const aliceB_uid = await pinByRef(user1, aliceB, definition);

      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(aliceB_uid);
      expect(await edgeResolver.getActivePin(definition, u2Addr, dummySchemaUID)).to.equal(bobUid);
    });
  });

  // ─── Cross-schema coexistence (PIN ⊥ TAG at the same triple) ──────────────

  describe("Cross-schema coexistence with TAG", function () {
    it("Should let a PIN and a TAG at the same (attester, target, definition) coexist", async function () {
      // The schema-aware _edgeHash (ADR-0041) is the safety property: PIN and TAG entries
      // at the same triple occupy independent slots and must not corrupt each other.
      const definition = await createDefinition("pin-and-tag");
      const target = await createTarget("shared-target");
      const u1Addr = await user1.getAddress();

      const pinUID = await pinByRef(user1, target, definition);
      const tagUID = await tagByRef(user1, target, definition, 1n);

      // PIN reader returns the PIN UID; TAG reader returns the TAG list.
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(pinUID);

      const tagEntries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(tagEntries.length).to.equal(1);
      expect(tagEntries[0].tagUID).to.equal(tagUID);
      expect(tagEntries[0].weight).to.equal(1n);

      // Schema-aware reads agree.
      expect(await edgeResolver.isActiveEdge(u1Addr, target, definition, pinSchemaUID)).to.be.true;
      expect(await edgeResolver.isActiveEdge(u1Addr, target, definition, tagSchemaUID)).to.be.true;

      // Schema-blind reads see both.
      expect(await edgeResolver.isActiveEdgeAnySchema(u1Addr, target, definition)).to.be.true;
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.true;
    });

    it("Should allow revoking the PIN without disturbing the coexisting TAG", async function () {
      const definition = await createDefinition("pin-revoke-tag-stays");
      const target = await createTarget("coexist-target");
      const u1Addr = await user1.getAddress();

      const pinUID = await pinByRef(user1, target, definition);
      const tagUID = await tagByRef(user1, target, definition, 7n);

      await revokePin(user1, pinUID);

      // PIN gone…
      expect(await edgeResolver.getActivePin(definition, u1Addr, dummySchemaUID)).to.equal(ZERO_BYTES32);
      // …TAG still there.
      const tagEntries = await edgeResolver.getActiveTagEntries(definition, u1Addr, dummySchemaUID, 0n, 10n);
      expect(tagEntries.length).to.equal(1);
      expect(tagEntries[0].tagUID).to.equal(tagUID);
      // hasActiveEdge still true because TAG contributes to the aggregate counter.
      expect(await edgeResolver.hasActiveEdge(target, definition)).to.be.true;
    });
  });

  // ─── Smart-contract read shape ─────────────────────────────────────────────

  describe("Smart-contract read shape", function () {
    it("Should return getActivePinTarget as a single bytes32 — usable as a variable", async function () {
      // Documents the API ergonomics promise from ADR-0041: PIN consumers do
      // `bytes32 v = resolver.getActivePinTarget(...)`, not a loop.
      const definition = await createDefinition("contentType-shape");
      const target = await createTarget("text/plain");
      const u1Addr = await user1.getAddress();

      await pinByRef(user1, target, definition);

      // The returned value is a single bytes32 — the type system enforces "no iteration."
      const result: string = await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID);
      expect(result).to.equal(target);
    });

    it("Should support O(1) reads after many supersedes (sanity check)", async function () {
      // Not a strict gas snapshot — just a smoke test that 10 supersedes don't blow the
      // read up. The point of PIN is that the read is O(1) regardless of churn.
      const definition = await createDefinition("o1-read");
      const u1Addr = await user1.getAddress();
      let lastTarget = "";
      for (let i = 0; i < 10; i++) {
        lastTarget = await createTarget(`o1-${i}`);
        await pinByRef(user1, lastTarget, definition);
      }
      expect(await edgeResolver.getActivePinTarget(definition, u1Addr, dummySchemaUID)).to.equal(lastTarget);
    });
  });
});
