import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSListManager, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSListManager", function () {
  let listManager: EFSListManager;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let user1: Signer;
  let user2: Signer;

  let listInfoSchemaUID: string;
  let listItemSchemaUID: string;
  // A generic schema used to test targetSchemaUID enforcement
  let genericSchemaUID: string;

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

    // Determine future address of EFSListManager.
    // Deployment order:
    //   nonce+0: Register LIST_INFO schema
    //   nonce+1: Register LIST_ITEM schema
    //   nonce+2: Register generic schema (for targetSchemaUID tests)
    //   nonce+3: Deploy EFSListManager
    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureListManagerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 3 });

    // 2. Register schemas
    const tx1 = await registry.register(
      "uint8 listType, bytes32 targetSchemaUID",
      futureListManagerAddr,
      true,
    );
    const rc1 = await tx1.wait();
    listInfoSchemaUID = rc1!.logs[0].topics[1];

    const tx2 = await registry.register(
      "bytes32 itemUID, string fractionalIndex, bytes32 tags",
      futureListManagerAddr,
      true,
    );
    const rc2 = await tx2.wait();
    listItemSchemaUID = rc2!.logs[0].topics[1];

    // Generic schema used in targetSchemaUID enforcement tests
    const tx3 = await registry.register("string data", ZeroAddress, true);
    const rc3 = await tx3.wait();
    genericSchemaUID = rc3!.logs[0].topics[1];

    // 3. Deploy EFSListManager
    const LMFactory = await ethers.getContractFactory("EFSListManager");
    listManager = await LMFactory.deploy(await eas.getAddress(), listInfoSchemaUID, listItemSchemaUID);
    await listManager.waitForDeployment();

    expect(await listManager.getAddress()).to.equal(futureListManagerAddr);
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

  /** Encode LIST_INFO data (2-field schema: listType + targetSchemaUID) */
  const encodeListInfo = (listType = 0, targetSchemaUID = ZERO_BYTES32) =>
    ethers.AbiCoder.defaultAbiCoder().encode(["uint8", "bytes32"], [listType, targetSchemaUID]);

  const encodeListItem = (itemUID = ZERO_BYTES32, fractionalIndex = "", tags = ZERO_BYTES32) =>
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string", "bytes32"], [itemUID, fractionalIndex, tags]);

  /** Create a LIST_INFO attestation and return its UID. refUID can pin it to an Anchor. */
  const createList = async (
    signer: Signer,
    listType = 0,
    targetSchemaUID = ZERO_BYTES32,
    anchorUID = ZERO_BYTES32,
  ) => {
    const tx = await eas.connect(signer).attest({
      schema: listInfoSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: anchorUID,
        data: encodeListInfo(listType, targetSchemaUID),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a LIST_ITEM attestation and return its UID */
  const addItem = async (
    signer: Signer,
    listInfoUID: string,
    itemUID = ZERO_BYTES32,
    fractionalIndex = "",
    tags = ZERO_BYTES32,
  ) => {
    const tx = await eas.connect(signer).attest({
      schema: listItemSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: listInfoUID,
        data: encodeListItem(itemUID, fractionalIndex, tags),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Revoke a LIST_ITEM attestation */
  const removeItem = async (signer: Signer, listInfoUID: string, itemAttUID: string) => {
    const tx = await eas.connect(signer).revoke({ schema: listItemSchemaUID, data: { uid: itemAttUID, value: 0n } });
    await tx.wait();
  };

  /** Traverse the full list from head to tail and return UIDs in order */
  const traverseForward = async (listInfoUID: string, attester: string): Promise<string[]> => {
    const result: string[] = [];
    let cursor = await listManager.getListHead(listInfoUID, attester);
    while (cursor !== ZERO_BYTES32) {
      result.push(cursor);
      const node = await listManager.getNode(listInfoUID, attester, cursor);
      cursor = node.next;
    }
    return result;
  };

  /** Traverse the full list from tail to head and return UIDs in order */
  const traverseBackward = async (listInfoUID: string, attester: string): Promise<string[]> => {
    const result: string[] = [];
    let cursor = await listManager.getListTail(listInfoUID, attester);
    while (cursor !== ZERO_BYTES32) {
      result.push(cursor);
      const node = await listManager.getNode(listInfoUID, attester, cursor);
      cursor = node.prev;
    }
    return result;
  };

  // ============================================================================================
  // LIST CREATION
  // ============================================================================================

  describe("List creation (LIST_INFO)", function () {
    it("stores listType and targetSchemaUID metadata", async function () {
      const listUID = await createList(owner, 1, genericSchemaUID);

      expect(await listManager.getListType(listUID)).to.equal(1);
      expect(await listManager.getTargetSchema(listUID)).to.equal(genericSchemaUID);
    });

    it("initialises with empty head, tail, and length", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(ZERO_BYTES32);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(ZERO_BYTES32);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(0n);
    });
  });

  // ============================================================================================
  // ITEM INSERTION
  // ============================================================================================

  describe("Item insertion (LIST_ITEM)", function () {
    it("first item becomes both head and tail", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(item1);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(item1);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(1n);

      const node = await listManager.getNode(listUID, ownerAddr, item1);
      expect(node.prev).to.equal(ZERO_BYTES32);
      expect(node.next).to.equal(ZERO_BYTES32);
    });

    it("items append to tail in insertion order", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID, ZERO_BYTES32, "a0");
      const item2 = await addItem(owner, listUID, ZERO_BYTES32, "a1");
      const item3 = await addItem(owner, listUID, ZERO_BYTES32, "a2");

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(item1);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(item3);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(3n);

      const node1 = await listManager.getNode(listUID, ownerAddr, item1);
      expect(node1.prev).to.equal(ZERO_BYTES32);
      expect(node1.next).to.equal(item2);

      const node2 = await listManager.getNode(listUID, ownerAddr, item2);
      expect(node2.prev).to.equal(item1);
      expect(node2.next).to.equal(item3);

      const node3 = await listManager.getNode(listUID, ownerAddr, item3);
      expect(node3.prev).to.equal(item2);
      expect(node3.next).to.equal(ZERO_BYTES32);
    });

    it("forward and backward traversal produce consistent results", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);
      const item2 = await addItem(owner, listUID);
      const item3 = await addItem(owner, listUID);

      const forward = await traverseForward(listUID, ownerAddr);
      const backward = await traverseBackward(listUID, ownerAddr);

      expect(forward).to.deep.equal([item1, item2, item3]);
      expect(backward).to.deep.equal([item3, item2, item1]);
    });

    it("rejects LIST_ITEM when refUID does not point to a LIST_INFO", async function () {
      await expect(
        eas.attest({
          schema: listItemSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32, // not a LIST_INFO UID
            data: encodeListItem(),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });
  });

  // ============================================================================================
  // ITEM REMOVAL
  // ============================================================================================

  describe("Item removal (revocation)", function () {
    it("removing the only item empties the list", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);

      await removeItem(owner, listUID, item1);

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(ZERO_BYTES32);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(ZERO_BYTES32);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(0n);
    });

    it("removing the head updates head pointer correctly", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);
      const item2 = await addItem(owner, listUID);
      const item3 = await addItem(owner, listUID);

      await removeItem(owner, listUID, item1);

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(item2);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(item3);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(2n);

      const node2 = await listManager.getNode(listUID, ownerAddr, item2);
      expect(node2.prev).to.equal(ZERO_BYTES32);
      expect(node2.next).to.equal(item3);
    });

    it("removing the tail updates tail pointer correctly", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);
      const item2 = await addItem(owner, listUID);
      const item3 = await addItem(owner, listUID);

      await removeItem(owner, listUID, item3);

      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(item1);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(item2);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(2n);

      const node2 = await listManager.getNode(listUID, ownerAddr, item2);
      expect(node2.prev).to.equal(item1);
      expect(node2.next).to.equal(ZERO_BYTES32);
    });

    it("removing a middle item bridges neighbours correctly", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);
      const item2 = await addItem(owner, listUID);
      const item3 = await addItem(owner, listUID);

      await removeItem(owner, listUID, item2);

      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(2n);

      const node1 = await listManager.getNode(listUID, ownerAddr, item1);
      expect(node1.next).to.equal(item3);

      const node3 = await listManager.getNode(listUID, ownerAddr, item3);
      expect(node3.prev).to.equal(item1);
    });

    it("forward traversal is consistent after middle removal", async function () {
      const listUID = await createList(owner);
      const ownerAddr = await owner.getAddress();
      const item1 = await addItem(owner, listUID);
      const item2 = await addItem(owner, listUID);
      const item3 = await addItem(owner, listUID);
      const item4 = await addItem(owner, listUID);

      await removeItem(owner, listUID, item2);

      const forward = await traverseForward(listUID, ownerAddr);
      expect(forward).to.deep.equal([item1, item3, item4]);
    });
  });

  // ============================================================================================
  // PAGINATION (getSortedChunk)
  // ============================================================================================

  describe("getSortedChunk pagination", function () {
    let listUID: string;
    let ownerAddr: string;
    let items: string[];

    beforeEach(async function () {
      ownerAddr = await owner.getAddress();
      listUID = await createList(owner);
      items = [];
      for (let i = 0; i < 5; i++) {
        items.push(await addItem(owner, listUID));
      }
    });

    it("fetches first page from head with startNode=bytes32(0)", async function () {
      const [result, nextCursor] = await listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 3);
      expect(result).to.deep.equal([items[0], items[1], items[2]]);
      expect(nextCursor).to.equal(items[3]);
    });

    it("fetches next page using cursor from previous call", async function () {
      const [, cursor1] = await listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 3);
      const [result2, cursor2] = await listManager.getSortedChunk(listUID, ownerAddr, cursor1, 3);
      expect(result2).to.deep.equal([items[3], items[4]]);
      expect(cursor2).to.equal(ZERO_BYTES32); // end of list
    });

    it("returns all items when limit >= list length", async function () {
      const [result, nextCursor] = await listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 10);
      expect(result).to.deep.equal(items);
      expect(nextCursor).to.equal(ZERO_BYTES32);
    });

    it("returns empty array for empty list", async function () {
      const emptyListUID = await createList(owner);
      const [result, nextCursor] = await listManager.getSortedChunk(emptyListUID, ownerAddr, ZERO_BYTES32, 10);
      expect(result).to.deep.equal([]);
      expect(nextCursor).to.equal(ZERO_BYTES32);
    });

    it("returns limit=1 correctly", async function () {
      const [result, nextCursor] = await listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 1);
      expect(result).to.deep.equal([items[0]]);
      expect(nextCursor).to.equal(items[1]);
    });

    it("reverts when limit > MAX_PAGE_SIZE", async function () {
      await expect(listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 101)).to.be.reverted;
    });

    it("returns empty for revoked LIST_INFO", async function () {
      await eas.revoke({ schema: listInfoSchemaUID, data: { uid: listUID, value: 0n } });
      const [result] = await listManager.getSortedChunk(listUID, ownerAddr, ZERO_BYTES32, 10);
      expect(result).to.deep.equal([]);
    });
  });

  // ============================================================================================
  // MULTI-ATTESTER ISOLATION (EDITIONS MODEL)
  // ============================================================================================

  describe("Multi-attester isolation", function () {
    it("each attester has an independent linked list for the same LIST_INFO", async function () {
      const ownerAddr = await owner.getAddress();
      const user1Addr = await user1.getAddress();

      const listUID = await createList(owner);

      const ownerItem1 = await addItem(owner, listUID, ZERO_BYTES32, "o0");
      const ownerItem2 = await addItem(owner, listUID, ZERO_BYTES32, "o1");
      const user1Item1 = await addItem(user1, listUID, ZERO_BYTES32, "u0");
      const user1Item2 = await addItem(user1, listUID, ZERO_BYTES32, "u1");

      // Owner's list
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(2n);
      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(ownerItem1);
      expect(await listManager.getListTail(listUID, ownerAddr)).to.equal(ownerItem2);

      // User1's independent list
      expect(await listManager.getListLength(listUID, user1Addr)).to.equal(2n);
      expect(await listManager.getListHead(listUID, user1Addr)).to.equal(user1Item1);
      expect(await listManager.getListTail(listUID, user1Addr)).to.equal(user1Item2);
    });

    it("revoking an item from one attester does not affect another attester's list", async function () {
      const ownerAddr = await owner.getAddress();
      const user1Addr = await user1.getAddress();

      const listUID = await createList(owner);
      const ownerItem1 = await addItem(owner, listUID);
      const ownerItem2 = await addItem(owner, listUID);
      const user1Item1 = await addItem(user1, listUID);

      await removeItem(owner, listUID, ownerItem1);

      // Owner's list now has 1 item
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(1n);
      expect(await listManager.getListHead(listUID, ownerAddr)).to.equal(ownerItem2);

      // User1's list is unchanged
      expect(await listManager.getListLength(listUID, user1Addr)).to.equal(1n);
      expect(await listManager.getListHead(listUID, user1Addr)).to.equal(user1Item1);
    });

    it("getSortedChunk for user2 returns empty when user2 has no items", async function () {
      const user2Addr = await user2.getAddress();
      const listUID = await createList(owner);
      await addItem(owner, listUID); // owner adds an item

      const [result] = await listManager.getSortedChunk(listUID, user2Addr, ZERO_BYTES32, 10);
      expect(result).to.deep.equal([]);
    });
  });

  // ============================================================================================
  // SCHEMA ENFORCEMENT (targetSchemaUID)
  // ============================================================================================

  describe("targetSchemaUID enforcement", function () {
    it("rejects items whose itemUID schema does not match targetSchemaUID", async function () {
      // Create a list that only accepts 'genericSchemaUID' items
      const listUID = await createList(owner, 0, genericSchemaUID);

      // Create an attestation on a DIFFERENT schema to use as an item
      const wrongSchemaTx = await eas.attest({
        schema: listInfoSchemaUID, // using list info schema as a different schema
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: encodeListInfo(),
          value: 0n,
        },
      });
      const wrongItemUID = getUID(await wrongSchemaTx.wait());

      // Attempting to add it to the restricted list should revert
      await expect(addItem(owner, listUID, wrongItemUID)).to.be.reverted;
    });

    it("accepts items with itemUID=bytes32(0) on a restricted list (EFP address-based style)", async function () {
      const listUID = await createList(owner, 0, genericSchemaUID);
      const ownerAddr = await owner.getAddress();
      // itemUID = ZERO_BYTES32 bypasses the schema check (social graph / address list use case)
      const uid = await addItem(owner, listUID, ZERO_BYTES32);
      expect(uid).to.not.equal(ZERO_BYTES32);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(1n);
    });

    it("accepts any item when targetSchemaUID is bytes32(0)", async function () {
      const listUID = await createList(owner, 0, ZERO_BYTES32);
      const ownerAddr = await owner.getAddress();
      // Create an attestation on any schema
      const anyTx = await eas.attest({
        schema: genericSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: ZERO_BYTES32,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["hello"]),
          value: 0n,
        },
      });
      const anyItemUID = getUID(await anyTx.wait());
      const uid = await addItem(owner, listUID, anyItemUID);
      expect(uid).to.not.equal(ZERO_BYTES32);
      expect(await listManager.getListLength(listUID, ownerAddr)).to.equal(1n);
    });
  });

  // ============================================================================================
  // DISCOVERY: getListsByAnchor
  // ============================================================================================

  describe("getListsByAnchor discovery", function () {
    // Helper: create a real EAS attestation on the generic schema to use as a mock Anchor UID.
    // EAS validates that refUID points to an existing attestation, so we can't use a made-up UID.
    const createMockAnchor = async (signer: Signer): Promise<string> => {
      const tx = await eas.connect(signer).attest({
        schema: genericSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ZERO_BYTES32,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["anchor"]),
          value: 0n,
        },
      });
      return getUID(await tx.wait());
    };

    it("records a LIST_INFO when pinned to an anchor", async function () {
      const anchorUID = await createMockAnchor(owner);
      const listUID = await createList(owner, 0, ZERO_BYTES32, anchorUID);

      expect(await listManager.getListsByAnchorCount(anchorUID)).to.equal(1n);
      const lists = await listManager.getListsByAnchor(anchorUID, 0, 10);
      expect(lists).to.deep.equal([listUID]);
    });

    it("records multiple LIST_INFOs under the same anchor", async function () {
      const anchorUID = await createMockAnchor(owner);
      const list1 = await createList(owner, 0, ZERO_BYTES32, anchorUID);
      const list2 = await createList(user1, 1, ZERO_BYTES32, anchorUID);
      const list3 = await createList(user2, 0, ZERO_BYTES32, anchorUID);

      expect(await listManager.getListsByAnchorCount(anchorUID)).to.equal(3n);
      const lists = await listManager.getListsByAnchor(anchorUID, 0, 10);
      expect(lists).to.deep.equal([list1, list2, list3]);
    });

    it("paginates getListsByAnchor correctly", async function () {
      const anchorUID = await createMockAnchor(owner);
      const list1 = await createList(owner, 0, ZERO_BYTES32, anchorUID);
      const list2 = await createList(user1, 0, ZERO_BYTES32, anchorUID);
      const list3 = await createList(user2, 0, ZERO_BYTES32, anchorUID);

      const page1 = await listManager.getListsByAnchor(anchorUID, 0, 2);
      expect(page1).to.deep.equal([list1, list2]);

      const page2 = await listManager.getListsByAnchor(anchorUID, 2, 2);
      expect(page2).to.deep.equal([list3]);

      const empty = await listManager.getListsByAnchor(anchorUID, 10, 2);
      expect(empty).to.deep.equal([]);
    });

    it("does not record a LIST_INFO with no anchor (refUID=0)", async function () {
      const anchorUID = await createMockAnchor(owner);
      await createList(owner); // no anchor
      expect(await listManager.getListsByAnchorCount(anchorUID)).to.equal(0n);
    });

    it("does not duplicate the same LIST_INFO for the same anchor", async function () {
      const anchorUID = await createMockAnchor(owner);
      const listUID = await createList(owner, 0, ZERO_BYTES32, anchorUID);
      expect(await listManager.getListsByAnchorCount(anchorUID)).to.equal(1n);

      // A second list under the same anchor is a new UID — should increment normally
      await createList(user1, 0, ZERO_BYTES32, anchorUID);
      expect(await listManager.getListsByAnchorCount(anchorUID)).to.equal(2n);

      const lists = await listManager.getListsByAnchor(anchorUID, 0, 10);
      expect(lists[0]).to.equal(listUID); // first one is still at index 0
    });
  });

  // ============================================================================================
  // DISCOVERY: getListAttesters
  // ============================================================================================

  describe("getListAttesters discovery", function () {
    it("records attester on first item add", async function () {
      const ownerAddr = await owner.getAddress();
      const listUID = await createList(owner);
      await addItem(owner, listUID);

      expect(await listManager.getListAttesterCount(listUID)).to.equal(1n);
      const attesters = await listManager.getListAttesters(listUID, 0, 10);
      expect(attesters).to.deep.equal([ownerAddr]);
    });

    it("records each unique attester only once", async function () {
      const ownerAddr = await owner.getAddress();
      const listUID = await createList(owner);

      await addItem(owner, listUID);
      await addItem(owner, listUID); // same attester again
      await addItem(owner, listUID); // still same attester

      expect(await listManager.getListAttesterCount(listUID)).to.equal(1n);
      const attesters = await listManager.getListAttesters(listUID, 0, 10);
      expect(attesters).to.deep.equal([ownerAddr]);
    });

    it("records multiple distinct attesters", async function () {
      const ownerAddr = await owner.getAddress();
      const user1Addr = await user1.getAddress();
      const user2Addr = await user2.getAddress();
      const listUID = await createList(owner);

      await addItem(owner, listUID);
      await addItem(user1, listUID);
      await addItem(user2, listUID);

      expect(await listManager.getListAttesterCount(listUID)).to.equal(3n);
      const attesters = await listManager.getListAttesters(listUID, 0, 10);
      expect(attesters).to.deep.equal([ownerAddr, user1Addr, user2Addr]);
    });

    it("attester remains in list after their item is revoked (append-only)", async function () {
      const ownerAddr = await owner.getAddress();
      const listUID = await createList(owner);
      const item = await addItem(owner, listUID);

      await removeItem(owner, listUID, item);

      // Attester count stays at 1 — the discovery index is append-only
      expect(await listManager.getListAttesterCount(listUID)).to.equal(1n);
      const attesters = await listManager.getListAttesters(listUID, 0, 10);
      expect(attesters).to.deep.equal([ownerAddr]);
    });

    it("paginates getListAttesters correctly", async function () {
      const ownerAddr = await owner.getAddress();
      const user1Addr = await user1.getAddress();
      const user2Addr = await user2.getAddress();
      const listUID = await createList(owner);

      await addItem(owner, listUID);
      await addItem(user1, listUID);
      await addItem(user2, listUID);

      const page1 = await listManager.getListAttesters(listUID, 0, 2);
      expect(page1).to.deep.equal([ownerAddr, user1Addr]);

      const page2 = await listManager.getListAttesters(listUID, 2, 2);
      expect(page2).to.deep.equal([user2Addr]);

      const empty = await listManager.getListAttesters(listUID, 10, 2);
      expect(empty).to.deep.equal([]);
    });
  });

  // ============================================================================================
  // GAS INVARIANCE (O(1) insert regardless of list size)
  // ============================================================================================

  describe("Gas invariance", function () {
    it("insert gas cost is approximately constant for list sizes 1, 10, and 50", async function () {
      const listUID = await createList(owner);

      // Warm up — first item
      const tx1 = await eas.attest({
        schema: listItemSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: listUID,
          data: encodeListItem(),
          value: 0n,
        },
      });
      const rc1 = await tx1.wait();
      const gas1 = rc1!.gasUsed;

      // Build up to 9 more items (total = 10)
      for (let i = 1; i < 10; i++) await addItem(owner, listUID);

      // 11th item
      const tx11 = await eas.attest({
        schema: listItemSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: listUID,
          data: encodeListItem(),
          value: 0n,
        },
      });
      const rc11 = await tx11.wait();
      const gas11 = rc11!.gasUsed;

      // Build up to 50 total
      for (let i = 11; i < 50; i++) await addItem(owner, listUID);

      // 51st item
      const tx51 = await eas.attest({
        schema: listItemSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: listUID,
          data: encodeListItem(),
          value: 0n,
        },
      });
      const rc51 = await tx51.wait();
      const gas51 = rc51!.gasUsed;

      // Allow up to 15% variance from the first warm insert (storage slots warm after first write)
      const tolerance = gas1 / 7n; // ~15%
      expect(gas11).to.be.lte(gas1 + tolerance);
      expect(gas51).to.be.lte(gas1 + tolerance);
    });
  });
});
