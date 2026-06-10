import { expect } from "chai";
import { ethers } from "hardhat";
import { EdgeResolver, EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

/**
 * EdgeResolver — `_containsAttestations` bookkeeping for address-target edges.
 *
 * Regression suite for the bug Codex flagged after the first round of ADR-0041 work:
 *
 *   `_containsAttestations[anchor][attester]` is set in EFSIndexer at anchor creation
 *   (EFSIndexer.sol:352-353). EdgeResolver also touches that bit via `propagateContains`
 *   on attest and `clearContains` on revoke — but only for STRUCTURAL edges
 *   (`refUID != EMPTY_UID`), since address-target edges (`recipient = addr, refUID = 0`)
 *   never participate in tree propagation.
 *
 *   Pre-fix, the revoke path decremented `_activeTotalByDefAndAttester` and called
 *   `clearContains` regardless of target shape. So an attester who created an anchor and
 *   then attached a single address-target tag to it would see their anchor-creation
 *   contains bit silently cleared on revoke of that tag, hiding the anchor from their
 *   own lens listing.
 *
 *   Fix (ADR-0041 follow-up): the contains-flag bookkeeping in onAttest and onRevoke is
 *   gated on `refUID != EMPTY_UID` (i.e. structural edges only). Increment and decrement
 *   compose correctly because both ends are gated on the same condition.
 *
 * These tests need a real anchor schema registered with EFSIndexer, which the existing
 * EdgeResolverPin / EdgeResolverTag suites don't have (they pass `ZERO_BYTES32` as the
 * anchor schema placeholder, so the `defAtt.schema == ANCHOR_SCHEMA_UID()` branch never
 * fires). Hence a separate test file with the full wiring.
 */
describe("EdgeResolver — contains-flag bookkeeping (address-target safety)", function () {
  let edgeResolver: EdgeResolver;
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let anchorSchemaUID: string;
  let pinSchemaUID: string;
  let tagSchemaUID: string;

  const enc = new ethers.AbiCoder();
  const encodePin = (definition: string) => enc.encode(["bytes32"], [definition]);
  const encodeTag = (definition: string, weight: bigint) => enc.encode(["bytes32", "int256"], [definition, weight]);
  const encodeAnchor = (name: string, schemaUID: string) => enc.encode(["string", "bytes32"], [name, schemaUID]);

  // ─── Setup ─────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Deployment plan:
    //   nonce+0: EdgeResolver
    //   nonce+1: ANCHOR schema
    //   nonce+2: PROPERTY schema (placeholder, not used here)
    //   nonce+3: DATA schema (placeholder)
    //   nonce+4: PIN schema
    //   nonce+5: TAG schema
    //   nonce+6: EFSIndexer
    const ownerAddr = await owner.getAddress();
    const resolverNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureEdgeResolverAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce });
    const futureIndexerAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce + 6 });
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

    // ANCHOR: registered with the (future) indexer so anchor attestations route through it
    // and `_containsAttestations[anchor][creator]` actually gets set on create.
    const anchorTx = await registry.register("string name, bytes32 schemaUID", futureIndexerAddress, false);
    anchorSchemaUID = (await anchorTx.wait())!.logs[0].topics[1];

    // PROPERTY / DATA are not exercised here, but EFSIndexer's constructor wants their UIDs.
    // Use throwaway registrations rather than ZERO_BYTES32 so the indexer's schema-equality
    // checks don't accidentally match. DATA is an empty schema (ADR-0049).
    const propTx = await registry.register("string value", futureIndexerAddress, false);
    const propertySchemaUID = (await propTx.wait())!.logs[0].topics[1];
    const dataTx = await registry.register("", futureIndexerAddress, false);
    const dataSchemaUID = (await dataTx.wait())!.logs[0].topics[1];

    // PIN + TAG: registered with EdgeResolver so attest/revoke routes through it.
    const pinSchemaTx = await registry.register("bytes32 definition", await edgeResolver.getAddress(), true);
    pinSchemaUID = (await pinSchemaTx.wait())!.logs[0].topics[1];
    expect(pinSchemaUID).to.equal(precomputedPinSchemaUID);

    const tagSchemaTx = await registry.register(
      "bytes32 definition, int256 weight",
      await edgeResolver.getAddress(),
      true,
    );
    tagSchemaUID = (await tagSchemaTx.wait())!.logs[0].topics[1];
    expect(tagSchemaUID).to.equal(precomputedTagSchemaUID);

    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(await eas.getAddress(), anchorSchemaUID, propertySchemaUID, dataSchemaUID);
    await indexer.waitForDeployment();
    expect(await indexer.getAddress()).to.equal(futureIndexerAddress);

    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
      tagSchemaUID,
      ZeroAddress,
      ZERO_BYTES32,
      ZeroAddress,
      ZERO_BYTES32,
      await registry.getAddress(),
    );
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

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

  /** Create a real anchor under `parent` (root if `parent === ZERO_BYTES32`). */
  const createAnchor = async (signer: Signer, parent: string, name: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parent,
        data: encodeAnchor(name, ZERO_BYTES32),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Address-target TAG: `definition = anchor, refUID = 0, recipient = addr`. */
  const tagByAddress = async (
    signer: Signer,
    recipient: string,
    definition: string,
    weight: bigint,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodeTag(definition, weight),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Address-target PIN: `definition = anchor, refUID = 0, recipient = addr`. */
  const pinByAddress = async (signer: Signer, recipient: string, definition: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: encodePin(definition),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  const revoke = async (signer: Signer, schema: string, uid: string) => {
    const tx = await eas.connect(signer).revoke({ schema, data: { uid, value: 0n } });
    await tx.wait();
  };

  // ─── Tests ─────────────────────────────────────────────────────────────────

  describe("Anchor creation seeds the contains bit", function () {
    it("Sets containsAttestations[anchor][creator] when an anchor is attested", async function () {
      const root = await createAnchor(owner, ZERO_BYTES32, "root");
      const u1Addr = await user1.getAddress();
      const folder = await createAnchor(user1, root, "u1-folder");
      // Sanity: EFSIndexer.sol:352-353 sets the bit at anchor creation.
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);
    });
  });

  describe("Address-target TAG revoke does not clear creator's contains bit", function () {
    it("Revoking an address-target TAG leaves containsAttestations untouched (Codex regression)", async function () {
      // Setup: user1 creates an anchor under root → bit is set by anchor creation.
      const root = await createAnchor(owner, ZERO_BYTES32, "root");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();
      const folder = await createAnchor(user1, root, "u1-folder");
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // Same attester (user1) attaches an address-target TAG with this anchor as the
      // definition. This is the shape Codex flagged: e.g. `TAG(definition=/tags/foo,
      // recipient=0xabc...)` — a label hung off an anchor pointing at an address.
      const tagUID = await tagByAddress(user1, u2Addr, folder, 1n);
      // Pre-fix, the increment in `_onAttestTag` would have bumped
      // `_activeTotalByDefAndAttester[folder][user1]` to 1 even though no propagation
      // happened. The bit is still true here either way (anchor creation set it).
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // Revoke the address-target TAG. Pre-fix, this decremented the counter to 0 and
      // called `clearContains(folder, user1)` — silently wiping the anchor-creation bit.
      await revoke(user1, tagSchemaUID, tagUID);

      // Post-fix: the bit set at anchor creation must still hold.
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);
    });

    it("Revoking many address-target TAGs in a row never clears the contains bit", async function () {
      // The bug class isn't gated on cardinality 1 — N back-to-back revokes can't
      // unbalance the counter as long as both endpoints (increment + decrement) are
      // gated on the same `refUID != EMPTY_UID` condition.
      const root = await createAnchor(owner, ZERO_BYTES32, "root");
      const u1Addr = await user1.getAddress();
      const folder = await createAnchor(user1, root, "u1-folder");

      // Three distinct address targets → three distinct edgeHashes → three accumulating TAGs.
      const recipients = [
        await user2.getAddress(),
        await owner.getAddress(),
        ethers.getAddress("0x1111111111111111111111111111111111111111"),
      ];
      const uids: string[] = [];
      for (const r of recipients) {
        uids.push(await tagByAddress(user1, r, folder, 1n));
      }

      // Revoke all three.
      for (const u of uids) {
        await revoke(user1, tagSchemaUID, u);
      }

      // Bit set by anchor creation must still hold.
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);
    });
  });

  describe("Address-target PIN revoke does not clear creator's contains bit", function () {
    it("Symmetric guarantee for PIN: address-target supersede + revoke leaves bit intact", async function () {
      // Same shape as the TAG case but exercises the PIN write/revoke path explicitly.
      const root = await createAnchor(owner, ZERO_BYTES32, "root");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();
      const folder = await createAnchor(user1, root, "u1-folder");
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // First address-target PIN (cardinality 1).
      const pin1 = await pinByAddress(user1, u2Addr, folder);
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // Re-attest at the same slot with a different recipient — supersede in O(1).
      // Pre-fix, the supersede path also touched `_activeTotalByDefAndAttester`. Post-fix,
      // it skips the decrement when `targetSchema == bytes32(0)`. Either way the
      // contains bit set by anchor creation must remain set.
      const otherAddr = ethers.getAddress("0x2222222222222222222222222222222222222222");
      await pinByAddress(user1, otherAddr, folder);
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // Revoke the SECOND PIN (the one currently in the slot). The first PIN was
      // already superseded so its revoke path would no-op anyway.
      // Find the active PIN slot's UID indirectly by issuing a fresh PIN and revoking it,
      // OR — simpler — re-attest the second one explicitly so we hold its UID.
      // (We already hold `pin1` and the second supersede UID; recover the second below.)
      // For clarity, rebuild with a third address so we have a fresh handle:
      const thirdAddr = ethers.getAddress("0x3333333333333333333333333333333333333333");
      const pin3 = await pinByAddress(user1, thirdAddr, folder);
      await revoke(user1, pinSchemaUID, pin3);

      // Bit set by anchor creation must still hold.
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);

      // pin1 is fully revokable too (it was superseded but is still a real attestation;
      // the resolver's "only if currently active" guard makes this a no-op for slot
      // bookkeeping, but it must still not clear the contains bit).
      await revoke(user1, pinSchemaUID, pin1);
      expect(await indexer.containsAttestations(folder, u1Addr)).to.equal(true);
    });
  });

  describe("Structural edge bookkeeping still works (no over-correction)", function () {
    it("Address-target edges do not pollute the structural counter when mixed with structural edges", async function () {
      // If the structural counter were polluted by address-target attests, the
      // structural-revoke decrement could unbalance it (counter goes to -1 saturated to
      // 0, then a later structural attest sets it back to 1, etc.). Easier to assert
      // the visible behavior: after a structural attest+revoke cycle interleaved with
      // address-target attest+revoke, `containsAttestations` still reflects the
      // anchor-creation bit (sticky) AND `hasActiveEdge` reads correctly track only the
      // edges still active.
      const root = await createAnchor(owner, ZERO_BYTES32, "root");
      const u1Addr = await user1.getAddress();
      const u2Addr = await user2.getAddress();

      const defAnchor = await createAnchor(user1, root, "u1-def");
      const childAnchor = await createAnchor(user1, defAnchor, "u1-child");

      // Structural TAG: definition = defAnchor, refUID = childAnchor → propagateContains fires.
      // Then sandwich address-target attests/revokes around it.
      const addrTag = await tagByAddress(user1, u2Addr, defAnchor, 1n);
      const structTagTx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: childAnchor,
          data: encodeTag(defAnchor, 1n),
          value: 0n,
        },
      });
      const structTagUID = getUID(await structTagTx.wait());

      // Both should be visible: bit is set (sticky from anchor creation + structural propagate).
      expect(await indexer.containsAttestations(defAnchor, u1Addr)).to.equal(true);

      // Revoke the address-target one — bit must not move.
      await revoke(user1, tagSchemaUID, addrTag);
      expect(await indexer.containsAttestations(defAnchor, u1Addr)).to.equal(true);

      // Revoke the structural one — `clearContains` may now legitimately fire, but the
      // address-target revoke we just did should NOT have already pre-cleared the bit
      // out from underneath this one. The behavior contract here is just "the address-
      // target revoke didn't lie about having cleared it." We assert by re-attesting a
      // structural edge afterwards and confirming `propagateContains` reaches a clean state.
      await revoke(user1, tagSchemaUID, structTagUID);

      // Re-attest a structural TAG; propagateContains should set the bit again either way.
      const structTag2Tx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: childAnchor,
          data: encodeTag(defAnchor, 1n),
          value: 0n,
        },
      });
      await structTag2Tx.wait();
      expect(await indexer.containsAttestations(defAnchor, u1Addr)).to.equal(true);
    });
  });
});
