import { expect } from "chai";
import { ethers } from "hardhat";
import { TagResolver, EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

/**
 * Integration tests for Tags + Editions.
 *
 * Core invariant: tags target specific DATA UIDs, not anchor UIDs.
 * Two users sharing the same file anchor have independent DATA attestations.
 * Tagging userA's DATA should never affect userB's edition and vice versa.
 *
 * The frontend filter logic should be:
 *   1. Determine the viewing edition's attester(s) — editionAddresses or connectedAddress
 *   2. For each file item, call getDataByAddressList(anchorUID, [attester]) → dataUID
 *   3. Check if dataUID is in getTaggedTargets(definition) → show/hide
 */
describe("Tags with Editions (Integration)", function () {
  let tagResolver: TagResolver;
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let userA: Signer;
  let userB: Signer;
  let userC: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let blobSchemaUID: string;
  let tagSchemaUID: string;

  let rootUID: string;
  let tagsAnchorUID: string;

  const enc = new ethers.AbiCoder();

  // ─── Deployment ─────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, userA, userB, userC] = await ethers.getSigners();

    // Deploy SchemaRegistry and EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Deploy TagResolver — pre-compute both addresses before deployment.
    // Deploy order from resolverNonce:
    //   +0: TagResolver
    //   +1: ANCHOR schema  (resolver = futureIndexer)
    //   +2: PROPERTY schema (resolver = futureIndexer)
    //   +3: DATA schema     (resolver = futureIndexer)
    //   +4: BLOB schema     (resolver = ZeroAddress)
    //   +5: TAG schema      (resolver = tagResolver)
    //   +6: Deploy EFSIndexer
    const ownerAddr = await owner.getAddress();
    const resolverNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const futureTagResolverAddress = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: resolverNonce + 6 });
    const precomputedTagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, bool applies", futureTagResolverAddress, true],
    );

    const TagResolverFactory = await ethers.getContractFactory("TagResolver");
    tagResolver = await TagResolverFactory.deploy(
      await eas.getAddress(),
      precomputedTagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );
    await tagResolver.waitForDeployment();

    // Register schemas
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, true);
    anchorSchemaUID = (await tx1.wait())!.logs[0].topics[1];

    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    propertySchemaUID = (await tx2.wait())!.logs[0].topics[1];

    const tx3 = await registry.register("string uri, string contentType, string fileMode", futureIndexerAddr, true);
    dataSchemaUID = (await tx3.wait())!.logs[0].topics[1];

    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    blobSchemaUID = (await tx4.wait())!.logs[0].topics[1];

    const tx5 = await registry.register("bytes32 definition, bool applies", await tagResolver.getAddress(), true);
    tagSchemaUID = (await tx5.wait())!.logs[0].topics[1];

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

    // Create root anchor
    rootUID = await createAnchor(owner, ZERO_BYTES32, "root");
    expect(await indexer.rootAnchorUID()).to.equal(rootUID);

    // Create "tags" folder under root
    tagsAnchorUID = await createAnchor(owner, rootUID, "tags");
  });

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("No Attested event found");
  };

  /** Create a generic (folder) anchor under a parent. schemaUID = 0. */
  const createAnchor = async (signer: Signer, parentUID: string, name: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a data-type anchor (file) under a parent. schemaUID = dataSchemaUID. */
  const createFileAnchor = async (signer: Signer, parentUID: string, name: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, dataSchemaUID]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Attach DATA to a file anchor (creates an edition). */
  const createData = async (signer: Signer, anchorUID: string, content: string = "test"): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: anchorUID,
        data: enc.encode(["string", "string", "string"], [`web3://${content}`, "text/plain", "file"]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Create a tag definition anchor under the "tags" folder. */
  const createTagDef = async (name: string): Promise<string> => {
    return createAnchor(owner, tagsAnchorUID, name);
  };

  /** Tag a target UID (DATA or anchor) with a definition. */
  const tagTarget = async (
    signer: Signer,
    targetUID: string,
    definitionUID: string,
    applies: boolean = true,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: enc.encode(["bytes32", "bool"], [definitionUID, applies]),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  };

  /** Revoke a tag attestation. */
  const revokeTag = async (signer: Signer, tagUID: string): Promise<void> => {
    const tx = await eas.connect(signer).revoke({ schema: tagSchemaUID, data: { uid: tagUID, value: 0n } });
    await tx.wait();
  };

  /**
   * Simulate the frontend tag filter for one item:
   * "Given an anchor, edition attester(s), and a set of tagged DATA UIDs,
   *  does this item match the filter?"
   *
   * Returns true if any of the edition attesters' DATA UID is in the tagged set.
   */
  const simulateTagFilter = async (
    anchorUID: string,
    editionAttesters: string[],
    taggedDataUIDs: Set<string>,
  ): Promise<boolean> => {
    for (const attester of editionAttesters) {
      const dataUID = await indexer.getDataByAddressList(anchorUID, [attester], false);
      if (dataUID !== ZERO_BYTES32 && taggedDataUIDs.has(dataUID.toLowerCase())) {
        return true;
      }
    }
    return false;
  };

  /** Fetch all tagged target UIDs for a definition into a Set (lowercased). Append-only. */
  const getTaggedTargetSet = async (definitionUID: string): Promise<Set<string>> => {
    const count = await tagResolver.getTaggedTargetCount(definitionUID);
    if (count === 0n) return new Set();
    const targets = await tagResolver.getTaggedTargets(definitionUID, 0n, count);
    return new Set(targets.map((t: string) => t.toLowerCase()));
  };

  /**
   * Like getTaggedTargetSet but filters to only currently-active tags using isActivelyTagged.
   * Mirrors the new frontend behaviour (FileBrowser step 4).
   */
  const getActivelyTaggedSet = async (definitionUID: string): Promise<Set<string>> => {
    const count = await tagResolver.getTaggedTargetCount(definitionUID);
    if (count === 0n) return new Set();
    const targets = await tagResolver.getTaggedTargets(definitionUID, 0n, count);
    const active = new Set<string>();
    for (const target of targets) {
      if (await tagResolver.isActivelyTagged(target, definitionUID)) {
        active.add(target.toLowerCase());
      }
    }
    return active;
  };

  // ─── Tests ──────────────────────────────────────────────────────────────────

  describe("Edition DATA UID isolation", function () {
    it("Two users attaching DATA to the same anchor get distinct DATA UIDs", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "test.txt");
      const dataA = await createData(userA, fileAnchor, "contentA");
      const dataB = await createData(userB, fileAnchor, "contentB");

      expect(dataA).to.not.equal(dataB);
      expect(dataA).to.not.equal(ZERO_BYTES32);
      expect(dataB).to.not.equal(ZERO_BYTES32);
    });

    it("getDataByAddressList returns the correct DATA UID per user", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "shared.txt");
      const dataA = await createData(userA, fileAnchor, "A-content");
      const dataB = await createData(userB, fileAnchor, "B-content");

      const addrA = await userA.getAddress();
      const addrB = await userB.getAddress();
      const addrC = await userC.getAddress();

      expect(await indexer.getDataByAddressList(fileAnchor, [addrA], false)).to.equal(dataA);
      expect(await indexer.getDataByAddressList(fileAnchor, [addrB], false)).to.equal(dataB);
      // User C has no DATA for this anchor
      expect(await indexer.getDataByAddressList(fileAnchor, [addrC], false)).to.equal(ZERO_BYTES32);
    });

    it("Three users each get independent DATA UIDs for the same anchor", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "triple.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const dataB = await createData(userB, fileAnchor, "B");
      const dataC = await createData(userC, fileAnchor, "C");

      expect(new Set([dataA, dataB, dataC]).size).to.equal(3);
    });

    it("A user uploading a second version keeps the latest as the active DATA", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "versioned.txt");
      const dataV1 = await createData(userA, fileAnchor, "version1");
      const dataV2 = await createData(userA, fileAnchor, "version2");

      const addrA = await userA.getAddress();
      // getDataByAddressList returns the most recent non-revoked DATA
      expect(await indexer.getDataByAddressList(fileAnchor, [addrA], false)).to.equal(dataV2);
      expect(dataV1).to.not.equal(dataV2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Tags target specific DATA UIDs, not anchor UIDs", function () {
    it("Tagging DATA_A does NOT tag DATA_B for the same anchor", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "shared.txt");
      const dataA = await createData(userA, fileAnchor, "A-content");
      const dataB = await createData(userB, fileAnchor, "B-content");
      const nsfwDef = await createTagDef("nsfw");

      await tagTarget(userA, dataA, nsfwDef, true);

      const targets = await getTaggedTargetSet(nsfwDef);
      expect(targets.has(dataA.toLowerCase())).to.be.true;
      expect(targets.has(dataB.toLowerCase())).to.be.false;
    });

    it("Tagging DATA_B does NOT tag DATA_A for the same anchor", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "other.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const dataB = await createData(userB, fileAnchor, "B");
      const favDef = await createTagDef("favorites");

      await tagTarget(userB, dataB, favDef, true);

      const targets = await getTaggedTargetSet(favDef);
      expect(targets.has(dataB.toLowerCase())).to.be.true;
      expect(targets.has(dataA.toLowerCase())).to.be.false;
    });

    it("Tags on a DATA UID are independent from tags on its anchor UID", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "dual.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const importantDef = await createTagDef("important");
      const nsfwDef = await createTagDef("nsfw");

      // Tag the anchor itself (folder-level concept)
      await tagTarget(owner, fileAnchor, importantDef, true);
      // Tag the DATA (edition-specific)
      await tagTarget(userA, dataA, nsfwDef, true);

      const importantTargets = await getTaggedTargetSet(importantDef);
      const nsfwTargets = await getTaggedTargetSet(nsfwDef);

      // "important" is on the anchor UID, not the data UID
      expect(importantTargets.has(fileAnchor.toLowerCase())).to.be.true;
      expect(importantTargets.has(dataA.toLowerCase())).to.be.false;

      // "nsfw" is on the data UID, not the anchor UID
      expect(nsfwTargets.has(dataA.toLowerCase())).to.be.true;
      expect(nsfwTargets.has(fileAnchor.toLowerCase())).to.be.false;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Edition-filtered tag matching (core bug scenario)", function () {
    let fileAnchor: string;
    let dataA: string;
    let dataB: string;
    let nsfwDef: string;
    let addrA: string;
    let addrB: string;
    let addrC: string;

    beforeEach(async function () {
      fileAnchor = await createFileAnchor(userA, rootUID, "test.txt");
      dataA = await createData(userA, fileAnchor, "userA-content");
      dataB = await createData(userB, fileAnchor, "userB-content");
      nsfwDef = await createTagDef("nsfw");
      addrA = await userA.getAddress();
      addrB = await userB.getAddress();
      addrC = await userC.getAddress();

      // User A tags their DATA as nsfw
      await tagTarget(userA, dataA, nsfwDef, true);
    });

    it("Viewing User A's edition with 'nsfw' filter → match (DATA_A is tagged)", async function () {
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const matches = await simulateTagFilter(fileAnchor, [addrA], taggedSet);
      expect(matches).to.be.true;
    });

    it("Viewing User B's edition with 'nsfw' filter → NO match (DATA_B is not tagged)", async function () {
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const matches = await simulateTagFilter(fileAnchor, [addrB], taggedSet);
      expect(matches).to.be.false;
    });

    it("Viewing User C's edition (no DATA) with 'nsfw' filter → NO match", async function () {
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const matches = await simulateTagFilter(fileAnchor, [addrC], taggedSet);
      expect(matches).to.be.false;
    });

    it("Viewing multiple editions [A, B] with 'nsfw' filter → match (at least one matches)", async function () {
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const matches = await simulateTagFilter(fileAnchor, [addrA, addrB], taggedSet);
      expect(matches).to.be.true;
    });

    it("Viewing multiple editions [B, C] with 'nsfw' filter → NO match (neither tagged)", async function () {
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const matches = await simulateTagFilter(fileAnchor, [addrB, addrC], taggedSet);
      expect(matches).to.be.false;
    });

    it("User B views User A's edition — should see nsfw tag because DATA_A is tagged", async function () {
      // This is the key scenario: User B is browsing, but viewing User A's edition.
      // editions=[addrA] → getDataByAddressList(anchor, [addrA]) → dataA → tagged → show
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const dataForEdition = await indexer.getDataByAddressList(fileAnchor, [addrA], false);
      expect(dataForEdition).to.equal(dataA);
      expect(taggedSet.has(dataForEdition.toLowerCase())).to.be.true;
    });

    it("User B views own edition — should NOT see nsfw filter match", async function () {
      // User B browsing their own files: editions=[addrB] → dataB → not tagged → hide
      const taggedSet = await getTaggedTargetSet(nsfwDef);
      const dataForEdition = await indexer.getDataByAddressList(fileAnchor, [addrB], false);
      expect(dataForEdition).to.equal(dataB);
      expect(taggedSet.has(dataForEdition.toLowerCase())).to.be.false;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Independent tagging across editions", function () {
    it("Different tags on different editions are isolated", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "multi-tag.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const dataB = await createData(userB, fileAnchor, "B");
      const nsfwDef = await createTagDef("nsfw");
      const favDef = await createTagDef("favorites");
      const addrA = await userA.getAddress();
      const addrB = await userB.getAddress();

      // User A tags their DATA as "nsfw"
      await tagTarget(userA, dataA, nsfwDef, true);
      // User B tags their DATA as "favorites"
      await tagTarget(userB, dataB, favDef, true);

      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      const favSet = await getTaggedTargetSet(favDef);

      // Filter "nsfw" + edition=A → match
      expect(await simulateTagFilter(fileAnchor, [addrA], nsfwSet)).to.be.true;
      // Filter "nsfw" + edition=B → no match
      expect(await simulateTagFilter(fileAnchor, [addrB], nsfwSet)).to.be.false;
      // Filter "favorites" + edition=A → no match
      expect(await simulateTagFilter(fileAnchor, [addrA], favSet)).to.be.false;
      // Filter "favorites" + edition=B → match
      expect(await simulateTagFilter(fileAnchor, [addrB], favSet)).to.be.true;
    });

    it("Same user tagging same DATA with multiple definitions", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "multi-def.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw2");
      const favDef = await createTagDef("fav2");

      await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userA, dataA, favDef, true);

      // DATA_A should appear in both tag sets
      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      const favSet = await getTaggedTargetSet(favDef);
      expect(nsfwSet.has(dataA.toLowerCase())).to.be.true;
      expect(favSet.has(dataA.toLowerCase())).to.be.true;

      // getTagDefinitions for DATA_A should list both
      const defCount = await tagResolver.getTagDefinitionCount(dataA);
      expect(defCount).to.equal(2n);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Cross-user tagging", function () {
    it("User B can tag User A's DATA (e.g. 'I think A's version is nsfw')", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "cross.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw3");
      const addrA = await userA.getAddress();
      const addrB = await userB.getAddress();

      // User B tags User A's DATA
      const tagUID = await tagTarget(userB, dataA, nsfwDef, true);

      // The tag is recorded under User B as the attester
      expect(await tagResolver.getActiveTagUID(addrB, dataA, nsfwDef)).to.equal(tagUID);

      // User A didn't tag it, so no active tag under A
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(ZERO_BYTES32);

      // But DATA_A IS in the tagged targets set (regardless of who tagged it)
      const targets = await getTaggedTargetSet(nsfwDef);
      expect(targets.has(dataA.toLowerCase())).to.be.true;

      // Viewing User A's edition with "nsfw" filter → match (DATA_A is tagged)
      expect(await simulateTagFilter(fileAnchor, [addrA], targets)).to.be.true;
    });

    it("Multiple users tagging the same DATA UID → it appears only once in discovery", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "multi-tagger.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw4");

      await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userB, dataA, nsfwDef, true);

      // Only appears once in discovery list (append-only dedup)
      expect(await tagResolver.getTaggedTargetCount(nsfwDef)).to.equal(1n);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Tag removal", function () {
    it("Revoking a tag clears the active tag UID", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "revoke-test.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw5");
      const addrA = await userA.getAddress();

      const tagUID = await tagTarget(userA, dataA, nsfwDef, true);
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(tagUID);

      await revokeTag(userA, tagUID);
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(ZERO_BYTES32);
    });

    it("Superseding with applies=false removes the tag logically", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "untag-test.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw6");
      const addrA = await userA.getAddress();

      await tagTarget(userA, dataA, nsfwDef, true);
      const negateUID = await tagTarget(userA, dataA, nsfwDef, false);

      // Active tag is the negation attestation
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(negateUID);

      // Check the attestation data has applies=false
      const attestation = await eas.getAttestation(negateUID);
      const [, appliesVal] = enc.decode(["bytes32", "bool"], attestation.data);
      expect(appliesVal).to.be.false;
    });

    it("Tag removal by one user does NOT affect another user's tag on the same DATA", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "multi-revoke.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw7");
      const addrA = await userA.getAddress();
      const addrB = await userB.getAddress();

      const tagA = await tagTarget(userA, dataA, nsfwDef, true);
      const tagB = await tagTarget(userB, dataA, nsfwDef, true);

      // Revoke User A's tag
      await revokeTag(userA, tagA);

      // User A's tag is gone
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(ZERO_BYTES32);
      // User B's tag is still active
      expect(await tagResolver.getActiveTagUID(addrB, dataA, nsfwDef)).to.equal(tagB);
    });

    it("Revoked tags remain in discovery lists (append-only)", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "disc-revoke.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw8");

      const tagUID = await tagTarget(userA, dataA, nsfwDef, true);
      await revokeTag(userA, tagUID);

      // Still in discovery even after revocation
      expect(await tagResolver.getTaggedTargetCount(nsfwDef)).to.equal(1n);
      expect(await tagResolver.getTagDefinitionCount(dataA)).to.equal(1n);
    });

    it("isActivelyTagged: true after tagging, false after revocation", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "active-check.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw8b");

      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.false;

      const tagUID = await tagTarget(userA, dataA, nsfwDef, true);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.true;

      await revokeTag(userA, tagUID);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.false;
    });

    it("isActivelyTagged: stays true when one of two attesters revokes", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "multi-tagger.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw8c");

      const tagA = await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userB, dataA, nsfwDef, true);

      // Both tagged — actively tagged
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.true;

      // User A revokes — User B still has active tag
      await revokeTag(userA, tagA);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.true;
    });

    it("isActivelyTagged: false after applies=false supersede", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "negate-check.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw8d");

      await tagTarget(userA, dataA, nsfwDef, true);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.true;

      // Negate (applies=false) — supersedes the active tag
      await tagTarget(userA, dataA, nsfwDef, false);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.false;
    });

    it("isActivelyTagged: true again after re-tagging following revocation", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "retag-check.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw8e");

      const tag1 = await tagTarget(userA, dataA, nsfwDef, true);
      await revokeTag(userA, tag1);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.false;

      await tagTarget(userA, dataA, nsfwDef, true);
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.true;
    });

    it("getActivelyTaggedSet correctly excludes revoked targets from filter", async function () {
      const anchorA = await createFileAnchor(userA, rootUID, "active-filter-a.txt");
      const anchorB = await createFileAnchor(userA, rootUID, "active-filter-b.txt");
      const dataA = await createData(userA, anchorA, "A");
      const dataB = await createData(userA, anchorB, "B");
      const nsfwDef = await createTagDef("nsfw8f");
      const addrA = await userA.getAddress();

      const tagA = await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userA, dataB, nsfwDef, true);

      // Both match before revocation
      const activeSetBefore = await getActivelyTaggedSet(nsfwDef);
      expect(await simulateTagFilter(anchorA, [addrA], activeSetBefore)).to.be.true;
      expect(await simulateTagFilter(anchorB, [addrA], activeSetBefore)).to.be.true;

      // Revoke tag on A
      await revokeTag(userA, tagA);

      // Discovery list still has both
      const rawSet = await getTaggedTargetSet(nsfwDef);
      expect(rawSet.size).to.equal(2);

      // Active set only has B
      const activeSetAfter = await getActivelyTaggedSet(nsfwDef);
      expect(activeSetAfter.has(dataA.toLowerCase())).to.be.false;
      expect(activeSetAfter.has(dataB.toLowerCase())).to.be.true;

      expect(await simulateTagFilter(anchorA, [addrA], activeSetAfter)).to.be.false;
      expect(await simulateTagFilter(anchorB, [addrA], activeSetAfter)).to.be.true;
    });

    it("Re-tagging after revocation creates a new active tag", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "retag.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw9");
      const addrA = await userA.getAddress();

      const tagUID1 = await tagTarget(userA, dataA, nsfwDef, true);
      await revokeTag(userA, tagUID1);
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(ZERO_BYTES32);

      const tagUID2 = await tagTarget(userA, dataA, nsfwDef, true);
      expect(tagUID2).to.not.equal(tagUID1);
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(tagUID2);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Multiple files with tags", function () {
    it("Tagging two of three files — only tagged files appear in the target set", async function () {
      const anchorA = await createFileAnchor(userA, rootUID, "fileA.txt");
      const anchorB = await createFileAnchor(userA, rootUID, "fileB.txt");
      const anchorC = await createFileAnchor(userA, rootUID, "fileC.txt");
      const dataA = await createData(userA, anchorA, "A");
      const dataB = await createData(userA, anchorB, "B");
      const dataC = await createData(userA, anchorC, "C");
      const nsfwDef = await createTagDef("nsfw10");

      await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userA, dataC, nsfwDef, true);

      const targets = await getTaggedTargetSet(nsfwDef);
      expect(targets.has(dataA.toLowerCase())).to.be.true;
      expect(targets.has(dataB.toLowerCase())).to.be.false;
      expect(targets.has(dataC.toLowerCase())).to.be.true;
      expect(await tagResolver.getTaggedTargetCount(nsfwDef)).to.equal(2n);
    });

    it("Different files tagged with different definitions are independently filterable", async function () {
      const anchorA = await createFileAnchor(userA, rootUID, "docA.txt");
      const anchorB = await createFileAnchor(userA, rootUID, "docB.txt");
      const dataA = await createData(userA, anchorA, "A");
      const dataB = await createData(userA, anchorB, "B");
      const nsfwDef = await createTagDef("nsfw11");
      const favDef = await createTagDef("fav11");
      const addrA = await userA.getAddress();

      await tagTarget(userA, dataA, nsfwDef, true);
      await tagTarget(userA, dataB, favDef, true);

      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      const favSet = await getTaggedTargetSet(favDef);

      // nsfw filter
      expect(await simulateTagFilter(anchorA, [addrA], nsfwSet)).to.be.true;
      expect(await simulateTagFilter(anchorB, [addrA], nsfwSet)).to.be.false;

      // favorites filter
      expect(await simulateTagFilter(anchorA, [addrA], favSet)).to.be.false;
      expect(await simulateTagFilter(anchorB, [addrA], favSet)).to.be.true;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Three-user scenario with mixed editions and tags", function () {
    let fileAnchor: string;
    let dataA: string;
    let dataB: string;
    let nsfwDef: string;
    let favDef: string;
    let addrA: string;
    let addrB: string;
    let addrC: string;

    beforeEach(async function () {
      fileAnchor = await createFileAnchor(userA, rootUID, "three-users.txt");
      dataA = await createData(userA, fileAnchor, "A-version");
      dataB = await createData(userB, fileAnchor, "B-version");
      await createData(userC, fileAnchor, "C-version"); // creates userC's edition (referenced via addrC)
      nsfwDef = await createTagDef("nsfw12");
      favDef = await createTagDef("fav12");
      addrA = await userA.getAddress();
      addrB = await userB.getAddress();
      addrC = await userC.getAddress();

      // User A tags their DATA as nsfw
      await tagTarget(userA, dataA, nsfwDef, true);
      // User B tags their DATA as favorites
      await tagTarget(userB, dataB, favDef, true);
      // User C has DATA but no tags
    });

    it("Filter 'nsfw' with edition=A → match", async function () {
      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      expect(await simulateTagFilter(fileAnchor, [addrA], nsfwSet)).to.be.true;
    });

    it("Filter 'nsfw' with edition=B → no match", async function () {
      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      expect(await simulateTagFilter(fileAnchor, [addrB], nsfwSet)).to.be.false;
    });

    it("Filter 'nsfw' with edition=C → no match", async function () {
      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      expect(await simulateTagFilter(fileAnchor, [addrC], nsfwSet)).to.be.false;
    });

    it("Filter 'favorites' with edition=B → match", async function () {
      const favSet = await getTaggedTargetSet(favDef);
      expect(await simulateTagFilter(fileAnchor, [addrB], favSet)).to.be.true;
    });

    it("Filter 'favorites' with edition=A → no match", async function () {
      const favSet = await getTaggedTargetSet(favDef);
      expect(await simulateTagFilter(fileAnchor, [addrA], favSet)).to.be.false;
    });

    it("Filter 'nsfw' with editions=[A, B, C] → match (A matches)", async function () {
      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      expect(await simulateTagFilter(fileAnchor, [addrA, addrB, addrC], nsfwSet)).to.be.true;
    });

    it("Filter 'favorites' with editions=[A, C] → no match (neither has favorites)", async function () {
      const favSet = await getTaggedTargetSet(favDef);
      expect(await simulateTagFilter(fileAnchor, [addrA, addrC], favSet)).to.be.false;
    });

    it("Filter 'nsfw' after User A revokes tag → no match for any edition", async function () {
      const activeTag = await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef);
      await revokeTag(userA, activeTag);

      // Active tag is cleared
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(ZERO_BYTES32);

      // isActivelyTagged returns false now that all attesters have revoked
      expect(await tagResolver.isActivelyTagged(dataA, nsfwDef)).to.be.false;

      // Discovery list still contains dataA (append-only — expected)
      const rawSet = await getTaggedTargetSet(nsfwDef);
      expect(rawSet.has(dataA.toLowerCase())).to.be.true;

      // Active-filtered set (mirrors frontend behaviour) excludes the revoked target
      const activeSet = await getActivelyTaggedSet(nsfwDef);
      expect(activeSet.has(dataA.toLowerCase())).to.be.false;

      // simulateTagFilter with the active set: no edition matches
      expect(await simulateTagFilter(fileAnchor, [addrA], activeSet)).to.be.false;
      expect(await simulateTagFilter(fileAnchor, [addrB], activeSet)).to.be.false;
      expect(await simulateTagFilter(fileAnchor, [addrC], activeSet)).to.be.false;
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Superseding (re-tagging same triple)", function () {
    it("Re-tagging the same DATA with same definition overwrites the active tag", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "supersede.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw13");
      const addrA = await userA.getAddress();

      const tag1 = await tagTarget(userA, dataA, nsfwDef, true);
      const tag2 = await tagTarget(userA, dataA, nsfwDef, true);

      expect(tag1).to.not.equal(tag2);
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(tag2);
    });

    it("Revoking a superseded (old) tag does NOT clear the active tag", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "old-revoke.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw14");
      const addrA = await userA.getAddress();

      const tag1 = await tagTarget(userA, dataA, nsfwDef, true);
      const tag2 = await tagTarget(userA, dataA, nsfwDef, true); // supersedes tag1

      // Revoke the old superseded tag
      await revokeTag(userA, tag1);

      // tag2 should still be active
      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(tag2);
    });

    it("Toggle: apply → negate → re-apply correctly tracks state", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "toggle.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw15");
      const addrA = await userA.getAddress();

      // Apply
      const t1 = await tagTarget(userA, dataA, nsfwDef, true);
      let att = await eas.getAttestation(t1);
      const [, applies1] = enc.decode(["bytes32", "bool"], att.data);
      expect(applies1).to.be.true;

      // Negate (untag)
      const t2 = await tagTarget(userA, dataA, nsfwDef, false);
      att = await eas.getAttestation(t2);
      const [, applies2] = enc.decode(["bytes32", "bool"], att.data);
      expect(applies2).to.be.false;

      // Re-apply
      const t3 = await tagTarget(userA, dataA, nsfwDef, true);
      att = await eas.getAttestation(t3);
      const [, applies3] = enc.decode(["bytes32", "bool"], att.data);
      expect(applies3).to.be.true;

      expect(await tagResolver.getActiveTagUID(addrA, dataA, nsfwDef)).to.equal(t3);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Edge cases", function () {
    it("User with no DATA for an anchor — filter never matches", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "no-data.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const nsfwDef = await createTagDef("nsfw16");
      const addrC = await userC.getAddress();

      await tagTarget(userA, dataA, nsfwDef, true);

      const nsfwSet = await getTaggedTargetSet(nsfwDef);
      // User C has no DATA → getDataByAddressList returns zero → no match
      expect(await simulateTagFilter(fileAnchor, [addrC], nsfwSet)).to.be.false;
    });

    it("Tag definition is itself an anchor UID (under 'tags' folder)", async function () {
      // Verify the tag definition is a real anchor that can be resolved
      const nsfwDef = await createTagDef("nsfw17");
      const resolved = await indexer.resolvePath(tagsAnchorUID, "nsfw17");
      expect(resolved).to.equal(nsfwDef);
    });

    it("DuplicateFileName prevents creating the same tag definition twice", async function () {
      await createTagDef("unique-tag");
      await expect(createTagDef("unique-tag")).to.be.revertedWithCustomError(indexer, "DuplicateFileName");
    });

    it("Tagging a file's DATA in a subfolder works correctly", async function () {
      const folder = await createAnchor(userA, rootUID, "subfolder");
      const fileAnchor = await createFileAnchor(userA, folder, "nested.txt");
      const dataA = await createData(userA, fileAnchor, "nested-content");
      const nsfwDef = await createTagDef("nsfw18");
      const addrA = await userA.getAddress();

      await tagTarget(userA, dataA, nsfwDef, true);

      const targets = await getTaggedTargetSet(nsfwDef);
      expect(targets.has(dataA.toLowerCase())).to.be.true;
      expect(await simulateTagFilter(fileAnchor, [addrA], targets)).to.be.true;
    });

    it("Updated DATA (second upload) — tag on old DATA does not match new DATA", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "versioned2.txt");
      const dataV1 = await createData(userA, fileAnchor, "version1");
      const nsfwDef = await createTagDef("nsfw19");
      const addrA = await userA.getAddress();

      // Tag version 1
      await tagTarget(userA, dataV1, nsfwDef, true);

      // Upload version 2 (new DATA attestation)
      const dataV2 = await createData(userA, fileAnchor, "version2");

      // getDataByAddressList returns the LATEST non-revoked DATA
      expect(await indexer.getDataByAddressList(fileAnchor, [addrA], false)).to.equal(dataV2);

      // The tag is on dataV1, not dataV2
      const targets = await getTaggedTargetSet(nsfwDef);
      expect(targets.has(dataV1.toLowerCase())).to.be.true;
      expect(targets.has(dataV2.toLowerCase())).to.be.false;

      // Filter with current (latest) DATA: no match because tag was on old version
      expect(await simulateTagFilter(fileAnchor, [addrA], targets)).to.be.false;
    });

    it("Tag on old DATA persists if old DATA is still active (showRevoked=true)", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "old-active.txt");
      const dataV1 = await createData(userA, fileAnchor, "version1");
      const nsfwDef = await createTagDef("nsfw20");
      const addrA = await userA.getAddress();

      await tagTarget(userA, dataV1, nsfwDef, true);

      // Upload version 2
      await createData(userA, fileAnchor, "version2");

      // With showRevoked=false (default), latest wins
      const latestData = await indexer.getDataByAddressList(fileAnchor, [addrA], false);
      const targets = await getTaggedTargetSet(nsfwDef);
      // Latest (v2) is not tagged
      expect(targets.has(latestData.toLowerCase())).to.be.false;
    });

    it("Two different files, same name in different folders — completely independent", async function () {
      const folderX = await createAnchor(userA, rootUID, "folderX");
      const folderY = await createAnchor(userA, rootUID, "folderY");
      const anchorX = await createFileAnchor(userA, folderX, "same-name.txt");
      const anchorY = await createFileAnchor(userA, folderY, "same-name.txt");
      const dataX = await createData(userA, anchorX, "X-content");
      await createData(userA, anchorY, "Y-content"); // creates anchorY's edition
      const nsfwDef = await createTagDef("nsfw21");
      const addrA = await userA.getAddress();

      await tagTarget(userA, dataX, nsfwDef, true);

      const targets = await getTaggedTargetSet(nsfwDef);
      expect(await simulateTagFilter(anchorX, [addrA], targets)).to.be.true;
      expect(await simulateTagFilter(anchorY, [addrA], targets)).to.be.false;
    });

    it("Empty definition UID is rejected by validation", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "empty-def.txt");
      const dataA = await createData(userA, fileAnchor, "A");

      // bytes32(0) is explicitly rejected by _validateDefinition
      await expect(tagTarget(userA, dataA, ZERO_BYTES32, true)).to.be.revertedWithCustomError(
        tagResolver,
        "InvalidDefinition",
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────

  describe("Discovery list correctness with DATA-level tagging", function () {
    it("getTagDefinitions lists all definitions applied to a specific DATA UID", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "disc-data.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const def1 = await createTagDef("d1");
      const def2 = await createTagDef("d2");
      const def3 = await createTagDef("d3");

      await tagTarget(userA, dataA, def1, true);
      await tagTarget(userA, dataA, def2, true);
      await tagTarget(userA, dataA, def3, true);

      expect(await tagResolver.getTagDefinitionCount(dataA)).to.equal(3n);
      const defs = await tagResolver.getTagDefinitions(dataA, 0n, 10n);
      expect(defs).to.include(def1);
      expect(defs).to.include(def2);
      expect(defs).to.include(def3);
    });

    it("Definitions applied to DATA_A do NOT appear in DATA_B's definition list", async function () {
      const fileAnchor = await createFileAnchor(userA, rootUID, "disc-isolation.txt");
      const dataA = await createData(userA, fileAnchor, "A");
      const dataB = await createData(userB, fileAnchor, "B");
      const nsfwDef = await createTagDef("d4");

      await tagTarget(userA, dataA, nsfwDef, true);

      expect(await tagResolver.getTagDefinitionCount(dataA)).to.equal(1n);
      expect(await tagResolver.getTagDefinitionCount(dataB)).to.equal(0n);
    });
  });
});
