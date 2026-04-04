import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

/**
 * Tests for EFSIndexer public index API:
 *   index()          — permissionless, idempotent, single attestation
 *   indexBatch()     — batch version
 *   indexRevocation() — sync revocation for externally-indexed UIDs
 *   isIndexed()      — discovery check
 *
 * These tests use a separate "thirdParty" schema (no resolver, not EFS-native)
 * to simulate what any external developer building on EAS would do.
 */

const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSIndexer — public index() API", function () {
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;

  // EFS schemas
  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let blobSchemaUID: string;

  // Third-party schema (no resolver — simulates external developer)
  let thirdPartySchemaUID: string;
  // A second third-party schema for multi-schema tests
  let thirdPartySchemaUID2: string;

  const enc = ethers.AbiCoder.defaultAbiCoder();

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("Attested event not found");
  };

  /** Attest with the third-party schema (no resolver) and return UID. */
  const attestThirdParty = async (
    signer: Signer,
    message: string,
    refUID = ZERO_BYTES32,
    recipient = ZeroAddress,
    schema = thirdPartySchemaUID,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema,
      data: {
        recipient,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID,
        data: enc.encode(["string"], [message]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();

    // Deploy SchemaRegistry + EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce-predict EFSIndexer address
    const ownerAddr = await owner.getAddress();
    const baseNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: baseNonce + 4 });

    // Register EFS schemas
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false);
    anchorSchemaUID = (await tx1.wait())!.logs[0].topics[1];
    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    propertySchemaUID = (await tx2.wait())!.logs[0].topics[1];
    const tx3 = await registry.register("string uri, string contentType, string fileMode", futureIndexerAddr, true);
    dataSchemaUID = (await tx3.wait())!.logs[0].topics[1];
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    blobSchemaUID = (await tx4.wait())!.logs[0].topics[1];

    // Deploy EFSIndexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
    );
    await indexer.waitForDeployment();
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Register two third-party schemas (no resolver, revocable)
    const tp1 = await registry.register("string message", ZeroAddress, true);
    thirdPartySchemaUID = (await tp1.wait())!.logs[0].topics[1];
    const tp2 = await registry.register("uint256 value, address target", ZeroAddress, true);
    thirdPartySchemaUID2 = (await tp2.wait())!.logs[0].topics[1];
  });

  // ============================================================================================
  // index() — basic behaviour
  // ============================================================================================

  describe("index()", function () {
    it("returns true on first index", async function () {
      const uid = await attestThirdParty(alice, "hello");
      expect(await indexer.index.staticCall(uid)).to.be.true;
      await indexer.index(uid);
    });

    it("returns false on re-index (idempotent)", async function () {
      const uid = await attestThirdParty(alice, "hello");
      await indexer.index(uid);
      expect(await indexer.index.staticCall(uid)).to.be.false;
    });

    it("isIndexed returns false before and true after", async function () {
      const uid = await attestThirdParty(alice, "hello");
      expect(await indexer.isIndexed(uid)).to.be.false;
      await indexer.index(uid);
      expect(await indexer.isIndexed(uid)).to.be.true;
    });

    it("emits AttestationIndexed event", async function () {
      const aliceAddr = await alice.getAddress();
      const uid = await attestThirdParty(alice, "hello");
      await expect(indexer.index(uid))
        .to.emit(indexer, "AttestationIndexed")
        .withArgs(uid, thirdPartySchemaUID, aliceAddr);
    });

    it("no event on re-index", async function () {
      const uid = await attestThirdParty(alice, "hello");
      await indexer.index(uid);
      // Second call should not emit
      const tx = await indexer.index(uid);
      const receipt = await tx.wait();
      const events = receipt!.logs.filter((log: any) => {
        try {
          return indexer.interface.parseLog(log)?.name === "AttestationIndexed";
        } catch {
          return false;
        }
      });
      expect(events.length).to.equal(0);
    });

    it("reverts on non-existent attestation", async function () {
      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      await expect(indexer.index(fakeUID)).to.be.revertedWithCustomError(indexer, "InvalidAttestation");
    });

    it("silently skips EFS-native ANCHOR schema (returns false, no revert)", async function () {
      // Create a root anchor via EAS (it goes through onAttest and is already indexed)
      const tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await tx.wait());
      // index() on an EFS-native UID returns false and does not revert
      expect(await indexer.index.staticCall(rootUID)).to.be.false;
      await indexer.index(rootUID); // no revert
    });

    it("silently skips EFS DATA schema", async function () {
      // Create a root anchor first
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const fileTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: rootUID,
          data: enc.encode(["string", "bytes32"], ["file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileAnchorUID = getUID(await fileTx.wait());
      const dataTx = await eas.connect(alice).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileAnchorUID,
          data: enc.encode(["string", "string", "string"], ["ipfs://foo", "text/plain", "file"]),
          value: 0n,
        },
      });
      const dataUID = getUID(await dataTx.wait());
      expect(await indexer.index.staticCall(dataUID)).to.be.false;
    });
  });

  // ============================================================================================
  // index() — discovery indices populated correctly
  // ============================================================================================

  describe("index() — discovery indices", function () {
    it("populates getAttestationsBySchema", async function () {
      const uid = await attestThirdParty(alice, "hello");
      await indexer.index(uid);
      const results = await indexer.getAttestationsBySchema(thirdPartySchemaUID, 0, 10, false);
      expect(results).to.include(uid);
    });

    it("populates getOutgoingAttestations (sent by attester)", async function () {
      const aliceAddr = await alice.getAddress();
      const uid = await attestThirdParty(alice, "hello");
      await indexer.index(uid);
      const sent = await indexer.getOutgoingAttestations(aliceAddr, thirdPartySchemaUID, 0, 10, false);
      expect(sent).to.include(uid);
    });

    it("populates getAttestationsBySchemaAndAttester", async function () {
      const aliceAddr = await alice.getAddress();
      const uid = await attestThirdParty(alice, "hello");
      await indexer.index(uid);
      const results = await indexer.getAttestationsBySchemaAndAttester(thirdPartySchemaUID, aliceAddr, 0, 10, false);
      expect(results).to.include(uid);
    });

    it("populates getIncomingAttestations when recipient is set", async function () {
      const bobAddr = await bob.getAddress();
      const uid = await attestThirdParty(alice, "hello", ZERO_BYTES32, bobAddr);
      await indexer.index(uid);
      const received = await indexer.getIncomingAttestations(bobAddr, thirdPartySchemaUID, 0, 10, false);
      expect(received).to.include(uid);
    });

    it("populates getReferencingAttestations when refUID is set", async function () {
      // Create an anchor to reference
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());

      // Third-party attestation referencing the anchor
      const uid = await attestThirdParty(alice, "linked", rootUID);
      await indexer.index(uid);

      const refs = await indexer.getReferencingAttestations(rootUID, thirdPartySchemaUID, 0, 10, false);
      expect(refs).to.include(uid);
    });

    it("populates getReferencingSchemas for the target", async function () {
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const uid = await attestThirdParty(alice, "linked", rootUID);
      await indexer.index(uid);

      const schemas = await indexer.getReferencingSchemas(rootUID);
      expect(schemas).to.include(thirdPartySchemaUID);
    });

    it("populates getAllReferencing and getReferencingByAttester", async function () {
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const aliceAddr = await alice.getAddress();

      const uid = await attestThirdParty(alice, "linked", rootUID);
      await indexer.index(uid);

      const all = await indexer.getAllReferencing(rootUID, 0, 10, false);
      expect(all).to.include(uid);

      const byAttester = await indexer.getReferencingByAttester(rootUID, aliceAddr, 0, 10, false);
      expect(byAttester).to.include(uid);
    });

    it("containsAttestations returns true after index with refUID", async function () {
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const aliceAddr = await alice.getAddress();

      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.be.false;
      const uid = await attestThirdParty(alice, "linked", rootUID);
      await indexer.index(uid);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.be.true;
    });

    it("does not double-index: counts stay stable on re-index", async function () {
      const uid = await attestThirdParty(alice, "once");
      await indexer.index(uid);
      await indexer.index(uid); // second call — should be no-op

      const count = await indexer.getAttestationCountBySchema(thirdPartySchemaUID);
      expect(count).to.equal(1n);
    });
  });

  // ============================================================================================
  // indexBatch()
  // ============================================================================================

  describe("indexBatch()", function () {
    it("indexes multiple UIDs and returns correct count", async function () {
      const uid1 = await attestThirdParty(alice, "msg1");
      const uid2 = await attestThirdParty(bob, "msg2");
      const uid3 = await attestThirdParty(alice, "msg3");

      const count = await indexer.indexBatch.staticCall([uid1, uid2, uid3]);
      expect(count).to.equal(3n);

      await indexer.indexBatch([uid1, uid2, uid3]);

      const all = await indexer.getAttestationsBySchema(thirdPartySchemaUID, 0, 10, false);
      expect(all).to.include(uid1);
      expect(all).to.include(uid2);
      expect(all).to.include(uid3);
    });

    it("skips already-indexed UIDs in count", async function () {
      const uid1 = await attestThirdParty(alice, "msg1");
      const uid2 = await attestThirdParty(alice, "msg2");
      await indexer.index(uid1); // pre-index uid1

      const count = await indexer.indexBatch.staticCall([uid1, uid2]);
      expect(count).to.equal(1n); // only uid2 is new
    });

    it("handles mixed EFS-native and third-party UIDs gracefully", async function () {
      // Create an EFS anchor (will go through onAttest)
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const uid = await attestThirdParty(alice, "third-party");

      // rootUID is EFS-native (skipped), uid is third-party (indexed) — no revert
      const count = await indexer.indexBatch.staticCall([rootUID, uid]);
      expect(count).to.equal(1n);
    });

    it("reverts on non-existent UID in batch", async function () {
      const uid = await attestThirdParty(alice, "real");
      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("fake"));
      await expect(indexer.indexBatch([uid, fakeUID])).to.be.revertedWithCustomError(indexer, "InvalidAttestation");
    });

    it("emits AttestationIndexed for each newly indexed UID", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const uid1 = await attestThirdParty(alice, "msg1");
      const uid2 = await attestThirdParty(bob, "msg2");

      const tx = await indexer.indexBatch([uid1, uid2]);
      await expect(tx).to.emit(indexer, "AttestationIndexed").withArgs(uid1, thirdPartySchemaUID, aliceAddr);
      await expect(tx).to.emit(indexer, "AttestationIndexed").withArgs(uid2, thirdPartySchemaUID, bobAddr);
    });
  });

  // ============================================================================================
  // indexRevocation()
  // ============================================================================================

  describe("indexRevocation()", function () {
    it("syncs revocation into isRevoked", async function () {
      const uid = await attestThirdParty(alice, "will be revoked");
      await indexer.index(uid);

      expect(await indexer.isRevoked(uid)).to.be.false;

      await eas.connect(alice).revoke({ schema: thirdPartySchemaUID, data: { uid, value: 0n } });
      await indexer.indexRevocation(uid);

      expect(await indexer.isRevoked(uid)).to.be.true;
    });

    it("emits RevocationIndexed event", async function () {
      const uid = await attestThirdParty(alice, "will be revoked");
      await indexer.index(uid);
      await eas.connect(alice).revoke({ schema: thirdPartySchemaUID, data: { uid, value: 0n } });

      await expect(indexer.indexRevocation(uid)).to.emit(indexer, "RevocationIndexed").withArgs(uid);
    });

    it("is idempotent — second call emits no event", async function () {
      const uid = await attestThirdParty(alice, "will be revoked");
      await indexer.index(uid);
      await eas.connect(alice).revoke({ schema: thirdPartySchemaUID, data: { uid, value: 0n } });
      await indexer.indexRevocation(uid);

      // Second call — should not emit
      const tx = await indexer.indexRevocation(uid);
      const receipt = await tx.wait();
      const events = receipt!.logs.filter((log: any) => {
        try {
          return indexer.interface.parseLog(log)?.name === "RevocationIndexed";
        } catch {
          return false;
        }
      });
      expect(events.length).to.equal(0);
    });

    it("reverts if attestation not revoked in EAS", async function () {
      const uid = await attestThirdParty(alice, "not revoked");
      await indexer.index(uid);
      await expect(indexer.indexRevocation(uid)).to.be.revertedWith("EFSIndexer: not revoked in EAS");
    });

    it("reverts on non-existent attestation", async function () {
      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      await expect(indexer.indexRevocation(fakeUID)).to.be.revertedWithCustomError(indexer, "InvalidAttestation");
    });

    it("works for EFS-native schema (DATA) revocations too", async function () {
      // Create root + file anchor + data
      const rootTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const rootUID = getUID(await rootTx.wait());
      const fileTx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: rootUID,
          data: enc.encode(["string", "bytes32"], ["file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileAnchorUID = getUID(await fileTx.wait());
      const dataTx = await eas.connect(alice).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileAnchorUID,
          data: enc.encode(["string", "string", "string"], ["ipfs://foo", "text/plain", "file"]),
          value: 0n,
        },
      });
      const dataUID = getUID(await dataTx.wait());

      // EFS onRevoke already handles this — but indexRevocation should also work without double-effect
      await eas.connect(alice).revoke({ schema: dataSchemaUID, data: { uid: dataUID, value: 0n } });
      // Already revoked by onRevoke hook; indexRevocation should be idempotent
      await indexer.indexRevocation(dataUID);
      expect(await indexer.isRevoked(dataUID)).to.be.true;
    });
  });

  // ============================================================================================
  // Multi-schema and cross-schema tests
  // ============================================================================================

  describe("multi-schema behaviour", function () {
    it("attestations from different schemas are indexed into separate buckets", async function () {
      const uid1 = await attestThirdParty(alice, "schema1", ZERO_BYTES32, ZeroAddress, thirdPartySchemaUID);
      const uid2Tx = await eas.connect(alice).attest({
        schema: thirdPartySchemaUID2,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: enc.encode(["uint256", "address"], [42n, ZeroAddress]),
          value: 0n,
        },
      });
      const uid2 = getUID(await uid2Tx.wait());

      await indexer.indexBatch([uid1, uid2]);

      const schema1Results = await indexer.getAttestationsBySchema(thirdPartySchemaUID, 0, 10, false);
      const schema2Results = await indexer.getAttestationsBySchema(thirdPartySchemaUID2, 0, 10, false);

      expect(schema1Results).to.include(uid1);
      expect(schema1Results).to.not.include(uid2);
      expect(schema2Results).to.include(uid2);
      expect(schema2Results).to.not.include(uid1);
    });

    it("getAttestationCountBySchema reflects indexed count correctly", async function () {
      const uid1 = await attestThirdParty(alice, "a");
      const uid2 = await attestThirdParty(bob, "b");
      const uid3 = await attestThirdParty(alice, "c");

      expect(await indexer.getAttestationCountBySchema(thirdPartySchemaUID)).to.equal(0n);
      await indexer.indexBatch([uid1, uid2, uid3]);
      expect(await indexer.getAttestationCountBySchema(thirdPartySchemaUID)).to.equal(3n);
    });
  });
});
