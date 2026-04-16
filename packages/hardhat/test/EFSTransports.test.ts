import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, TagResolver, MirrorResolver, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

describe("EFS Transports & Data Model", function () {
  let indexer: EFSIndexer;
  let tagResolver: TagResolver;
  let mirrorResolver: MirrorResolver;
  let fileView: EFSFileView;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let tagSchemaUID: string;
  let mirrorSchemaUID: string;
  let blobSchemaUID: string;

  let rootUID: string;
  let transportsUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let onchainTransportUID: string;
  let httpsTransportUID: string;
  let magnetTransportUID: string;

  const enc = new ethers.AbiCoder();

  const encodeAnchor = (name: string, schema: string = ZERO_BYTES32) =>
    enc.encode(["string", "bytes32"], [name, schema]);

  const encodeData = (contentHash: string, size: bigint) => enc.encode(["bytes32", "uint64"], [contentHash, size]);

  const encodeProperty = (key: string, value: string) => enc.encode(["string", "string"], [key, value]);

  const encodeTag = (definition: string, applies: boolean) => enc.encode(["bytes32", "bool"], [definition, applies]);

  const encodeMirror = (transportDef: string, uri: string) => enc.encode(["bytes32", "string"], [transportDef, uri]);

  const getUID = (receipt: any): string => {
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {}
    }
    throw new Error("No Attested event found");
  };

  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();

    // Deploy EAS infrastructure
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction:
    //   nonce+0: TagResolver
    //   nonce+1: MirrorResolver
    //   nonce+2: ANCHOR schema
    //   nonce+3: PROPERTY schema
    //   nonce+4: DATA schema
    //   nonce+5: TAG schema
    //   nonce+6: MIRROR schema
    //   nonce+7: BLOB schema
    //   nonce+8: EFSIndexer
    //   nonce+9: EFSFileView
    const currentNonce = await ethers.provider.getTransactionCount(ownerAddr);

    const futureTagResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce });
    const futureMirrorResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 1 });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 8 });

    // Pre-compute schema UIDs
    anchorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string name, bytes32 schemaUID", futureIndexerAddr, false],
    );
    propertySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string key, string value", futureIndexerAddr, true],
    );
    dataSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 contentHash, uint64 size", futureIndexerAddr, false],
    );
    tagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, bool applies", futureTagResolverAddr, true],
    );
    mirrorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 transportDefinition, string uri", futureMirrorResolverAddr, true],
    );
    blobSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string mimeType, uint8 storageType, bytes location", ZeroAddress, true],
    );

    // Deploy TagResolver
    const TagResolverFactory = await ethers.getContractFactory("TagResolver");
    tagResolver = await TagResolverFactory.deploy(
      await eas.getAddress(),
      tagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );

    // Deploy MirrorResolver
    const MirrorResolverFactory = await ethers.getContractFactory("MirrorResolver");
    mirrorResolver = await MirrorResolverFactory.deploy(await eas.getAddress(), futureIndexerAddr);

    // Register schemas
    await (await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false)).wait();
    await (await registry.register("string key, string value", futureIndexerAddr, true)).wait();
    await (await registry.register("bytes32 contentHash, uint64 size", futureIndexerAddr, false)).wait();
    await (await registry.register("bytes32 definition, bool applies", await tagResolver.getAddress(), true)).wait();
    await (
      await registry.register("bytes32 transportDefinition, string uri", await mirrorResolver.getAddress(), true)
    ).wait();
    await (await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true)).wait();

    // Deploy EFSIndexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
    );
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy EFSFileView
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await tagResolver.getAddress());

    // Wire contracts
    await indexer.wireContracts(
      await tagResolver.getAddress(),
      tagSchemaUID,
      ZeroAddress, // no sort overlay in this test
      ZERO_BYTES32,
      await mirrorResolver.getAddress(),
      mirrorSchemaUID,
      await registry.getAddress(),
    );

    // Create root anchor
    const rootTx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeAnchor("root"),
        value: 0n,
      },
    });
    rootUID = getUID(await rootTx.wait());
    expect(await indexer.rootAnchorUID()).to.equal(rootUID);

    // Create /transports/ anchor tree (shared across all tests)
    const mkAnchor = async (parent: string, name: string) => {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: parent,
          data: encodeAnchor(name),
          value: 0n,
        },
      });
      return getUID(await tx.wait());
    };
    transportsUID = await mkAnchor(rootUID, "transports");
    ipfsTransportUID = await mkAnchor(transportsUID, "ipfs");
    arweaveTransportUID = await mkAnchor(transportsUID, "arweave");
    onchainTransportUID = await mkAnchor(transportsUID, "onchain");
    httpsTransportUID = await mkAnchor(transportsUID, "https");
    magnetTransportUID = await mkAnchor(transportsUID, "magnet");

    // Wire transport ancestry into MirrorResolver
    await mirrorResolver.setTransportsAnchor(transportsUID);
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function createAnchor(
    parentUID: string,
    name: string,
    schema: string = ZERO_BYTES32,
    signer: Signer = owner,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: encodeAnchor(name, schema),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  async function createData(contentHash: string, size: bigint, signer: Signer = owner): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodeData(contentHash, size),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  async function createProperty(refUID: string, key: string, value: string, signer: Signer = owner): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: refUID,
        data: encodeProperty(key, value),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  async function tagTarget(
    targetUID: string,
    definitionUID: string,
    applies: boolean,
    signer: Signer = owner,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodeTag(definitionUID, applies),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  async function createMirror(
    dataUID: string,
    transportDefUID: string,
    uri: string,
    signer: Signer = owner,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: mirrorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: dataUID,
        data: encodeMirror(transportDefUID, uri),
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  // ─── DATA Tests ───────────────────────────────────────────────────────────

  describe("Standalone DATA", function () {
    it("should create standalone DATA with contentHash and size", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("hello world"));
      const dataUID = await createData(contentHash, 11n);

      expect(dataUID).to.not.equal(ZERO_BYTES32);
      const att = await eas.getAttestation(dataUID);
      expect(att.schema).to.equal(dataSchemaUID);
      expect(att.refUID).to.equal(ZERO_BYTES32); // standalone
      expect(att.revocable).to.equal(false);
    });

    it("should populate dataByContentKey on first DATA", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("unique content"));
      const dataUID = await createData(contentHash, 14n);
      expect(await indexer.dataByContentKey(contentHash)).to.equal(dataUID);
    });

    it("should not overwrite dataByContentKey for duplicate contentHash", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("same content"));
      const first = await createData(contentHash, 12n);
      const second = await createData(contentHash, 12n);

      expect(first).to.not.equal(second); // different UIDs
      expect(await indexer.dataByContentKey(contentHash)).to.equal(first); // canonical = first
    });

    it("should reject DATA with refUID (must be standalone)", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
      // Create an anchor to use as refUID
      const anchorUID = await createAnchor(rootUID, "test-folder");

      // DATA with refUID should fail (resolver returns false → EAS reverts)
      await expect(
        eas.attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: anchorUID,
            data: encodeData(contentHash, 4n),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });
  });

  // ─── PROPERTY on DATA Tests ───────────────────────────────────────────────

  describe("PROPERTY on DATA", function () {
    it("should allow PROPERTY on DATA attestation (contentType)", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("image data"));
      const dataUID = await createData(contentHash, 1024n);
      const propUID = await createProperty(dataUID, "contentType", "image/jpeg");

      expect(propUID).to.not.equal(ZERO_BYTES32);
    });
  });

  // ─── MIRROR Tests ─────────────────────────────────────────────────────────

  describe("MirrorResolver", function () {
    let testDataUID: string;

    beforeEach(async function () {
      // Create a DATA to attach mirrors to
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("cat.jpg"));
      testDataUID = await createData(contentHash, 50000n);
    });

    it("should create MIRROR on DATA", async function () {
      const mirrorUID = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmTestHash123");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("should allow multiple mirrors on same DATA", async function () {
      const m1 = await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmHash1");
      const m2 = await createMirror(testDataUID, arweaveTransportUID, "ar://ArHash1");
      expect(m1).to.not.equal(m2);
    });

    it("should reject MIRROR without refUID", async function () {
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: ZERO_BYTES32,
            data: encodeMirror(ipfsTransportUID, "ipfs://QmHash"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("should reject MIRROR referencing non-DATA attestation", async function () {
      // Try to attach mirror to an anchor (not DATA)
      await expect(
        eas.attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: transportsUID, // an anchor, not DATA
            data: encodeMirror(ipfsTransportUID, "ipfs://QmHash"),
            value: 0n,
          },
        }),
      ).to.be.reverted;
    });

    it("should reject MIRROR with invalid transport definition", async function () {
      // Use a random bytes32 that's not an anchor
      const fakeTransport = ethers.keccak256(ethers.toUtf8Bytes("not-a-transport"));
      await expect(createMirror(testDataUID, fakeTransport, "fake://something")).to.be.reverted;
    });

    it("should reject MIRROR whose transport anchor is not under /transports/", async function () {
      // Create an anchor outside /transports/ tree
      const randomAnchor = await createAnchor(rootUID, "not-transports");
      await expect(createMirror(testDataUID, randomAnchor, "ipfs://QmHash")).to.be.reverted;
    });

    it("should accept MIRROR with nested transport anchor (/transports/ipfs/v2)", async function () {
      const ipfsV2 = await createAnchor(ipfsTransportUID, "v2");
      const mirrorUID = await createMirror(testDataUID, ipfsV2, "ipfs://QmNestedHash");
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);
    });

    it("should be discoverable via getReferencingAttestations", async function () {
      await createMirror(testDataUID, ipfsTransportUID, "ipfs://QmHash1");
      await createMirror(testDataUID, arweaveTransportUID, "ar://ArHash1");

      const mirrors = await indexer.getReferencingAttestations(testDataUID, mirrorSchemaUID, 0, 10, false);
      expect(mirrors.length).to.equal(2);
    });
  });

  // ─── TAG-based placement Tests ────────────────────────────────────────────

  describe("TAG-based file placement", function () {
    let memesUID: string;
    let catDataUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");

      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("cat picture"));
      catDataUID = await createData(contentHash, 5000n);
    });

    it("should place DATA at path via TAG", async function () {
      await tagTarget(catDataUID, memesUID, true);

      const ownerAddr = await owner.getAddress();
      const count = await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID);
      expect(count).to.equal(1n);

      const targets = await tagResolver.getActiveTargetsByAttesterAndSchema(memesUID, ownerAddr, dataSchemaUID, 0, 10);
      expect(targets[0]).to.equal(catDataUID);
    });

    it("should remove DATA from path via TAG applies=false", async function () {
      const ownerAddr = await owner.getAddress();
      await tagTarget(catDataUID, memesUID, true);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );

      // Remove
      await tagTarget(catDataUID, memesUID, false);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        0n,
      );
    });

    it("should handle re-tag after untag: count, list contents, and isActivelyTagged are correct", async function () {
      const ownerAddr = await owner.getAddress();

      // Initial state: not tagged
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        0n,
      );
      expect(await tagResolver.isActivelyTagged(catDataUID, memesUID)).to.equal(false);

      // Tag
      await tagTarget(catDataUID, memesUID, true);
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );
      expect(await tagResolver.isActivelyTagged(catDataUID, memesUID)).to.equal(true);

      // Untag
      await tagTarget(catDataUID, memesUID, false);
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        0n,
      );
      expect(await tagResolver.isActivelyTagged(catDataUID, memesUID)).to.equal(false);

      // Re-tag: DATA must reappear in the list
      await tagTarget(catDataUID, memesUID, true);
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );
      expect(await tagResolver.isActivelyTagged(catDataUID, memesUID)).to.equal(true);

      const listed = await tagResolver.getActiveTargetsByAttesterAndSchema(memesUID, ownerAddr, dataSchemaUID, 0, 10);
      expect(listed.length).to.equal(1);
      expect(listed[0]).to.equal(catDataUID);
    });

    it("should support same DATA at multiple paths", async function () {
      const animalsUID = await createAnchor(rootUID, "animals");
      const ownerAddr = await owner.getAddress();

      await tagTarget(catDataUID, memesUID, true);
      await tagTarget(catDataUID, animalsUID, true);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(animalsUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );
    });

    it("should support multiple DATAs at same path by different attesters", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Alice and Bob each create their own DATA and tag it at /memes/
      const aliceHash = ethers.keccak256(ethers.toUtf8Bytes("alice cat"));
      const aliceData = await createData(aliceHash, 100n);
      await tagTarget(aliceData, memesUID, true, alice);

      const bobHash = ethers.keccak256(ethers.toUtf8Bytes("bob cat"));
      const bobData = await createData(bobHash, 200n);
      await tagTarget(bobData, memesUID, true, bob);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, aliceAddr, dataSchemaUID)).to.equal(
        1n,
      );
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, bobAddr, dataSchemaUID)).to.equal(1n);
    });

    it("should propagate containsAttestations up the tree", async function () {
      const aliceAddr = await alice.getAddress();

      // Create /memes/funny/
      const funnyUID = await createAnchor(memesUID, "funny");

      // Alice tags DATA at /memes/funny/
      const hash = ethers.keccak256(ethers.toUtf8Bytes("funny cat"));
      const dataUID = await createData(hash, 100n);
      await tagTarget(dataUID, funnyUID, true, alice);

      // containsAttestations should propagate to /memes/funny/, /memes/, and root
      expect(await indexer.containsAttestations(funnyUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(memesUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);
    });
  });

  // ─── MAX_ANCHOR_DEPTH Tests ───────────────────────────────────────────────

  describe("MAX_ANCHOR_DEPTH", function () {
    it("should enforce maximum anchor depth", async function () {
      let parent = rootUID;
      // Create a chain of 32 levels (root + 32 = 33 total, but root doesn't count as depth)
      for (let i = 0; i < 32; i++) {
        parent = await createAnchor(parent, `level${i}`);
      }

      // 33rd level should fail
      await expect(createAnchor(parent, "too-deep")).to.be.revertedWithCustomError(indexer, "AnchorTooDeep");
    });
  });

  // ─── EFSFileView Integration Tests ────────────────────────────────────────

  describe("EFSFileView.getFilesAtPath", function () {
    it("should return DATAs tagged at a path", async function () {
      const memesUID = await createAnchor(rootUID, "memes-view");
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("view test"));
      const dataUID = await createData(contentHash, 42n);
      await tagTarget(dataUID, memesUID, true);

      const ownerAddr = await owner.getAddress();
      const items = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 10);

      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(dataUID);
      expect(items[0].contentHash).to.equal(contentHash);
      expect(items[0].hasData).to.equal(true);
    });
  });

  describe("EFSFileView.getDataMirrors", function () {
    it("should return mirrors for a DATA", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("mirror test"));
      const dataUID = await createData(contentHash, 100n);
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmTest");

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].uri).to.equal("ipfs://QmTest");
      expect(mirrors[0].transportDefinition).to.equal(ipfsTransportUID);
    });
  });

  describe("EFSFileView.getCanonicalData", function () {
    it("should return canonical DATA for contentHash", async function () {
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("canonical test"));
      const dataUID = await createData(contentHash, 50n);

      expect(await fileView.getCanonicalData(contentHash)).to.equal(dataUID);
    });
  });

  // ─── Full Upload Flow (atomic) ────────────────────────────────────────────

  describe("Full upload flow", function () {
    it("should create DATA + PROPERTY + MIRROR + TAG in sequence", async function () {
      // Create file anchor path
      const docsUID = await createAnchor(rootUID, "docs");

      // 1. Create DATA
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("# Hello World\n"));
      const dataUID = await createData(contentHash, 15n);

      // 2. Attach PROPERTY (contentType)
      await createProperty(dataUID, "contentType", "text/markdown");

      // 3. Create MIRROR (onchain retrieval)
      await createMirror(dataUID, onchainTransportUID, "web3://0x1234567890123456789012345678901234567890");

      // 4. TAG to place at /docs/
      await tagTarget(dataUID, docsUID, true);

      // Verify: DATA at /docs/ via tag query
      const ownerAddr = await owner.getAddress();
      const targets = await tagResolver.getActiveTargetsByAttesterAndSchema(docsUID, ownerAddr, dataSchemaUID, 0, 10);
      expect(targets.length).to.equal(1);
      expect(targets[0]).to.equal(dataUID);

      // Verify: mirrors on DATA
      const mirrors = await indexer.getReferencingAttestations(dataUID, mirrorSchemaUID, 0, 10, false);
      expect(mirrors.length).to.equal(1);

      // Verify: dedup
      expect(await indexer.dataByContentKey(contentHash)).to.equal(dataUID);
    });
  });
});
