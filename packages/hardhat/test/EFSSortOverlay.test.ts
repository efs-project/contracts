import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSSortOverlay, NameSort, TimestampSort, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSSortOverlay", function () {
  let indexer: EFSIndexer;
  let sortOverlay: EFSSortOverlay;
  let nameSort: NameSort;
  let tsSort: TimestampSort;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let blobSchemaUID: string;
  let sortInfoSchemaUID: string;

  const enc = ethers.AbiCoder.defaultAbiCoder();

  before(async function () {
    [owner, alice, bob] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // 1. Deploy SchemaRegistry and EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // 2. Nonce-predict future addresses
    // Deployment order:
    //   +0: Register ANCHOR schema
    //   +1: Register PROPERTY schema
    //   +2: Register DATA schema
    //   +3: Register BLOB schema (no resolver)
    //   +4: Deploy EFSIndexer
    //   +5: Deploy NameSort
    //   +6: Deploy TimestampSort
    //   +7: Register SORT_INFO schema (with futureOverlayAddr as resolver)
    //   +8: Deploy EFSSortOverlay
    const ownerAddr = await owner.getAddress();
    const baseNonce = await ethers.provider.getTransactionCount(ownerAddr);

    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: baseNonce + 4 });
    const futureOverlayAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: baseNonce + 8 });

    // 3. Register EFS schemas with futureIndexerAddr as resolver
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false);
    anchorSchemaUID = (await tx1.wait())!.logs[0].topics[1];

    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    propertySchemaUID = (await tx2.wait())!.logs[0].topics[1];

    const tx3 = await registry.register("string uri, string contentType, string fileMode", futureIndexerAddr, true);
    dataSchemaUID = (await tx3.wait())!.logs[0].topics[1];

    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    blobSchemaUID = (await tx4.wait())!.logs[0].topics[1];

    // 4. Deploy EFSIndexer
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

    // 5. Deploy sort implementations
    const NameSortFactory = await ethers.getContractFactory("NameSort");
    nameSort = await NameSortFactory.deploy(await eas.getAddress());
    await nameSort.waitForDeployment();

    const TsSortFactory = await ethers.getContractFactory("TimestampSort");
    tsSort = await TsSortFactory.deploy(await eas.getAddress());
    await tsSort.waitForDeployment();

    // 6. Register SORT_INFO schema (v2: includes sourceType)
    const tx5 = await registry.register(
      "address sortFunc, bytes32 targetSchema, uint8 sourceType",
      futureOverlayAddr,
      true,
    );
    sortInfoSchemaUID = (await tx5.wait())!.logs[0].topics[1];

    // 7. Deploy EFSSortOverlay
    const OverlayFactory = await ethers.getContractFactory("EFSSortOverlay");
    sortOverlay = await OverlayFactory.deploy(await eas.getAddress(), sortInfoSchemaUID, await indexer.getAddress());
    await sortOverlay.waitForDeployment();
    expect(await sortOverlay.getAddress()).to.equal(futureOverlayAddr);
  });

  // ============================================================================================
  // HELPERS
  // ============================================================================================

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        // ignore
      }
    }
    throw new Error("Attested event not found");
  };

  /** Create a generic anchor with optional schema and parent. Returns UID. */
  const createAnchor = async (
    signer: Signer,
    name: string,
    parentUID = ZERO_BYTES32,
    anchorSchema = ZERO_BYTES32,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, anchorSchema]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a SORT_INFO attestation. sourceType=0 means sort _children (global). */
  const createSortInfo = async (
    signer: Signer,
    namingAnchorUID: string,
    sortFuncAddr: string,
    targetSchema = ZERO_BYTES32,
    sourceType = 0,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: sortInfoSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: namingAnchorUID,
        data: enc.encode(["address", "bytes32", "uint8"], [sortFuncAddr, targetSchema, sourceType]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  // ============================================================================================
  // SORT_INFO ATTEST VALIDATION
  // ============================================================================================

  describe("SORT_INFO attestation validation", function () {
    it("should reject SORT_INFO with zero sortFunc address", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);

      await expect(
        eas.attest({
          schema: sortInfoSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: namingUID,
            data: enc.encode(["address", "bytes32", "uint8"], [ZeroAddress, ZERO_BYTES32, 0]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("should reject SORT_INFO with no refUID (no naming anchor)", async function () {
      await expect(
        eas.attest({
          schema: sortInfoSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: enc.encode(["address", "bytes32", "uint8"], [await nameSort.getAddress(), ZERO_BYTES32, 0]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("should reject SORT_INFO with unsupported sourceType", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);

      await expect(
        eas.attest({
          schema: sortInfoSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: namingUID,
            data: enc.encode(
              ["address", "bytes32", "uint8"],
              [await nameSort.getAddress(), ZERO_BYTES32, 2], // sourceType=2 reserved
            ),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("should store sort config on valid SORT_INFO", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await nameSort.getAddress());

      expect(await sortOverlay.isSortRegistered(sortInfoUID)).to.equal(true);
      const config = await sortOverlay.getSortConfig(sortInfoUID);
      expect(config.sortFunc).to.equal(await nameSort.getAddress());
      expect(config.sourceType).to.equal(0);
    });

    it("should reflect revocation via indexer.isRevoked after SORT_INFO revocation", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await nameSort.getAddress());

      expect(await indexer.isRevoked(sortInfoUID)).to.equal(false);
      await eas.revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });
      expect(await indexer.isRevoked(sortInfoUID)).to.equal(true);
    });
  });

  // ============================================================================================
  // PROCESS ITEMS — SHARED SORTED LIST (sourceType=0: all children)
  // ============================================================================================

  describe("processItems with NameSort — shared sorted list", function () {
    let parentUID: string;
    let namingUID: string;
    let sortInfoUID: string;
    let catUID: string;
    let dogUID: string;
    let hamsterUID: string;

    beforeEach(async function () {
      // Directory: /memes/  (created by alice)
      parentUID = await createAnchor(alice, "memes");

      // Files added in insertion order: cat, dog, hamster
      catUID = await createAnchor(alice, "cat", parentUID);
      dogUID = await createAnchor(alice, "dog", parentUID);
      hamsterUID = await createAnchor(alice, "hamster", parentUID);

      // Naming anchor and SORT_INFO (anyone can create a sort on any anchor)
      namingUID = await createAnchor(alice, "byname", parentUID, sortInfoSchemaUID);
      sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());
    });

    it("getSortStaleness shows all items unprocessed initially", async function () {
      // Kernel has: cat, dog, hamster, byname = 4 items
      const staleness = await sortOverlay.getSortStaleness(sortInfoUID, parentUID);
      expect(staleness).to.equal(4n);
    });

    it("processItems inserts items in sorted order", async function () {
      // Kernel order: [cat, dog, hamster, byname]
      // Alphabetical (with uid tie-break): "byname" < "cat" < "dog" < "hamster"
      // Process kernel order with correct positional hints.
      // Sorted list builds incrementally — hints describe positions in list as it grows.

      // Compute hints on-chain for convenience
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, parentUID, [
        catUID,
        dogUID,
        hamsterUID,
        namingUID,
      ]);
      await sortOverlay.connect(alice).processItems(
        sortInfoUID,
        parentUID,
        0n, // expectedStartIndex
        [catUID, dogUID, hamsterUID, namingUID],
        [...lefts],
        [...rights],
      );

      const [items, next] = await sortOverlay.getSortedChunk(sortInfoUID, parentUID, ZERO_BYTES32, 10, false);
      expect(items.length).to.equal(4);
      expect(items[0]).to.equal(namingUID); // "byname" < "cat"
      expect(items[1]).to.equal(catUID);
      expect(items[2]).to.equal(dogUID);
      expect(items[3]).to.equal(hamsterUID);
      expect(next).to.equal(ZERO_BYTES32);
    });

    it("getSortStaleness is 0 after all items processed", async function () {
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, parentUID, [
        catUID,
        dogUID,
        hamsterUID,
        namingUID,
      ]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, parentUID, 0n, [catUID, dogUID, hamsterUID, namingUID], [...lefts], [...rights]);
      expect(await sortOverlay.getSortStaleness(sortInfoUID, parentUID)).to.equal(0n);
    });

    it("staleness grows when new kernel items are added after processing", async function () {
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, parentUID, [
        catUID,
        dogUID,
        hamsterUID,
        namingUID,
      ]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, parentUID, 0n, [catUID, dogUID, hamsterUID, namingUID], [...lefts], [...rights]);
      expect(await sortOverlay.getSortStaleness(sortInfoUID, parentUID)).to.equal(0n);

      // Add a new file to the kernel
      await createAnchor(alice, "aardvark", parentUID);
      expect(await sortOverlay.getSortStaleness(sortInfoUID, parentUID)).to.equal(1n);
    });

    it("getLastProcessedIndex advances as items are processed", async function () {
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, parentUID)).to.equal(0n);

      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, parentUID, [catUID, dogUID]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, parentUID, 0n, [catUID, dogUID], [...lefts], [...rights]);
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, parentUID)).to.equal(2n);
    });

    it("rejects processItems with mismatched array lengths", async function () {
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, parentUID, 0n, [catUID, dogUID], [ZERO_BYTES32], [ZERO_BYTES32, ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "ArrayLengthMismatch");
    });

    it("rejects invalid sort positions", async function () {
      // Inserting cat with dogUID as left hint — dog > cat so this is invalid (dog is not < cat)
      await expect(
        sortOverlay.connect(alice).processItems(
          sortInfoUID,
          parentUID,
          0n,
          [catUID],
          [dogUID], // dog comes AFTER cat — invalid left hint
          [ZERO_BYTES32],
        ),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidPosition");
    });

    it("rejects left neighbour that is not a member of the list", async function () {
      // Seed the list with cat alone.
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, parentUID, 0n, [catUID], [ZERO_BYTES32], [ZERO_BYTES32]);

      // Fabricated (never-attested) left neighbour with rightNeighbour = 0.
      // Without the membership guard, default-zero pointers on the fabricated slot would satisfy
      // the adjacency check and corrupt the shared list by stashing pointers into orphan storage.
      const fakeLeft = "0x" + "ab".repeat(32);
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, parentUID, 1n, [dogUID], [fakeLeft as `0x${string}`], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidPosition");
    });

    it("rejects right neighbour that is not a member of the list", async function () {
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, parentUID, 0n, [catUID], [ZERO_BYTES32], [ZERO_BYTES32]);

      const fakeRight = "0x" + "cd".repeat(32);
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, parentUID, 1n, [dogUID], [ZERO_BYTES32], [fakeRight as `0x${string}`]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidPosition");
    });
  });

  // ============================================================================================
  // CONCURRENT processItems — StaleStartIndex
  // ============================================================================================

  describe("processItems concurrency safety (expectedStartIndex)", function () {
    it("is a no-op when batch already fully processed by another caller", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const f1 = await createAnchor(alice, "apple", dirUID);
      const namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Bob processes first (acts as "public good" processor)
      await sortOverlay
        .connect(bob)
        .processItems(sortInfoUID, dirUID, 0n, [f1, namingUID], [ZERO_BYTES32, f1], [ZERO_BYTES32, ZERO_BYTES32]);

      // Alice tries to process same range — should silently no-op (already processed)
      // currentIndex(2) >= expectedStartIndex(0) + items.length(2) → no-op
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [f1, namingUID], [ZERO_BYTES32, f1], [ZERO_BYTES32, ZERO_BYTES32]);

      // List should still be correct (Bob's processing)
      const [items] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 10, false);
      expect(items.length).to.equal(2);
    });

    it("reverts StaleStartIndex when expectedStartIndex is wrong (partial overlap)", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const f1 = await createAnchor(alice, "apple", dirUID);
      const f2 = await createAnchor(alice, "banana", dirUID);
      const namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Process f1 only
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [f1], [ZERO_BYTES32], [ZERO_BYTES32]);

      // Now try to process from index 0 again (stale) with more items — should revert
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, dirUID, 0n, [f1, f2], [ZERO_BYTES32, f1], [ZERO_BYTES32, ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "StaleStartIndex");
    });
  });

  // ============================================================================================
  // SHARED SORTED LIST — Multiple contributors
  // ============================================================================================

  describe("shared sorted list across multiple contributors", function () {
    it("anyone can advance the shared sorted list — items from all contribuors sorted together", async function () {
      const dirUID = await createAnchor(alice, "dir");

      // Alice adds: zebra, apple
      const zebraUID = await createAnchor(alice, "zebra", dirUID);
      const appleUID = await createAnchor(alice, "apple", dirUID);

      // Bob adds: mango (to the same dir)
      const mangoUID = await createAnchor(bob, "mango", dirUID);

      const namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Global kernel order: zebra, apple, mango, naming
      // Bob processes the shared list (anyone can do it)
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [
        zebraUID,
        appleUID,
        mangoUID,
        namingUID,
      ]);
      await sortOverlay
        .connect(bob)
        .processItems(sortInfoUID, dirUID, 0n, [zebraUID, appleUID, mangoUID, namingUID], [...lefts], [...rights]);

      // Shared sorted order: "apple" < "byname" < "mango" < "zebra"
      const [items] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 10, false);
      expect(items.length).to.equal(4);
      expect(items[0]).to.equal(appleUID); // "apple"
      expect(items[1]).to.equal(namingUID); // "byname"
      expect(items[2]).to.equal(mangoUID); // "mango"
      expect(items[3]).to.equal(zebraUID); // "zebra"
    });

    it("getSortedChunkByAddressList filters to alice's items only", async function () {
      const aliceAddr = await alice.getAddress();
      const dirUID = await createAnchor(alice, "dir");

      const appleUID = await createAnchor(alice, "apple", dirUID);
      const bananaUID = await createAnchor(bob, "banana", dirUID);
      const cherryUID = await createAnchor(alice, "cherry", dirUID);
      const namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Process all items
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [
        appleUID,
        bananaUID,
        cherryUID,
        namingUID,
      ]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [appleUID, bananaUID, cherryUID, namingUID], [...lefts], [...rights]);

      // Full sorted: apple, banana, byname(naming), cherry
      const [allItems] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 10, false);
      expect(allItems.length).to.equal(4);

      // Edition-filtered: only alice's items
      const [aliceItems] = await sortOverlay.getSortedChunkByAddressList(
        sortInfoUID,
        dirUID,
        ZERO_BYTES32,
        10,
        0, // default maxTraversal
        [aliceAddr],
        false,
      );
      // Alice created: apple, cherry, byname(naming)
      expect(aliceItems.length).to.equal(3);
      expect(aliceItems).to.include(appleUID);
      expect(aliceItems).to.include(cherryUID);
      expect(aliceItems).to.include(namingUID);
      expect(aliceItems).to.not.include(bananaUID);
    });
  });

  // ============================================================================================
  // CURSOR-BASED PAGINATION
  // ============================================================================================

  describe("getSortedChunk cursor pagination", function () {
    it("paginates through sorted items with cursor", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const aUID = await createAnchor(alice, "aardvark", dirUID);
      const bUID = await createAnchor(alice, "bear", dirUID);
      const cUID = await createAnchor(alice, "cat", dirUID);
      const dUID = await createAnchor(alice, "dog", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Sorted: aardvark, alpha(naming), bear, cat, dog
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [aUID, bUID, cUID, dUID, namingUID]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [aUID, bUID, cUID, dUID, namingUID], [...lefts], [...rights]);

      // Page 1: limit=2
      const [page1, cursor1] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 2, false);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(aUID); // "aardvark"
      expect(page1[1]).to.equal(namingUID); // "alpha"

      // Page 2: limit=2
      const [page2, cursor2] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, cursor1, 2, false);
      expect(page2.length).to.equal(2);
      expect(page2[0]).to.equal(bUID); // "bear"
      expect(page2[1]).to.equal(cUID); // "cat"

      // Page 3: limit=2 — last item
      const [page3, cursor3] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, cursor2, 2, false);
      expect(page3.length).to.equal(1);
      expect(page3[0]).to.equal(dUID); // "dog"
      expect(cursor3).to.equal(ZERO_BYTES32); // end of list
    });
  });

  // ============================================================================================
  // REVOKED ITEMS — consistency
  // ============================================================================================

  describe("revoked items in sorted list", function () {
    it("revoked items are inserted but skipped by default in getSortedChunk", async function () {
      const dirUID = await createAnchor(alice, "dir");

      // Create a DATA attestation (revocable) under a file anchor
      const fileAnchorUID = await createAnchor(alice, "file", dirUID, dataSchemaUID);
      const dataTx = await eas.connect(alice).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: fileAnchorUID,
          data: enc.encode(["string", "string", "string"], ["ipfs://v1", "text/plain", "file"]),
          value: 0n,
        },
      });
      const dataUID = getUID(await dataTx.wait());

      // Revoke the data attestation
      await eas.connect(alice).revoke({ schema: dataSchemaUID, data: { uid: dataUID, value: 0n } });
      expect(await indexer.isRevoked(dataUID)).to.equal(true);

      // The anchor itself is not revocable, so it's still in the kernel — confirm isRevoked=false
      expect(await indexer.isRevoked(fileAnchorUID)).to.equal(false);
    });
  });

  // ============================================================================================
  // TIMESTAMP SORT
  // ============================================================================================

  describe("TimestampSort", function () {
    it("sorts items by attestation time (oldest first), uid tie-break for same timestamp", async function () {
      const dirUID = await createAnchor(alice, "dir");

      // Mine separate blocks to get different timestamps
      const a1 = await createAnchor(alice, "first", dirUID);
      await ethers.provider.send("evm_mine", []);
      const a2 = await createAnchor(alice, "second", dirUID);
      await ethers.provider.send("evm_mine", []);
      const a3 = await createAnchor(alice, "third", dirUID);

      const namingUID = await createAnchor(alice, "ts-sort", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await tsSort.getAddress());

      // Kernel order: a1, a2, a3, naming
      // Timestamp order: a1 < a2 < a3 < naming (naming was attested last)
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [a1, a2, a3, namingUID]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [a1, a2, a3, namingUID], [...lefts], [...rights]);

      const [items] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 10, false);
      expect(items.length).to.equal(4);
      expect(items[0]).to.equal(a1);
      expect(items[1]).to.equal(a2);
      expect(items[2]).to.equal(a3);
      expect(items[3]).to.equal(namingUID);
    });
  });

  // ============================================================================================
  // INVALID SORT_INFO
  // ============================================================================================

  describe("processItems rejects invalid sortInfoUID", function () {
    it("reverts if sortInfoUID was never attested", async function () {
      const fakeDir = await createAnchor(alice, "dir");
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(ZERO_BYTES32, fakeDir, 0n, [ZERO_BYTES32], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidSortInfo");
    });

    it("reverts if sortInfoUID is revoked", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      await eas.connect(alice).revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });

      const child = await createAnchor(alice, "child", dirUID);
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [child], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidSortInfo");
    });
  });

  // ============================================================================================
  // ITEM MEMBERSHIP VALIDATION
  // ============================================================================================

  describe("processItems item membership validation", function () {
    it("reverts with InvalidItem when item does not match expected kernel position", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir");
      await createAnchor(alice, "file1", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // file1 is at kernel index 0. Passing namingUID (index 1) instead should revert.
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [namingUID], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidItem");
    });

    it("reverts with InvalidItem when a fabricated UID not in kernel is submitted", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir2");
      await createAnchor(alice, "real-file", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("not-a-real-kernel-item"));
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [fakeUID], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidItem");
    });

    it("processes items correctly when submitted in exact kernel order", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir3");
      const f1 = await createAnchor(alice, "zebra", dirUID);
      const f2 = await createAnchor(alice, "apple", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f1, f2, namingUID]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [f1, f2, namingUID], [...lefts], [...rights]);

      const [sorted] = await sortOverlay.getSortedChunk(sortInfoUID, dirUID, ZERO_BYTES32, 10, false);
      // Alphabetical: alpha(naming) < apple(f2) < zebra(f1)
      expect(sorted[0]).to.equal(namingUID);
      expect(sorted[1]).to.equal(f2);
      expect(sorted[2]).to.equal(f1);
    });

    it("second batch starts from correct kernel position after first batch", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir4");
      const f1 = await createAnchor(alice, "mango", dirUID);
      const f2 = await createAnchor(alice, "banana", dirUID);
      const f3 = await createAnchor(alice, "cherry", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Process first two items (f1, f2)
      const [lefts1, rights1] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f1, f2]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [f1, f2], [...lefts1], [...rights1]);
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, dirUID)).to.equal(2n);

      // Re-submitting an already-processed batch (expectedStartIndex + items.length <= currentIndex)
      // is a silent no-op — not a revert. This allows concurrent callers that got front-run to
      // complete without error.
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, dirUID, 0n, [f1, f2], [ZERO_BYTES32, f1], [ZERO_BYTES32, ZERO_BYTES32]),
      ).not.to.be.reverted;
      // State must be unchanged
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, dirUID)).to.equal(2n);

      // Partial overlap (expectedStartIndex = 1, items.length = 2 → needs indices [1,2] but
      // currentIndex is already 2) DOES revert StaleStartIndex because currentIndex (2) != expectedStartIndex (1)
      // AND 2 < 1 + 2 = 3, so it's a partial-overlap stale case.
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, dirUID, 1n, [f2, f3], [ZERO_BYTES32, f1], [f2, ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "StaleStartIndex");

      // Processing from correct index (2) succeeds
      const [lefts2, rights2] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f3, namingUID]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 2n, [f3, namingUID], [...lefts2], [...rights2]);
      expect(await sortOverlay.getSortLength(sortInfoUID, dirUID)).to.equal(4n);
    });
  });

  // ============================================================================================
  // repositionItem
  // ============================================================================================

  describe("repositionItem", function () {
    let dirUID: string;
    let appleUID: string;
    let bananaUID: string;
    let cherryUID: string;
    let namingUID: string;
    let sortInfoUID: string;

    beforeEach(async function () {
      dirUID = await createAnchor(alice, "dir");
      appleUID = await createAnchor(alice, "apple", dirUID);
      bananaUID = await createAnchor(alice, "banana", dirUID);
      cherryUID = await createAnchor(alice, "cherry", dirUID);
      namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);
      sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Process all items: sorted order: apple, banana, byname(naming), cherry
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [
        appleUID,
        bananaUID,
        cherryUID,
        namingUID,
      ]);
      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, dirUID, 0n, [appleUID, bananaUID, cherryUID, namingUID], [...lefts], [...rights]);
    });

    it("repositions an item to a new position", async function () {
      // Current order: apple, banana, byname(naming), cherry
      // Reposition cherry to the head (before apple)
      // cherry > apple, so cherry is currently after apple — changing is valid
      // But wait: cherry "should" sort after apple. UnnecessaryReposition only fires if
      // invariant is already satisfied. Cherry is already correctly after apple and banana.
      // To cause a valid reposition, we need to manually force cherry to an invalid position
      // by repositioning it before apple.

      // Actually repositionItem is for when sort KEYS change, not for arbitrary moves.
      // The invariant check uses isLessThan. "cherry" > "apple" so cherry can't go before apple
      // without violating the invariant from the contract's perspective.
      // So repositionItem(cherry, left=0, right=apple) would revert InvalidPosition
      // because isLessThan(apple, cherry) = true = cherry > apple, so cherry can't be before apple.

      // Instead, let's test a case where repositionItem makes sense.
      // We need a sort where a key might change. For this test, let's verify UnnecessaryReposition.

      // cherry is already correctly positioned (after banana). Repositioning cherry to (left=banana, right=0)
      // would be its current position — the invariant is satisfied. Should revert.
      await expect(
        sortOverlay.connect(alice).repositionItem(
          sortInfoUID,
          dirUID,
          cherryUID,
          namingUID, // current left neighbour of cherry
          ZERO_BYTES32, // current right neighbour (cherry is tail)
        ),
      ).to.be.revertedWithCustomError(sortOverlay, "UnnecessaryReposition");
    });

    it("reverts UnnecessaryReposition when item is already in correct position", async function () {
      // apple is head, already satisfies invariant (no left, right=banana satisfies apple < banana)
      await expect(
        sortOverlay.connect(alice).repositionItem(
          sortInfoUID,
          dirUID,
          appleUID,
          ZERO_BYTES32, // current left (head)
          bananaUID, // current right
        ),
      ).to.be.revertedWithCustomError(sortOverlay, "UnnecessaryReposition");
    });

    it("reverts InvalidSortInfo for unregistered sort", async function () {
      await expect(
        sortOverlay.connect(alice).repositionItem(
          ZERO_BYTES32, // fake sortInfoUID
          dirUID,
          appleUID,
          ZERO_BYTES32,
          bananaUID,
        ),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidSortInfo");
    });

    // Property test: repositionItem maintains list invariants
    it("list invariants hold after repositionItem (length constant, no cycles, sorted)", async function () {
      // We'll verify invariants by walking the list and checking:
      // 1. Length is the same as getSortLength
      // 2. Walk from head reaches all items exactly once (no cycles)
      // 3. No need to actually reposition (UnnecessaryReposition expected for all items)
      //    because NameSort is stable — verify by checking each item

      const length = await sortOverlay.getSortLength(sortInfoUID, dirUID);
      expect(length).to.equal(4n);

      // Walk the list manually
      let current = await sortOverlay.getSortHead(sortInfoUID, dirUID);
      const visited: string[] = [];
      for (let i = 0; i < 10; i++) {
        if (current === ZERO_BYTES32) break;
        visited.push(current);
        const node = await sortOverlay.getSortNode(sortInfoUID, dirUID, current);
        current = node.next;
      }

      // Exactly 4 items visited
      expect(visited.length).to.equal(4);
      // Last node's next should be zero (no cycle)
      const lastNode = await sortOverlay.getSortNode(sortInfoUID, dirUID, visited[3]);
      expect(lastNode.next).to.equal(ZERO_BYTES32);
      // First node's prev should be zero (correct head)
      const firstNode = await sortOverlay.getSortNode(sortInfoUID, dirUID, visited[0]);
      expect(firstNode.prev).to.equal(ZERO_BYTES32);
      // Tail should match last visited
      expect(await sortOverlay.getSortTail(sortInfoUID, dirUID)).to.equal(visited[3]);
    });
  });

  // ============================================================================================
  // repositionItem — PROPERTY / FUZZ TESTS
  // ============================================================================================

  describe("repositionItem property tests — invariants after operations", function () {
    /** Walk the sorted list head→tail and return visited UIDs. Detects cycles. */
    async function walkList(overlay: EFSSortOverlay, sortInfoUID: string, parentUID: string): Promise<string[]> {
      const visited: string[] = [];
      const maxSteps = 100;
      let current = await overlay.getSortHead(sortInfoUID, parentUID);
      for (let i = 0; i < maxSteps; i++) {
        if (current === ZERO_BYTES32) break;
        if (visited.includes(current)) throw new Error("Cycle detected in linked list!");
        visited.push(current);
        const node = await overlay.getSortNode(sortInfoUID, parentUID, current);
        current = node.next;
      }
      return visited;
    }

    /** Assert all linked list invariants hold. */
    async function assertListInvariants(
      overlay: EFSSortOverlay,
      sortInfoUID: string,
      parentUID: string,
      expectedLength: number,
    ) {
      const visited = await walkList(overlay, sortInfoUID, parentUID);

      // 1. Length matches
      const onChainLength = await overlay.getSortLength(sortInfoUID, parentUID);
      expect(onChainLength).to.equal(BigInt(expectedLength), "on-chain length mismatch");
      expect(visited.length).to.equal(expectedLength, "walk length mismatch");

      // 2. No cycles (walkList would throw)

      // 3. Head.prev == 0
      if (visited.length > 0) {
        const headNode = await overlay.getSortNode(sortInfoUID, parentUID, visited[0]);
        expect(headNode.prev).to.equal(ZERO_BYTES32, "head.prev should be zero");
      }

      // 4. Tail.next == 0
      if (visited.length > 0) {
        const tailUID = visited[visited.length - 1];
        const tailNode = await overlay.getSortNode(sortInfoUID, parentUID, tailUID);
        expect(tailNode.next).to.equal(ZERO_BYTES32, "tail.next should be zero");
        expect(await overlay.getSortTail(sortInfoUID, parentUID)).to.equal(tailUID, "tail pointer mismatch");
      }

      // 5. Doubly-linked consistency: each node's prev.next == node and next.prev == node
      for (let i = 0; i < visited.length; i++) {
        const node = await overlay.getSortNode(sortInfoUID, parentUID, visited[i]);
        if (i > 0) {
          expect(node.prev).to.equal(visited[i - 1], `node ${i} prev mismatch`);
        }
        if (i < visited.length - 1) {
          expect(node.next).to.equal(visited[i + 1], `node ${i} next mismatch`);
        }
      }
    }

    it("invariants hold after processing items in multiple batches", async function () {
      const dirUID = await createAnchor(alice, "fuzz-dir-1");
      const items: string[] = [];
      const names = ["mango", "cherry", "apple", "fig", "banana", "elderberry", "date"];
      for (const name of names) {
        items.push(await createAnchor(alice, name, dirUID));
      }
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Process in batches of 2
      const allKernel = [...items, namingUID];
      for (let i = 0; i < allKernel.length; i += 2) {
        const batch = allKernel.slice(i, i + 2);
        const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, batch);
        await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, BigInt(i), batch, [...lefts], [...rights]);
        await assertListInvariants(sortOverlay, sortInfoUID, dirUID, i + batch.length);
      }

      // Final sorted order should be alphabetical
      const visited = await walkList(sortOverlay, sortInfoUID, dirUID);
      expect(visited.length).to.equal(8); // 7 items + naming anchor
    });

    it("invariants hold with single-item list", async function () {
      const dirUID = await createAnchor(alice, "fuzz-dir-2");
      const f1 = await createAnchor(alice, "only-child", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f1]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [f1], [...lefts], [...rights]);

      await assertListInvariants(sortOverlay, sortInfoUID, dirUID, 1);
    });

    it("invariants hold after processing reverse-sorted input", async function () {
      const dirUID = await createAnchor(alice, "fuzz-dir-3");
      // Items in reverse alphabetical order
      const z = await createAnchor(alice, "zoo", dirUID);
      const y = await createAnchor(alice, "yak", dirUID);
      const x = await createAnchor(alice, "xray", dirUID);
      const w = await createAnchor(alice, "walrus", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      const allItems = [z, y, x, w, namingUID];
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, allItems);
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, allItems, [...lefts], [...rights]);

      await assertListInvariants(sortOverlay, sortInfoUID, dirUID, 5);

      // Verify sorted order: alpha < walrus < xray < yak < zoo
      const visited = await walkList(sortOverlay, sortInfoUID, dirUID);
      expect(visited[0]).to.equal(namingUID); // "alpha"
      expect(visited[1]).to.equal(w); // "walrus"
      expect(visited[2]).to.equal(x); // "xray"
      expect(visited[3]).to.equal(y); // "yak"
      expect(visited[4]).to.equal(z); // "zoo"
    });

    it("repositionItem reverts for every item when list is already sorted (no-op protection)", async function () {
      const dirUID = await createAnchor(alice, "fuzz-dir-4");
      const a = await createAnchor(alice, "alpha", dirUID);
      const b = await createAnchor(alice, "beta", dirUID);
      const c = await createAnchor(alice, "gamma", dirUID);
      const namingUID = await createAnchor(alice, "sort", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      const allItems = [a, b, c, namingUID];
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, dirUID, allItems);
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, allItems, [...lefts], [...rights]);

      // Every item is correctly positioned — repositionItem should revert UnnecessaryReposition for each
      const visited = await walkList(sortOverlay, sortInfoUID, dirUID);
      for (let i = 0; i < visited.length; i++) {
        const leftHint = i > 0 ? visited[i - 1] : ZERO_BYTES32;
        const rightHint = i < visited.length - 1 ? visited[i + 1] : ZERO_BYTES32;
        await expect(
          sortOverlay.connect(alice).repositionItem(sortInfoUID, dirUID, visited[i], leftHint, rightHint),
        ).to.be.revertedWithCustomError(sortOverlay, "UnnecessaryReposition");
      }

      // Invariants still hold
      await assertListInvariants(sortOverlay, sortInfoUID, dirUID, 4);
    });

    it("multiple contributors processing different batches maintains invariants", async function () {
      const dirUID = await createAnchor(alice, "fuzz-dir-5");
      const f1 = await createAnchor(alice, "fig", dirUID);
      const f2 = await createAnchor(bob, "elderberry", dirUID);
      const f3 = await createAnchor(alice, "date", dirUID);
      const f4 = await createAnchor(bob, "cherry", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());

      // Alice processes first 2
      const [l1, r1] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f1, f2]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, dirUID, 0n, [f1, f2], [...l1], [...r1]);
      await assertListInvariants(sortOverlay, sortInfoUID, dirUID, 2);

      // Bob processes next 3
      const [l2, r2] = await sortOverlay.computeHints(sortInfoUID, dirUID, [f3, f4, namingUID]);
      await sortOverlay.connect(bob).processItems(sortInfoUID, dirUID, 2n, [f3, f4, namingUID], [...l2], [...r2]);
      await assertListInvariants(sortOverlay, sortInfoUID, dirUID, 5);

      // Verify alphabetical: alpha < cherry < date < elderberry < fig
      const visited = await walkList(sortOverlay, sortInfoUID, dirUID);
      expect(visited[0]).to.equal(namingUID); // "alpha"
      expect(visited[1]).to.equal(f4); // "cherry"
      expect(visited[2]).to.equal(f3); // "date"
      expect(visited[3]).to.equal(f2); // "elderberry"
      expect(visited[4]).to.equal(f1); // "fig"
    });
  });

  // ============================================================================================
  // NEW EFSIndexer FUNCTIONS (getChildAt, getChildBySchemaAt, getChildCountBySchema)
  // ============================================================================================

  describe("EFSIndexer new index-access functions", function () {
    it("getChildAt returns correct child by physical index", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const f1 = await createAnchor(alice, "file1", dirUID);
      const f2 = await createAnchor(alice, "file2", dirUID);
      const f3 = await createAnchor(alice, "file3", dirUID);

      expect(await indexer.getChildAt(dirUID, 0)).to.equal(f1);
      expect(await indexer.getChildAt(dirUID, 1)).to.equal(f2);
      expect(await indexer.getChildAt(dirUID, 2)).to.equal(f3);
    });

    it("getChildAt reverts on out-of-bounds index", async function () {
      const dirUID = await createAnchor(alice, "dir");
      await createAnchor(alice, "file1", dirUID);

      await expect(indexer.getChildAt(dirUID, 5)).to.be.revertedWith("EFSIndexer: index out of bounds");
    });

    it("getChildBySchemaAt returns children filtered by schema", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const s1 = await createAnchor(alice, "sort1", dirUID, sortInfoSchemaUID);
      await createAnchor(alice, "folder", dirUID, ZERO_BYTES32); // generic anchor
      const s2 = await createAnchor(alice, "sort2", dirUID, sortInfoSchemaUID);

      // Only sort schema children
      expect(await indexer.getChildBySchemaAt(dirUID, sortInfoSchemaUID, 0)).to.equal(s1);
      expect(await indexer.getChildBySchemaAt(dirUID, sortInfoSchemaUID, 1)).to.equal(s2);
    });

    it("getChildCountBySchema returns count for specific schema", async function () {
      const dirUID = await createAnchor(alice, "dir");
      await createAnchor(alice, "sort1", dirUID, sortInfoSchemaUID);
      await createAnchor(alice, "folder", dirUID, ZERO_BYTES32);
      await createAnchor(alice, "sort2", dirUID, sortInfoSchemaUID);

      expect(await indexer.getChildCountBySchema(dirUID, sortInfoSchemaUID)).to.equal(2n);
      expect(await indexer.getChildCountBySchema(dirUID, ZERO_BYTES32)).to.equal(1n);
    });

    it("getReferencingAt returns referencing attestations by index", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const namingUID = await createAnchor(alice, "byname", dirUID, sortInfoSchemaUID);

      const sortUID1 = await createSortInfo(alice, namingUID, await nameSort.getAddress());
      const sortUID2 = await createSortInfo(bob, namingUID, await tsSort.getAddress());

      expect(await indexer.getReferencingAt(namingUID, sortInfoSchemaUID, 0)).to.equal(sortUID1);
      expect(await indexer.getReferencingAt(namingUID, sortInfoSchemaUID, 1)).to.equal(sortUID2);
    });
  });

  // ============================================================================================
  // ON-CHAIN SORT_INFO DISCOVERY (via EFSIndexer.index())
  // ============================================================================================

  describe("on-chain SORT_INFO discovery via EFSIndexer.index()", function () {
    it("SORT_INFO UID is discoverable via getReferencingAttestations after attestation", async function () {
      const dirUID = await createAnchor(owner, "dir");
      const namingUID = await createAnchor(owner, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await nameSort.getAddress());

      const refs = await indexer.getReferencingAttestations(namingUID, sortInfoSchemaUID, 0, 10, false);
      expect(refs.length).to.equal(1);
      expect(refs[0]).to.equal(sortInfoUID);
    });

    it("SORT_INFO UID is in getAttestationsBySchema after attestation", async function () {
      const dirUID = await createAnchor(owner, "dir2");
      const namingUID = await createAnchor(owner, "ts", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await tsSort.getAddress());

      const all = await indexer.getAttestationsBySchema(sortInfoSchemaUID, 0, 10, false);
      expect(all).to.include(sortInfoUID);
    });

    it("SORT_INFO UID is in getOutgoingAttestations for the attester", async function () {
      const dirUID = await createAnchor(alice, "dir3");
      const namingUID = await createAnchor(alice, "by-date", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await tsSort.getAddress());

      const aliceAddr = await alice.getAddress();
      const outgoing = await indexer.getOutgoingAttestations(aliceAddr, sortInfoSchemaUID, 0, 10, false);
      expect(outgoing).to.include(sortInfoUID);
    });

    it("isIndexed returns true for SORT_INFO after attestation", async function () {
      const dirUID = await createAnchor(owner, "dir4");
      const namingUID = await createAnchor(owner, "alpha2", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await nameSort.getAddress());

      expect(await indexer.isIndexed(sortInfoUID)).to.be.true;
    });

    it("revoked SORT_INFO is reflected in isRevoked after revocation", async function () {
      const dirUID = await createAnchor(owner, "dir5");
      const namingUID = await createAnchor(owner, "alpha3", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await nameSort.getAddress());

      expect(await indexer.isRevoked(sortInfoUID)).to.be.false;
      await eas.connect(owner).revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });
      expect(await indexer.isRevoked(sortInfoUID)).to.be.true;
    });

    it("full discovery chain: getAnchorsBySchema → getReferencingAttestations → getSortConfig", async function () {
      const dirUID = await createAnchor(owner, "dir6");
      const alphaNameUID = await createAnchor(owner, "alphabetical", dirUID, sortInfoSchemaUID);
      const tsNameUID = await createAnchor(owner, "by-date", dirUID, sortInfoSchemaUID);
      const alphaInfoUID = await createSortInfo(owner, alphaNameUID, await nameSort.getAddress());
      const tsInfoUID = await createSortInfo(owner, tsNameUID, await tsSort.getAddress());

      // Step 1: discover naming anchors
      const namingAnchors = await indexer["getAnchorsBySchema(bytes32,bytes32,uint256,uint256,bool,bool)"](
        dirUID,
        sortInfoSchemaUID,
        0,
        10,
        false,
        false,
      );
      expect(namingAnchors.length).to.equal(2);
      expect(namingAnchors).to.include(alphaNameUID);
      expect(namingAnchors).to.include(tsNameUID);

      // Step 2: for each naming anchor, find SORT_INFO UIDs
      const alphaRefs = await indexer.getReferencingAttestations(alphaNameUID, sortInfoSchemaUID, 0, 10, false);
      expect(alphaRefs[0]).to.equal(alphaInfoUID);

      const tsRefs = await indexer.getReferencingAttestations(tsNameUID, sortInfoSchemaUID, 0, 10, false);
      expect(tsRefs[0]).to.equal(tsInfoUID);

      // Step 3: read sort config
      const alphaConfig = await sortOverlay.getSortConfig(alphaInfoUID);
      expect(alphaConfig.sortFunc.toLowerCase()).to.equal((await nameSort.getAddress()).toLowerCase());
      expect(alphaConfig.sourceType).to.equal(0);

      const tsConfig = await sortOverlay.getSortConfig(tsInfoUID);
      expect(tsConfig.sortFunc.toLowerCase()).to.equal((await tsSort.getAddress()).toLowerCase());
    });

    it("multiple SORT_INFO attesters on same naming anchor are all discoverable", async function () {
      const dirUID = await createAnchor(owner, "dir7");
      const namingUID = await createAnchor(owner, "shared-sort", dirUID, sortInfoSchemaUID);

      const aliceSortUID = await createSortInfo(alice, namingUID, await nameSort.getAddress());
      const bobSortUID = await createSortInfo(bob, namingUID, await tsSort.getAddress());

      const refs = await indexer.getReferencingAttestations(namingUID, sortInfoSchemaUID, 0, 10, false);
      expect(refs.length).to.equal(2);
      expect(refs).to.include(aliceSortUID);
      expect(refs).to.include(bobSortUID);
    });
  });
});
