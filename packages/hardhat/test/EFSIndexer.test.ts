import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

// Constants
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSIndexer", function () {
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let anchorSchemaUID: string;
  let propertySchemaUID: string;
  let dataSchemaUID: string;
  let blobSchemaUID: string;
  let tagSchemaUID: string;
  // let likeSchemaUID: string; // For generic indexing tests (Unused)
  // let commentSchemaUID: string; // For generic indexing tests (Unused)

  before(async function () {
    [owner, user1, user2] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // 1. Deploy SchemaRegistry and EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Determine future address of Indexer to register schemas with it first.
    // This resolves the circular dependency where schemas need a resolver address,
    // but the resolver (Indexer) needs schema UIDs in its constructor.

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    // Calculate the future address of the Indexer using the owner's nonce.
    // The Indexer is deployed after SchemaRegistry registration transactions.
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 7 }); // Adjusted nonce for new schemas

    // Register Schemas with the future resolver address
    // ANCHOR: string name, bytes32 schemaUID
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, true);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1]; // Registered(bytes32 uid, ...)

    // PROPERTY: string key, string value
    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    const rc2 = await tx2.wait();
    propertySchemaUID = rc2!.logs[0].topics[1];

    // DATA: string uri, string contentType, string fileMode (matches EFSRouter schema)
    const tx3 = await registry.register("string uri, string contentType, string fileMode", futureIndexerAddr, true);
    const rc3 = await tx3.wait();
    dataSchemaUID = rc3!.logs[0].topics[1];

    // BLOB: string mimeType, uint8 storageType, bytes location
    // Register BLOB schema with no resolver (resolver = ZeroAddress) as it holds raw data.
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true); // No resolver
    const rc4 = await tx4.wait();
    blobSchemaUID = rc4!.logs[0].topics[1];

    // TAG: bytes32 labelUID, int256 weight (Changed from bool isNegative)
    const tx5 = await registry.register("bytes32 labelUID, int256 weight", futureIndexerAddr, true);
    const rc5 = await tx5.wait();
    tagSchemaUID = rc5!.logs[0].topics[1];

    // LIKE: bytes32 targetUID
    const tx6 = await registry.register("bytes32 targetUID", futureIndexerAddr, true);
    await tx6.wait();
    // likeSchemaUID = rc6!.logs[0].topics[1];

    // COMMENT: bytes32 targetUID, string comment
    const tx7 = await registry.register("bytes32 targetUID, string comment", futureIndexerAddr, true);
    await tx7.wait();
    // commentSchemaUID = rc7!.logs[0].topics[1];

    // 3. Deploy Indexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
      tagSchemaUID,
    );
    await indexer.waitForDeployment();

    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);
  });

  const getUIDFromReceipt = (receipt: any) => {
    const easInterface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = easInterface.parseLog(log);
        if (parsed && parsed.name === "Attested") {
          return parsed.args.uid;
        }
      } catch {
        // ignore
      }
    }
    throw new Error("Attested event not found");
  };

  describe("Enforcement (Anchor)", function () {
    // ... (Existing tests) ...

    it("should allow creating a root anchor (First Anchor)", async function () {
      // ... (Existing logic) ...
      const schemaEncoder = new ethers.AbiCoder();
      const data = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: data,
          value: 0n,
        },
      });
      const receipt = await tx.wait();

      // Verify Indexer State
      // Note: TypeScript might not see 'rootAnchorUID' yet if typechain isn't recompiled
      // We cast to any to bypass valid compile error until recompile happens
      const rootUID = await (indexer as any).rootAnchorUID();
      const attestedUID = getUIDFromReceipt(receipt);
      expect(rootUID).to.equal(attestedUID);
    });

    it("Should fail if creating second root anchor", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // 1. Create First Root (Should Succeed)
      const data1 = schemaEncoder.encode(["string", "bytes32"], ["root1", ZERO_BYTES32]);
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: data1,
          value: 0n,
        },
      });

      // 2. Try to create Second Root (Should ensure parentUID is checked properly)
      // Note: New logic allows multiple roots if they have internal validation? NO.
      // Logic: if rootAnchorUID != 0, and parent == 0, and uid != rootAnchorUID -> MissingParent.
      // So this test should still pass (revert).

      const data2 = schemaEncoder.encode(["string", "bytes32"], ["root2", ZERO_BYTES32]);
      await expect(
        eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: data2,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(indexer, "MissingParent");
    });

    it("should Revert when creating duplicate filename in same directory", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // 1. Create Root
      const rootData = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
      const rootTx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: rootData,
          value: 0n,
        },
      });
      const rootReceipt = await rootTx.wait();
      const rootUID = getUIDFromReceipt(rootReceipt);

      // 2. Create "config.json" in Root (Generic Anchor)
      const data = schemaEncoder.encode(["string", "bytes32"], ["config.json", ZERO_BYTES32]);
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: rootUID,
          data: data,
          value: 0n,
        },
      });

      // 3. Attempt Duplicate "config.json" in Root
      await expect(
        eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID,
            data: data,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(indexer, "DuplicateFileName");
    });
  });

  describe("Enforcement (Relationships)", function () {
    it("Should fail to attach DATA to a non-Anchor (e.g. Root)", async function () {
      // Try attaching DATA to ZeroHash (not an Anchor)
      const schemaEncoder = new ethers.AbiCoder();
      // Expect EAS to revert with InvalidAttestation() because indexer returns false
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32, // Invalid Ref
            data: schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("Should rejection DATA attached to invalid UID", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("Should reject PROPERTY attached to non-Anchor", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      await expect(
        eas.attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string"], ["val"]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });
  });

  describe("Path Resolution", function () {
    it("Should resolve root paths", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["test_file", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const uid = await getUIDFromReceipt(receipt);

      expect(await indexer.resolvePath(ZERO_BYTES32, "test_file")).to.equal(uid);
    });

    it("should resolve nested paths", async function () {
      const schemaEncoder = new ethers.AbiCoder();

      // /home
      const tx1 = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["home", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt1 = await tx1.wait();
      // We need the UID. In tests we can compute it or get from event.
      // EAS emits Attested(bytes32 indexed uid, ...)
      // But `attest` function returns transaction.
      // Hardhat-EAS helpers usually return UID string but I'm calling raw contract.
      // Let's parse logs.
      const homeUID = getUIDFromReceipt(receipt1); // Attested event
      // Better: compute UID vs fetch from indexer resolvePath.
      // Here we use indexer to resolve the path and verify it matches the latest attestation.
      const resolvedHome = await indexer.resolvePath(ZERO_BYTES32, "home");
      expect(resolvedHome).to.equal(homeUID);

      // /home/user
      const tx2 = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: homeUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user", ZERO_BYTES32]),
          value: 0n,
        },
      });
      await tx2.wait();
      // Verify that the retrieved UID matches the one from resolution logic
      // Note: EAS `attest` call returns a receipt, but parsing logs depends on which contract emitted events.
      // We use getUIDFromReceipt to extract the UID from the EAS 'Attested' event.

      const userUID = await indexer.resolvePath(homeUID, "user");
      expect(userUID).to.not.equal(ZERO_BYTES32);

      // /home/user/docs
      await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: userUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["docs", ZERO_BYTES32]),
          value: 0n,
        },
      });

      const docsUID = await indexer.resolvePath(userUID, "docs");
      expect(docsUID).to.not.equal(ZERO_BYTES32);
    });
  });

  describe("Hierarchy & Pagination", function () {
    let parentUID: string;
    let child1UID: string;
    let child2UID: string;
    let child3UID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // Create Parent
      const txParent = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["parent", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // Create 3 children
      const createChild = async (name: string) => {
        const tx = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receipt = await tx.wait();
        return getUIDFromReceipt(receipt);
      };

      child1UID = await createChild("child1");
      child2UID = await createChild("child2");
      child3UID = await createChild("child3");
    });

    it("Should paginate children (Forward)", async function () {
      // Updated signature: getChildren(uid, start, length, reverse)
      const page1 = await indexer.getChildren(parentUID, 0, 2, false);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(child1UID);
      expect(page1[1]).to.equal(child2UID);

      const page2 = await indexer.getChildren(parentUID, 2, 2, false);
      expect(page2.length).to.equal(1);
      expect(page2[0]).to.equal(child3UID);

      const count = await indexer.getChildrenCount(parentUID);
      expect(count).to.equal(3);
    });

    it("Should paginate children (Reverse)", async function () {
      // Updated signature: getChildren(uid, start, length, reverse)
      // Reverse: start 0 means "latest"
      const page1 = await indexer.getChildren(parentUID, 0, 2, true);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(child3UID); // Last added is first
      expect(page1[1]).to.equal(child2UID);
    });
  });

  describe("Filtering & MimeTypes", function () {
    let parentUID: string;
    // let dataUID: string;
    let userFileUID: string;
    let user2FileUID: string;
    let fileUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // 1. Create Parent "files"
      const txParent = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["files", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // 2. Create BLOB (video/mp4)
      const blobTx = await eas.attest({
        schema: blobSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "uint8", "bytes"], ["video/mp4", 0, "0x1234"]),
          value: 0n,
        },
      });
      await blobTx.wait();

      // 3. Create Anchor "my_video.mp4" inside "files"
      const txFile = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          // Create as Data Anchor!
          data: schemaEncoder.encode(["string", "bytes32"], ["my_video.mp4", dataSchemaUID]),
          value: 0n,
        },
      });
      const rcFile = await txFile.wait();
      fileUID = getUIDFromReceipt(rcFile);

      // 4. Attach DATA to "my_video.mp4"
      // DATA schema is `string uri, string contentType, string fileMode`
      const dataTx = await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID, // Points to the file Anchor
          data: schemaEncoder.encode(["string", "string", "string"], ["web3://", "video/mp4", "file"]),
          value: 0n,
        },
      });
      await dataTx.wait();

      // Setup for Attester Filter
      // User A creates file "user1.txt" in "files"
      const txUser1File = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user1.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptUser1File = await txUser1File.wait();
      userFileUID = getUIDFromReceipt(receiptUser1File);

      // User B creates file "user2.txt" in "files"
      const txUser2File = await eas.connect(user2).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user2.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptUser2File = await txUser2File.wait();
      user2FileUID = getUIDFromReceipt(receiptUser2File);
    });

    it("Should index by mime type and category", async function () {
      // Verify getChildrenByType("video/mp4") on Parent ("files")
      // Should return "my_video.mp4" (fileUID)
      const videos = await indexer.getChildrenByType(parentUID, "video/mp4", 0, 10, false);
      expect(videos).to.include(fileUID);

      // Verify getChildrenByType("video") - Category
      const category = await indexer.getChildrenByType(parentUID, "video", 0, 10, false);
      expect(category).to.include(fileUID);
    });

    it("Should filter by Attester", async function () {
      // Filter children of "files" by User A
      const u1Files = await indexer.getChildrenByAttester(parentUID, await user1.getAddress(), 0, 10, false);
      expect(u1Files.length).to.equal(1);
      expect(u1Files[0]).to.equal(userFileUID);

      // Filter children of "files" by User B
      const u2Files = await indexer.getChildrenByAttester(parentUID, await user2.getAddress(), 0, 10, false);
      expect(u2Files.length).to.equal(1);
      expect(u2Files[0]).to.equal(user2FileUID);
    });
  });

  describe("Revocation", function () {
    it("should PREVENT revocation of Anchors", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      // Create "temp.txt"
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false, // Schema is now irrevocable
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["temp.txt", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const uid = getUIDFromReceipt(receipt); // Attested UID

      expect(await indexer.resolvePath(ZERO_BYTES32, "temp.txt")).to.equal(uid);

      // 2. Try Revoke - Should Revert because Schema is irrevocable (checked by EAS)
      // EAS logic: if schema.revocable is false, revoke() reverts with Irrevocable()
      await expect(
        eas.revoke({
          schema: anchorSchemaUID,
          data: {
            uid: uid,
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "Irrevocable");
    });
  });

  describe("Tags (Crowd Sourcing)", function () {
    it("Should allow tagging with weight (int256)", async function () {
      // Create Anchor
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["tagged_file", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const anchorUID = getUIDFromReceipt(receipt);

      // Forward Tag (Positive Weight)
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 100n]), // LabelUID generic, Weight 100
          value: 0n,
        },
      });

      // Rejection Tag (Negative Weight)
      await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, -50n]), // Weight -50
          value: 0n,
        },
      });

      // Verify via Generic Index
      const referencing = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false);
      expect(referencing.length).to.equal(2);

      // Verify Aggregated Weight
      // 100 - 50 = 50
      const weight = await indexer.getTagWeight(anchorUID, ethers.ZeroHash);
      expect(weight).to.equal(50n);
    });

    it("Should return the correct count of referencing attestations", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["file_for_count", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      const anchorUID = getUIDFromReceipt(receipt);

      // Create a tag
      const tagTx = await eas.attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 10n]),
          value: 0n,
        },
      });
      const tagReceipt = await tagTx.wait();
      const tagUID = getUIDFromReceipt(tagReceipt);

      // Verify via Generic Index
      const attestations = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false);
      expect(attestations.length).to.equal(1);
      expect(attestations[0]).to.equal(tagUID);

      const count = await indexer.getReferencingAttestationCount(anchorUID, tagSchemaUID);
      expect(count).to.equal(1);
    });
    describe("Typed Anchors", function () {
      let parentUID: string;
      const schemaEncoder = new ethers.AbiCoder();

      beforeEach(async function () {
        // Create Parent "typed_root"
        const tx = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: schemaEncoder.encode(["string", "bytes32"], ["typed_root", ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receipt = await tx.wait();
        parentUID = getUIDFromReceipt(receipt);
      });

      it("Should index Anchors by Schema", async function () {
        // 1. Create Property Anchor "color"
        const txProp = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["color", propertySchemaUID]),
            value: 0n,
          },
        });
        const receiptProp = await txProp.wait();
        const propUID = getUIDFromReceipt(receiptProp);

        // 2. Create File Anchor "data.json"
        const txFile = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["data.json", dataSchemaUID]),
            value: 0n,
          },
        });
        const receiptFile = await txFile.wait();
        const fileUID = getUIDFromReceipt(receiptFile);

        // 3. Verify getAnchorsBySchema(Property)
        const props = await indexer.getAnchorsBySchema(parentUID, propertySchemaUID, 0, 10, false);
        expect(props.length).to.equal(1);
        expect(props[0]).to.equal(propUID);

        // 4. Verify getAnchorsBySchema(Data)
        const files = await indexer.getAnchorsBySchema(parentUID, dataSchemaUID, 0, 10, false);
        expect(files.length).to.equal(1);
        expect(files[0]).to.equal(fileUID);

        // 5. Verify Generic Children contains ALL
        const all = await indexer.getChildren(parentUID, 0, 10, false);
        expect(all.length).to.equal(2);
        expect(all).to.include(propUID);
        expect(all).to.include(fileUID);
      });

      it("Should resolve Anchors by Schema", async function () {
        // Create "test_name" as Property
        const txProp = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["test_name", propertySchemaUID]),
            value: 0n,
          },
        });
        const receiptProp = await txProp.wait();
        const propUID = getUIDFromReceipt(receiptProp);

        // Create "test_name" as Generic (Different Schema!) - Should succeed (unique by parent+name+schema)
        const txGen = await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], ["test_name", ZERO_BYTES32]),
            value: 0n,
          },
        });
        const receiptGen = await txGen.wait();
        const genUID = getUIDFromReceipt(receiptGen);

        // Resolve Property
        const resolvedProp = await indexer.resolveAnchor(parentUID, "test_name", propertySchemaUID);
        expect(resolvedProp).to.equal(propUID);

        // Resolve Generic (resolvePath defaults to 0)
        const resolvedGen = await indexer.resolvePath(parentUID, "test_name");
        expect(resolvedGen).to.equal(genUID);

        // Resolve Generic Explicitly
        const resolvedGenExplicit = await indexer.resolveAnchor(parentUID, "test_name", ZERO_BYTES32);
        expect(resolvedGenExplicit).to.equal(genUID);
      });
    });
  });

  describe("End-to-End Multi-Hop Flows", function () {
    let parentUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["multihop_root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      parentUID = getUIDFromReceipt(receipt);
    });

    it("Should resolve Property Value (Anchor -> Value)", async function () {
      // 1. Create Property Anchor "theme"
      const txAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["theme", propertySchemaUID]),
          value: 0n,
        },
      });
      const receiptAnchor = await txAnchor.wait();
      const anchorUID = getUIDFromReceipt(receiptAnchor);

      // 2. Attest Value "DarkMode"
      const txValue = await eas.attest({
        schema: propertySchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["string"], ["DarkMode"]),
          value: 0n,
        },
      });
      const receiptValue = await txValue.wait();
      const valueUID = getUIDFromReceipt(receiptValue);

      // 3. Resolve Anchor first
      const resolvedAnchor = await indexer.resolveAnchor(parentUID, "theme", propertySchemaUID);
      expect(resolvedAnchor).to.equal(anchorUID);

      // 4. Get Property Values
      const values = await indexer.getReferencingAttestations(anchorUID, propertySchemaUID, 0, 10, false);
      expect(values.length).to.equal(1);
      expect(values[0]).to.equal(valueUID);
    });

    it("Should resolve File Data (Anchor -> Data -> Blob)", async function () {
      // 1. Create File Anchor "intro.mp4"
      const txAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["intro.mp4", dataSchemaUID]),
          value: 0n,
        },
      });
      const receiptAnchor = await txAnchor.wait();
      const anchorUID = getUIDFromReceipt(receiptAnchor);

      // 2. Create Blob
      const txBlob = await eas.attest({
        schema: blobSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "uint8", "bytes"], ["video/mp4", 0, "0xFACE"]),
          value: 0n,
        },
      });
      const receiptBlob = await txBlob.wait();
      const blobUID = getUIDFromReceipt(receiptBlob);

      // 3. Link Anchor to Blob via Data Schema
      // DATA schema is `string uri, string contentType, string fileMode`
      // The blobUID is encoded as the uri field to preserve the reference
      const txData = await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: anchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], [blobUID, "video/mp4", "file"]),
          value: 0n,
        },
      });
      const receiptData = await txData.wait();
      getUIDFromReceipt(receiptData);

      // 4. Resolve Anchor
      const resolvedAnchor = await indexer.resolveAnchor(parentUID, "intro.mp4", dataSchemaUID);
      expect(resolvedAnchor).to.equal(anchorUID);

      // 5. Get Data Attestations
      const dataAttestations = await indexer.getReferencingAttestations(anchorUID, dataSchemaUID, 0, 10, false);
      expect(dataAttestations.length).to.equal(1);
    });
  });

  describe("Perspectives (Address-Based Namespaces)", function () {
    let parentUID: string;
    let fileAnchorUID: string;
    const schemaEncoder = new ethers.AbiCoder();

    beforeEach(async function () {
      // 1. Create a root directory (parent)
      const txParent = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["perspectives_dir", ZERO_BYTES32]),
          value: 0n,
        },
      });
      const receiptParent = await txParent.wait();
      parentUID = getUIDFromReceipt(receiptParent);

      // 2. Create a file anchor inside the directory
      const txFile = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parentUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["shared_file.json", dataSchemaUID]),
          value: 0n,
        },
      });
      const receiptFile = await txFile.wait();
      fileAnchorUID = getUIDFromReceipt(receiptFile);
    });

    it("Should track core Referencing mappings properly (All, Schema, Attester)", async function () {
      // User 1 tags the file
      const tagTx = await eas.connect(user1).attest({
        schema: tagSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 10n]),
          value: 0n,
        },
      });
      const tagReceipt = await tagTx.wait();
      const tagUID = getUIDFromReceipt(tagReceipt);

      // Check _allReferencing
      const allRef = await indexer.getAllReferencing(fileAnchorUID, 0, 10, false);
      expect(allRef).to.include(tagUID);

      // Check _referencingByAttester
      const attesterRef = await indexer.getReferencingByAttester(fileAnchorUID, await user1.getAddress(), 0, 10, false);
      expect(attesterRef).to.include(tagUID);

      // Check _referencingBySchemaAndAttester
      const schemaAttesterRef = await indexer.getReferencingBySchemaAndAttester(
        fileAnchorUID,
        tagSchemaUID,
        await user1.getAddress(),
        0,
        10,
        false,
      );
      expect(schemaAttesterRef).to.include(tagUID);

      // User 1 revokes the tag
      await eas.connect(user1).revoke({
        schema: tagSchemaUID,
        data: { uid: tagUID, value: 0n },
      });

      // Verify the revoked item is NOT removed from these arrays
      const allRefAfter = await indexer.getAllReferencing(fileAnchorUID, 0, 10, false);
      expect(allRefAfter.length).to.equal(1);
    });

    it("Should return Single Address History (showRevoked vs active)", async function () {
      // User 1 makes an edit
      const dataTx1 = await eas.connect(user1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://v1", "application/json", "file"]),
          value: 0n,
        },
      });
      const r1 = await dataTx1.wait();
      const uid1 = getUIDFromReceipt(r1);

      // User 1 makes a second edit
      const dataTx2 = await eas.connect(user1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://v2", "application/json", "file"]),
          value: 0n,
        },
      });
      const r2 = await dataTx2.wait();
      const uid2 = getUIDFromReceipt(r2);

      // Test active history (should return both)
      const [historyActive] = await indexer.getDataHistoryByAddress(
        fileAnchorUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(historyActive.length).to.equal(2);

      // Revoke the first edit
      await eas.connect(user1).revoke({
        schema: dataSchemaUID,
        data: { uid: uid1, value: 0n },
      });

      // Test history without revoked
      const [historyFiltered] = await indexer.getDataHistoryByAddress(
        fileAnchorUID,
        await user1.getAddress(),
        0,
        10,
        false,
        false,
      );
      expect(historyFiltered.length).to.equal(1);
      expect(historyFiltered[0]).to.equal(uid2);

      // Test history with revoked (showRevoked = true)
      const [historyAll] = await indexer.getDataHistoryByAddress(
        fileAnchorUID,
        await user1.getAddress(),
        0,
        10,
        false,
        true,
      );
      expect(historyAll.length).to.equal(2);
    });

    it("Should fallback correctly via getDataByAddressList", async function () {
      // User 1 edit
      const dataTx1 = await eas.connect(user1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://user1", "application/json", "file"]),
          value: 0n,
        },
      });
      const r1 = await dataTx1.wait();
      const uid1 = getUIDFromReceipt(r1);

      // User 2 edit
      const dataTx2 = await eas.connect(user2).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://user2", "application/json", "file"]),
          value: 0n,
        },
      });
      const r2 = await dataTx2.wait();
      const uid2 = getUIDFromReceipt(r2);

      // Pass [User2, User1]. Should prefer User2.
      const u1Address = await user1.getAddress();
      const u2Address = await user2.getAddress();
      const result1 = await indexer.getDataByAddressList(fileAnchorUID, [u2Address, u1Address], false);
      expect(result1).to.equal(uid2);

      // Pass [Unrelated, User1]. Should fallback to User1.
      const ownerAddress = await owner.getAddress();
      const result2 = await indexer.getDataByAddressList(fileAnchorUID, [ownerAddress, u1Address], false);
      expect(result2).to.equal(uid1);

      // Revoke User 2's edit
      await eas.connect(user2).revoke({ schema: dataSchemaUID, data: { uid: uid2, value: 0n } });

      // Pass [User2, User1] again. User 2 is revoked so it should fallback to User 1.
      const result3 = await indexer.getDataByAddressList(fileAnchorUID, [u2Address, u1Address], false);
      expect(result3).to.equal(uid1);

      // Pass with showRevoked = true. Should grab User2 again.
      const result4 = await indexer.getDataByAddressList(fileAnchorUID, [u2Address, u1Address], true);
      expect(result4).to.equal(uid2);
    });

    it("Should do Round-Robin Directory Pagination safely (getChildrenByAddressList)", async function () {
      // Setup: User 1 creates 3 files, User 2 creates 3 files in `parentUID`
      const createFile = async (signer: Signer, name: string) => {
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        const r = await tx.wait();
        return getUIDFromReceipt(r);
      };

      const u1File1 = await createFile(user1, "u1_1");
      const u1File2 = await createFile(user1, "u1_2");
      const u1File3 = await createFile(user1, "u1_3");

      const u2File1 = await createFile(user2, "u2_1");
      const u2File2 = await createFile(user2, "u2_2");
      const u2File3 = await createFile(user2, "u2_3");

      const u1Address = await user1.getAddress();
      const u2Address = await user2.getAddress();

      // Page 1: pageSize = 4, reverseOrder = false. Should grab 2 from U1, 2 from U2.
      // Order: u1_1, u2_1, u1_2, u2_2
      const [page1Results, page1Cursor] = await indexer.getChildrenByAddressList(
        parentUID,
        [u1Address, u2Address],
        0n,
        4,
        false,
        false,
      );

      expect(page1Results.length).to.equal(4);
      expect(page1Results[0]).to.equal(u1File1);
      expect(page1Results[1]).to.equal(u2File1);
      expect(page1Results[2]).to.equal(u1File2);
      expect(page1Results[3]).to.equal(u2File2);
      expect(page1Cursor).to.be.greaterThan(0n);

      // Page 2: use page1Cursor. Should pick up where it left off.
      // Order: u1_3, u2_3
      const [page2Results, _page2Cursor] = await indexer.getChildrenByAddressList(
        parentUID,
        [u1Address, u2Address],
        page1Cursor,
        4,
        false,
        false,
      );

      expect(page2Results.length).to.equal(2);
      expect(page2Results[0]).to.equal(u1File3);
      expect(page2Results[1]).to.equal(u2File3);
    });

    it("Should return bytes32(0) from getDataByAddressList when all data is revoked", async function () {
      const dataTx1 = await eas.connect(user1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://user1", "application/json", "file"]),
          value: 0n,
        },
      });
      const r1 = await dataTx1.wait();
      const uid1 = getUIDFromReceipt(r1);

      await eas.connect(user1).revoke({ schema: dataSchemaUID, data: { uid: uid1, value: 0n } });

      const u1Address = await user1.getAddress();
      const result = await indexer.getDataByAddressList(fileAnchorUID, [u1Address], false);
      expect(result).to.equal(ZERO_BYTES32);
    });

    it("Should do Round-Robin with unequal list lengths", async function () {
      const createFile = async (signer: Signer, name: string) => {
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        const r = await tx.wait();
        return getUIDFromReceipt(r);
      };

      // User 1 has 5 files, User 2 has 1 file
      const u1Files = [];
      for (let i = 1; i <= 5; i++) {
        u1Files.push(await createFile(user1, `u1_${i}`));
      }
      const u2File1 = await createFile(user2, "u2_1");

      const u1Address = await user1.getAddress();
      const u2Address = await user2.getAddress();

      // Page 1: pageSize = 4
      const [page1Results, page1Cursor] = await indexer.getChildrenByAddressList(
        parentUID,
        [u1Address, u2Address],
        0n,
        4,
        false,
        false,
      );

      expect(page1Results.length).to.equal(4);
      expect(page1Results[0]).to.equal(u1Files[0]);
      expect(page1Results[1]).to.equal(u2File1);
      expect(page1Results[2]).to.equal(u1Files[1]);
      expect(page1Results[3]).to.equal(u1Files[2]); // u2 is exhausted

      // Page 2: pageSize = 4
      const [page2Results, _page2Cursor] = await indexer.getChildrenByAddressList(
        parentUID,
        [u1Address, u2Address],
        page1Cursor,
        4,
        false,
        false,
      );

      expect(page2Results.length).to.equal(2);
      expect(page2Results[0]).to.equal(u1Files[3]);
      expect(page2Results[1]).to.equal(u1Files[4]);
    });

    it("Should do Round-Robin with 3+ users", async function () {
      const createFile = async (signer: Signer, name: string) => {
        const tx = await eas.connect(signer).attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: 0n,
            revocable: false,
            refUID: parentUID,
            data: schemaEncoder.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        });
        return getUIDFromReceipt(await tx.wait());
      };

      const _ownerFile = await createFile(owner, "owner_1");
      const u1File = await createFile(user1, "u1_1");
      const u2File = await createFile(user2, "u2_1");

      const [res, _cursor] = await indexer.getChildrenByAddressList(
        parentUID,
        [await owner.getAddress(), await user1.getAddress(), await user2.getAddress()],
        0n,
        3,
        false,
        false,
      );

      expect(res.length).to.equal(3);
      expect(res[0]).to.equal(fileAnchorUID); // Owner's first file created in beforeEach
      expect(res[1]).to.equal(u1File);
      expect(res[2]).to.equal(u2File);
    });
  });

  describe("Editions & Recursive Indexing", function () {
    const schemaEncoder = new ethers.AbiCoder();
    let rootUID: string;
    let folder1UID: string;
    let folder2UID: string;
    let fileUID: string;

    beforeEach(async function () {
      // Create Root (Zero Hash)
      let tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
          value: 0n,
        },
      });
      rootUID = getUIDFromReceipt(await tx.wait());

      // Create Folder 1 under Root (by owner)
      tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: rootUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["folder1", ZERO_BYTES32]),
          value: 0n,
        },
      });
      folder1UID = getUIDFromReceipt(await tx.wait());

      // Create Folder 2 under Folder 1 (by owner)
      tx = await eas.connect(owner).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder1UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["folder2", ZERO_BYTES32]),
          value: 0n,
        },
      });
      folder2UID = getUIDFromReceipt(await tx.wait());
    });

    it("Should flag containsAttestations for the Anchor creator", async function () {
      // User1 creates a file anchor under folder2
      const tx = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder2UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user1_file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      fileUID = getUIDFromReceipt(await tx.wait());

      // Check direct flag on the folder (since anchor refUID = folder2UID)
      const u1Address = await user1.getAddress();
      expect(await indexer.containsAttestations(folder2UID, u1Address)).to.equal(true);

      // Check schema-specific flag
      expect(await indexer.containsSchemaAttestations(folder2UID, u1Address, anchorSchemaUID)).to.equal(true);
    });

    it("Should recursively flag parent folders up to root", async function () {
      // User2 creates a file directly under folder2
      const tx = await eas.connect(user2).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder2UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["user2_file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      await tx.wait();

      const u2Address = await user2.getAddress();

      // Check all parents up to root
      expect(await indexer.containsAttestations(folder2UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(folder1UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, u2Address)).to.equal(true);
    });

    it("Should flag containsAttestations when a user attaches DATA schemas (Editions)", async function () {
      // User1 creates a file anchor
      let tx = await eas.connect(user1).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: folder2UID,
          data: schemaEncoder.encode(["string", "bytes32"], ["shared_file.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      fileUID = getUIDFromReceipt(await tx.wait());

      // User2 attaches data to User1's file anchor (Collaborative Edition)
      tx = await eas.connect(user2).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://content", "text/plain", "file"]),
          value: 0n,
        },
      });
      await tx.wait();

      const u1Address = await user1.getAddress();
      const u2Address = await user2.getAddress();

      // User1 should be flagged on the folder because they created the anchor
      expect(await indexer.containsAttestations(folder2UID, u1Address)).to.equal(true);

      // User2 should be flagged on the FILE ANCHOR because they attached DATA to it
      expect(await indexer.containsAttestations(fileUID, u2Address)).to.equal(true);

      // User2 should ALSO be recursively flagged all the way up to ROOT because the indexing logic traverses _parents
      expect(await indexer.containsAttestations(folder2UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(folder1UID, u2Address)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, u2Address)).to.equal(true);

      // Check Schema specific flag for User2 on the File Anchor
      expect(await indexer.containsSchemaAttestations(fileUID, u2Address, dataSchemaUID)).to.equal(true);
    });
  });
});
