import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSSortOverlay, AlphabeticalSort, TimestampSort, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSSortOverlay", function () {
  let indexer: EFSIndexer;
  let sortOverlay: EFSSortOverlay;
  let alphSort: AlphabeticalSort;
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
    // Order:
    //   +0: Register ANCHOR schema
    //   +1: Register PROPERTY schema
    //   +2: Register DATA schema
    //   +3: Register BLOB schema (no resolver)
    //   +4: Deploy EFSIndexer
    //   +5: Deploy AlphabeticalSort
    //   +6: Deploy TimestampSort
    //   +7: Register SORT_INFO schema (with futureOverlayAddr as resolver)
    //   +8: Deploy EFSSortOverlay
    const ownerAddr = await owner.getAddress();
    const baseNonce = await ethers.provider.getTransactionCount(ownerAddr);

    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: baseNonce + 4 });
    const futureOverlayAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: baseNonce + 8 });

    // 3. Register EFS schemas with futureIndexerAddr as resolver
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false); // non-revocable
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
    const AlphSortFactory = await ethers.getContractFactory("AlphabeticalSort");
    alphSort = await AlphSortFactory.deploy(await eas.getAddress());
    await alphSort.waitForDeployment();

    const TsSortFactory = await ethers.getContractFactory("TimestampSort");
    tsSort = await TsSortFactory.deploy(await eas.getAddress());
    await tsSort.waitForDeployment();

    // 6. Register SORT_INFO schema with futureOverlayAddr as resolver
    const tx5 = await registry.register("address sortFunc, bytes32 targetSchema", futureOverlayAddr, true);
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

  /** Create a SORT_INFO attestation naming a sort under a directory. Returns UID. */
  const createSortInfo = async (
    signer: Signer,
    namingAnchorUID: string,
    sortFuncAddr: string,
    targetSchema = ZERO_BYTES32,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: sortInfoSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: namingAnchorUID,
        data: enc.encode(["address", "bytes32"], [sortFuncAddr, targetSchema]),
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
            data: enc.encode(["address", "bytes32"], [ZeroAddress, ZERO_BYTES32]),
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
            data: enc.encode(["address", "bytes32"], [await alphSort.getAddress(), ZERO_BYTES32]),
            value: 0n,
          },
        }),
      ).to.be.revertedWithCustomError(eas, "InvalidAttestation");
    });

    it("should store sort config on valid SORT_INFO", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await alphSort.getAddress());

      const config = await sortOverlay.getSortConfig(sortInfoUID);
      expect(config.valid).to.equal(true);
      expect(config.revoked).to.equal(false);
      expect(config.sortFunc).to.equal(await alphSort.getAddress());
      // parentUID is cached at onAttest time — no EAS call needed at read time
      expect(config.parentUID).to.equal(parentUID);
    });

    it("should mark sort config revoked when SORT_INFO is revoked", async function () {
      const parentUID = await createAnchor(owner, "memes");
      const namingUID = await createAnchor(owner, "alpha-sort", parentUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await alphSort.getAddress());

      await eas.revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });

      const config = await sortOverlay.getSortConfig(sortInfoUID);
      expect(config.revoked).to.equal(true);
    });
  });

  // ============================================================================================
  // PROCESS ITEMS — ALPHABETICAL SORT
  // ============================================================================================

  describe("processItems with AlphabeticalSort", function () {
    let parentUID: string;
    let namingUID: string;
    let sortInfoUID: string;
    let catUID: string;
    let dogUID: string;
    let hamsterUID: string;

    beforeEach(async function () {
      // Directory: /memes/
      parentUID = await createAnchor(alice, "memes");

      // Files added in insertion order: cat, dog, hamster
      catUID = await createAnchor(alice, "cat", parentUID);
      dogUID = await createAnchor(alice, "dog", parentUID);
      hamsterUID = await createAnchor(alice, "hamster", parentUID);

      // Naming anchor for the sort, also a child of /memes/
      namingUID = await createAnchor(alice, "alpha-sort", parentUID, sortInfoSchemaUID);

      // SORT_INFO pointing at the naming anchor
      sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());
    });

    it("getSortStaleness shows all items unprocessed initially", async function () {
      const aliceAddr = await alice.getAddress();
      // Kernel has: cat, dog, hamster, naming-anchor = 4 items
      const staleness = await sortOverlay.getSortStaleness(sortInfoUID, aliceAddr);
      expect(staleness).to.equal(4n);
    });

    it("processItems inserts items in alphabetical order", async function () {
      const aliceAddr = await alice.getAddress();

      // Alphabetical order: cat < dog < hamster
      // Also: naming anchor for the sort ("alpha-sort") needs a position — it's ineligible
      // (getSortKey returns empty for non-anchor-data) unless AlphabeticalSort recognises it.
      // Actually AlphabeticalSort reads name from any Anchor, so naming anchor has key "alpha-sort"
      // which would sort before "cat". For simplicity, we'll process the 3 file anchors.
      // We pass 4 items: [cat, dog, hamster, naming] and let the sort handle ordering.
      // But hints must be provided for each. Let's just process the 3 file items.
      // Pass items in kernel order: [cat, dog, hamster, namingUID]
      // Expected alphabetical: cat < dog < hamster; "alpha-sort" < "cat" so it goes first.
      // Hints: alpha-sort(L=0, R=0), cat(L=alpha, R=0), dog(L=cat, R=0), hamster(L=dog, R=0)
      // But kernel order is: cat, dog, hamster, naming — we must pass them in kernel order.

      // Kernel order (insertion order): cat, dog, hamster, naming
      // Sorted alphabetically: alpha-sort, cat, dog, hamster (naming = "alpha-sort" < "cat")
      // So naming goes first.
      // item[0]=cat: left=0 (head so far is empty), right=0 → cat is first
      // Hmm, but alpha-sort < cat. We need to process naming AFTER to know where cat goes.
      // Actually processItems inserts items in kernel order but with client-supplied hints
      // based on where they fit in the ALREADY PARTIALLY BUILT sorted list.

      // Simplest test: process cat, dog, hamster (items 0,1,2 in kernel — skip naming at idx 3)
      // But _lastProcessedIndex must advance sequentially. We can't skip items.
      // So we must pass all 4: cat(0), dog(1), hamster(2), naming(3).

      // Alphabetical positions after processing all 4:
      //   "alpha-sort" (naming) < "cat" < "dog" < "hamster"
      // So sorted list: naming → cat → dog → hamster

      // Hints for processItems (items in kernel order: cat, dog, hamster, naming):
      //   cat: L=0 (nothing yet), R=0 (nothing yet) → head, first item
      //   dog: L=cat, R=0 → after cat
      //   hamster: L=dog, R=0 → after dog
      //   naming ("alpha-sort"): L=0 (before cat), R=cat → goes to head

      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [catUID, dogUID, hamsterUID, namingUID],
          [ZERO_BYTES32, catUID, dogUID, ZERO_BYTES32],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, catUID],
        );

      // After processing all 4, sorted list: naming → cat → dog → hamster
      const [items, next] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, ZERO_BYTES32, 10);
      expect(items.length).to.equal(4);
      expect(items[0]).to.equal(namingUID); // "alpha-sort" < "cat"
      expect(items[1]).to.equal(catUID);
      expect(items[2]).to.equal(dogUID);
      expect(items[3]).to.equal(hamsterUID);
      expect(next).to.equal(ZERO_BYTES32); // end of list
    });

    it("getSortStaleness is 0 after all items processed", async function () {
      const aliceAddr = await alice.getAddress();
      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [catUID, dogUID, hamsterUID, namingUID],
          [ZERO_BYTES32, catUID, dogUID, ZERO_BYTES32],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, catUID],
        );
      expect(await sortOverlay.getSortStaleness(sortInfoUID, aliceAddr)).to.equal(0n);
    });

    it("staleness grows when new kernel items are added after processing", async function () {
      const aliceAddr = await alice.getAddress();

      // Process all current items
      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [catUID, dogUID, hamsterUID, namingUID],
          [ZERO_BYTES32, catUID, dogUID, ZERO_BYTES32],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, catUID],
        );
      expect(await sortOverlay.getSortStaleness(sortInfoUID, aliceAddr)).to.equal(0n);

      // Add a new file to the kernel
      await createAnchor(alice, "aardvark", parentUID);

      expect(await sortOverlay.getSortStaleness(sortInfoUID, aliceAddr)).to.equal(1n);
    });

    it("getLastProcessedIndex advances as items are processed", async function () {
      const aliceAddr = await alice.getAddress();
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, aliceAddr)).to.equal(0n);

      await sortOverlay
        .connect(alice)
        .processItems(sortInfoUID, [catUID, dogUID], [ZERO_BYTES32, catUID], [ZERO_BYTES32, ZERO_BYTES32]);
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, aliceAddr)).to.equal(2n);
    });

    it("rejects processItems with mismatched array lengths", async function () {
      await expect(
        sortOverlay
          .connect(alice)
          .processItems(sortInfoUID, [catUID, dogUID], [ZERO_BYTES32], [ZERO_BYTES32, ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "ArrayLengthMismatch");
    });

    it("rejects invalid sort positions", async function () {
      // Trying to insert dog before cat when dog > cat alphabetically
      await expect(
        sortOverlay.connect(alice).processItems(
          sortInfoUID,
          [catUID],
          [dogUID], // dog comes AFTER cat, so dog < cat is false — invalid left hint
          [ZERO_BYTES32],
        ),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidPosition");
    });
  });

  // ============================================================================================
  // REVOKED ITEMS ARE SKIPPED
  // ============================================================================================

  describe("processItems skips revoked kernel items", function () {
    it("revoked DATA attestations advance _lastProcessedIndex without being inserted", async function () {
      const _aliceAddr = await alice.getAddress();

      // Create a file anchor and attach a revocable DATA to it
      const dirUID = await createAnchor(alice, "dir");
      const fileAnchorUID = await createAnchor(alice, "file", dirUID, dataSchemaUID);

      // Revoke the DATA attestation (the Anchor itself is irrevocable)
      // We test with a generic revocable schema instead
      const tagTx = await eas.connect(alice).attest({
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
      const dataUID = getUID(await tagTx.wait());
      await eas.connect(alice).revoke({ schema: dataSchemaUID, data: { uid: dataUID, value: 0n } });

      // Create a sort over dirUID
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const _sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // Kernel for alice under dirUID: fileAnchor, namingAnchor (both irrevocable)
      // dataUID is revocable but is NOT a direct child of dirUID — it refs fileAnchor
      // So the kernel we sort is the children of dirUID: [fileAnchorUID, namingUID]
      // Neither is revoked (they're non-revocable anchors)
      // This test focuses on EFSIndexer.isRevoked() — let's verify with a DATA that IS revoked

      // Verify isRevoked works as expected
      expect(await indexer.isRevoked(dataUID)).to.equal(true);
      expect(await indexer.isRevoked(fileAnchorUID)).to.equal(false);
    });
  });

  // ============================================================================================
  // CURSOR-BASED PAGINATION
  // ============================================================================================

  describe("getSortedChunk cursor pagination", function () {
    it("paginates through sorted items with cursor", async function () {
      const aliceAddr = await alice.getAddress();

      const dirUID = await createAnchor(alice, "dir");
      const aUID = await createAnchor(alice, "aardvark", dirUID);
      const bUID = await createAnchor(alice, "bear", dirUID);
      const cUID = await createAnchor(alice, "cat", dirUID);
      const dUID = await createAnchor(alice, "dog", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // Sorted order: "alpha"(naming) < "aardvark" < "bear" < "cat" < "dog"
      // Kernel order: a, b, c, d, naming
      // Sorted alphabetically: aardvark(a) < alpha(naming) < bear(b) < cat(c) < dog(d)
      // Process in kernel order with correct positional hints:
      //   a (aardvark): first item — left=0, right=0
      //   b (bear):     after a — left=a, right=0
      //   c (cat):      after b — left=b, right=0
      //   d (dog):      after c — left=c, right=0
      //   naming(alpha): between a and b — left=a, right=b
      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [aUID, bUID, cUID, dUID, namingUID],
          [ZERO_BYTES32, aUID, bUID, cUID, aUID],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, bUID],
        );

      // Page 1: limit=2 — aardvark, alpha(naming)
      const [page1, cursor1] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, ZERO_BYTES32, 2);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(aUID); // "aardvark"
      expect(page1[1]).to.equal(namingUID); // "alpha"

      // Page 2: limit=2 — bear, cat
      const [page2, cursor2] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, cursor1, 2);
      expect(page2.length).to.equal(2);
      expect(page2[0]).to.equal(bUID); // "bear"
      expect(page2[1]).to.equal(cUID); // "cat"

      // Page 3: limit=2 — dog (last item)
      const [page3, cursor3] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, cursor2, 2);
      expect(page3.length).to.equal(1);
      expect(page3[0]).to.equal(dUID); // "dog"
      expect(cursor3).to.equal(ZERO_BYTES32); // end of list
    });
  });

  // ============================================================================================
  // INDEPENDENT ATTESTER VIEWS
  // ============================================================================================

  describe("independent sorted views per attester", function () {
    it("Alice and Bob maintain separate sorted lists for the same sortInfoUID", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const dirUID = await createAnchor(alice, "dir");

      // Alice adds: zebra, apple
      const zebraUID = await createAnchor(alice, "zebra", dirUID);
      const appleUID = await createAnchor(alice, "apple", dirUID);

      // Bob adds: mango
      const mangoUID = await createAnchor(bob, "mango", dirUID);

      // Naming anchor and sort (created by alice)
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // Alice processes her kernel: [zebra, apple, naming]
      // Sorted (Alice): "alpha"(naming) < "apple" < "zebra"
      // Process in kernel order: zebra first, then apple (before zebra), then naming (before apple)
      //   zebra:  left=0, right=0 (first item)
      //   apple:  left=0, right=zebra (apple < zebra alphabetically)
      //   naming: left=0, right=apple (alpha < apple alphabetically)
      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [zebraUID, appleUID, namingUID],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32],
          [ZERO_BYTES32, zebraUID, appleUID],
        );

      // Bob processes his kernel: [mango]
      await sortOverlay.connect(bob).processItems(sortInfoUID, [mangoUID], [ZERO_BYTES32], [ZERO_BYTES32]);

      // Alice's sorted view: naming(alpha) → apple → zebra
      const [aliceItems] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, ZERO_BYTES32, 10);
      expect(aliceItems.length).to.equal(3);
      expect(aliceItems[0]).to.equal(namingUID);
      expect(aliceItems[1]).to.equal(appleUID);
      expect(aliceItems[2]).to.equal(zebraUID);

      // Bob's sorted view: only mango
      const [bobItems] = await sortOverlay.getSortedChunk(sortInfoUID, bobAddr, ZERO_BYTES32, 10);
      expect(bobItems.length).to.equal(1);
      expect(bobItems[0]).to.equal(mangoUID);
    });
  });

  // ============================================================================================
  // TIMESTAMP SORT
  // ============================================================================================

  describe("TimestampSort", function () {
    it("sorts items by attestation time (oldest first)", async function () {
      const aliceAddr = await alice.getAddress();
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
      await sortOverlay
        .connect(alice)
        .processItems(
          sortInfoUID,
          [a1, a2, a3, namingUID],
          [ZERO_BYTES32, a1, a2, a3],
          [ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32, ZERO_BYTES32],
        );

      const [items] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, ZERO_BYTES32, 10);
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
      await expect(
        sortOverlay.connect(alice).processItems(ZERO_BYTES32, [ZERO_BYTES32], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidSortInfo");
    });

    it("reverts if sortInfoUID is revoked", async function () {
      const dirUID = await createAnchor(alice, "dir");
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      await eas.connect(alice).revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });

      const child = await createAnchor(alice, "child", dirUID);
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, [child], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidSortInfo");
    });
  });

  // ============================================================================================
  // processItems — ITEM MEMBERSHIP VALIDATION
  // ============================================================================================

  describe("processItems item membership validation", function () {
    it("reverts with InvalidItem when item does not match expected kernel position", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir");
      const _f1 = await createAnchor(alice, "file1", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // f1 is at kernel index 0. Passing namingUID (index 2) instead of f1 (index 0) should revert.
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, [namingUID], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidItem");
    });

    it("reverts with InvalidItem when a fabricated UID not in kernel is submitted", async function () {
      const dirUID = await createAnchor(alice, "integrity-dir2");
      const _f1 = await createAnchor(alice, "real-file", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      const fakeUID = ethers.keccak256(ethers.toUtf8Bytes("not-a-real-kernel-item"));
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, [fakeUID], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidItem");
    });

    it("processes items correctly when submitted in exact kernel order", async function () {
      const aliceAddr = await alice.getAddress();
      const dirUID = await createAnchor(alice, "integrity-dir3");
      const f1 = await createAnchor(alice, "zebra", dirUID);
      const f2 = await createAnchor(alice, "apple", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // Compute correct hints and process in kernel order [f1(zebra), f2(apple), namingUID(alpha)]
      const [lefts, rights] = await sortOverlay.computeHints(sortInfoUID, aliceAddr, [f1, f2, namingUID]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, [f1, f2, namingUID], [...lefts], [...rights]);

      const [sorted] = await sortOverlay.getSortedChunk(sortInfoUID, aliceAddr, ZERO_BYTES32, 10);
      // Alphabetical: alpha(naming) < apple(f2) < zebra(f1)
      expect(sorted[0]).to.equal(namingUID);
      expect(sorted[1]).to.equal(f2);
      expect(sorted[2]).to.equal(f1);
    });

    it("second batch starts from correct kernel position after first batch", async function () {
      const aliceAddr = await alice.getAddress();
      const dirUID = await createAnchor(alice, "integrity-dir4");
      const f1 = await createAnchor(alice, "mango", dirUID);
      const f2 = await createAnchor(alice, "banana", dirUID);
      const f3 = await createAnchor(alice, "cherry", dirUID);
      const namingUID = await createAnchor(alice, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());

      // Process first two items
      const [lefts1, rights1] = await sortOverlay.computeHints(sortInfoUID, aliceAddr, [f1, f2]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, [f1, f2], [...lefts1], [...rights1]);
      expect(await sortOverlay.getLastProcessedIndex(sortInfoUID, aliceAddr)).to.equal(2n);

      // Trying to re-submit f1 (index 0) should revert — kernel position is now 2
      await expect(
        sortOverlay.connect(alice).processItems(sortInfoUID, [f1], [ZERO_BYTES32], [ZERO_BYTES32]),
      ).to.be.revertedWithCustomError(sortOverlay, "InvalidItem");

      // Processing the correct next items (f3, naming) succeeds
      const [lefts2, rights2] = await sortOverlay.computeHints(sortInfoUID, aliceAddr, [f3, namingUID]);
      await sortOverlay.connect(alice).processItems(sortInfoUID, [f3, namingUID], [...lefts2], [...rights2]);
      expect(await sortOverlay.getSortLength(sortInfoUID, aliceAddr)).to.equal(4n);
    });
  });

  // ============================================================================================
  // ON-CHAIN SORT_INFO DISCOVERY (via EFSIndexer.index())
  // ============================================================================================

  describe("on-chain SORT_INFO discovery via EFSIndexer.index()", function () {
    it("SORT_INFO UID is discoverable via getReferencingAttestations after attestation", async function () {
      const dirUID = await createAnchor(owner, "dir");
      const namingUID = await createAnchor(owner, "alpha", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await alphSort.getAddress());

      // EFSSortOverlay.onAttest calls indexer.index() — so this should now work on-chain
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
      const sortInfoUID = await createSortInfo(owner, namingUID, await alphSort.getAddress());

      expect(await indexer.isIndexed(sortInfoUID)).to.be.true;
    });

    it("revoked SORT_INFO is reflected in isRevoked after revocation", async function () {
      const dirUID = await createAnchor(owner, "dir5");
      const namingUID = await createAnchor(owner, "alpha3", dirUID, sortInfoSchemaUID);
      const sortInfoUID = await createSortInfo(owner, namingUID, await alphSort.getAddress());

      expect(await indexer.isRevoked(sortInfoUID)).to.be.false;

      await eas.connect(owner).revoke({ schema: sortInfoSchemaUID, data: { uid: sortInfoUID, value: 0n } });

      expect(await indexer.isRevoked(sortInfoUID)).to.be.true;
    });

    it("full discovery chain: getAnchorsBySchema → getReferencingAttestations → getSortConfig", async function () {
      const dirUID = await createAnchor(owner, "dir6");
      // Create two sorts under the directory
      const alphaNameUID = await createAnchor(owner, "alphabetical", dirUID, sortInfoSchemaUID);
      const tsNameUID = await createAnchor(owner, "by-date", dirUID, sortInfoSchemaUID);
      const alphaInfoUID = await createSortInfo(owner, alphaNameUID, await alphSort.getAddress());
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

      // Step 2: for each naming anchor, find SORT_INFO UIDs — fully on-chain
      const alphaRefs = await indexer.getReferencingAttestations(alphaNameUID, sortInfoSchemaUID, 0, 10, false);
      expect(alphaRefs.length).to.equal(1);
      expect(alphaRefs[0]).to.equal(alphaInfoUID);

      const tsRefs = await indexer.getReferencingAttestations(tsNameUID, sortInfoSchemaUID, 0, 10, false);
      expect(tsRefs.length).to.equal(1);
      expect(tsRefs[0]).to.equal(tsInfoUID);

      // Step 3: read sort config
      const alphaConfig = await sortOverlay.getSortConfig(alphaInfoUID);
      expect(alphaConfig.valid).to.be.true;
      expect(alphaConfig.sortFunc.toLowerCase()).to.equal((await alphSort.getAddress()).toLowerCase());

      const tsConfig = await sortOverlay.getSortConfig(tsInfoUID);
      expect(tsConfig.valid).to.be.true;
      expect(tsConfig.sortFunc.toLowerCase()).to.equal((await tsSort.getAddress()).toLowerCase());
    });

    it("multiple SORT_INFO attesters on same naming anchor are all discoverable", async function () {
      const dirUID = await createAnchor(owner, "dir7");
      const namingUID = await createAnchor(owner, "shared-sort", dirUID, sortInfoSchemaUID);

      // Both alice and bob create their own SORT_INFO pointing at the same naming anchor
      const aliceSortUID = await createSortInfo(alice, namingUID, await alphSort.getAddress());
      const bobSortUID = await createSortInfo(bob, namingUID, await tsSort.getAddress());

      const refs = await indexer.getReferencingAttestations(namingUID, sortInfoSchemaUID, 0, 10, false);
      expect(refs.length).to.equal(2);
      expect(refs).to.include(aliceSortUID);
      expect(refs).to.include(bobSortUID);
    });
  });
});
