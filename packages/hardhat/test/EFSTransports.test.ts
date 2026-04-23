import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EdgeResolver, MirrorResolver, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

/**
 * EFS Transports & Data Model — exercises the standalone DATA, MIRROR, and
 * placement primitives under the ADR-0041 PIN/TAG model.
 *
 * - File placement (DATA at a folder/anchor slot) is PIN (cardinality 1):
 *     PIN(definition=anchorUID, refUID=DATA) — one active PIN per
 *     (attester, definition, targetSchema) slot. Removal is `eas.revoke()`,
 *     never `applies=false`.
 * - PROPERTY value binding (contentType, etc.) is also PIN under a key anchor.
 * - Folder visibility / sub-folder enumeration would be TAG (cardinality N) but
 *   isn't exercised here — those cases live in EFSFileView.test.ts.
 */
describe("EFS Transports & Data Model", function () {
  let indexer: EFSIndexer;
  let edgeResolver: EdgeResolver;
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
  let pinSchemaUID: string;
  let tagSchemaUID: string;
  let mirrorSchemaUID: string;
  let blobSchemaUID: string;

  let rootUID: string;
  let transportsUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let onchainTransportUID: string;
  let _httpsTransportUID: string;
  let _magnetTransportUID: string;

  // Per-test active-edge index: `${target}|${definition}|${attester}` → live attestation UID.
  // Lets `unpin()` revoke the live PIN without per-test bookkeeping.
  let activePinIndex: Map<string, string>;

  const enc = new ethers.AbiCoder();

  const encodeAnchor = (name: string, schema: string = ZERO_BYTES32) =>
    enc.encode(["string", "bytes32"], [name, schema]);

  const encodeData = (contentHash: string, size: bigint) => enc.encode(["bytes32", "uint64"], [contentHash, size]);

  const encodePropertyValue = (value: string) => enc.encode(["string"], [value]);

  const encodePin = (definition: string) => enc.encode(["bytes32"], [definition]);

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
    activePinIndex = new Map();

    // Deploy EAS infrastructure
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction:
    //   nonce+0: EdgeResolver
    //   nonce+1: MirrorResolver
    //   nonce+2: ANCHOR schema
    //   nonce+3: PROPERTY schema
    //   nonce+4: DATA schema
    //   nonce+5: PIN schema
    //   nonce+6: TAG schema
    //   nonce+7: MIRROR schema
    //   nonce+8: BLOB schema
    //   nonce+9: EFSIndexer
    //   nonce+10: EFSFileView
    const currentNonce = await ethers.provider.getTransactionCount(ownerAddr);

    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce });
    const futureMirrorResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 1 });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 9 });

    // Pre-compute schema UIDs
    anchorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string name, bytes32 schemaUID", futureIndexerAddr, false],
    );
    propertySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string value", futureIndexerAddr, false],
    );
    dataSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 contentHash, uint64 size", futureIndexerAddr, false],
    );
    pinSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition", futureEdgeResolverAddr, true],
    );
    tagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, int256 weight", futureEdgeResolverAddr, true],
    );
    mirrorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 transportDefinition, string uri", futureMirrorResolverAddr, true],
    );
    blobSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string mimeType, uint8 storageType, bytes location", ZeroAddress, true],
    );

    // Deploy EdgeResolver (PIN + TAG combined under one resolver)
    const EdgeResolverFactory = await ethers.getContractFactory("EdgeResolver");
    edgeResolver = await EdgeResolverFactory.deploy(
      await eas.getAddress(),
      pinSchemaUID,
      tagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );

    // Deploy MirrorResolver
    const MirrorResolverFactory = await ethers.getContractFactory("MirrorResolver");
    mirrorResolver = await MirrorResolverFactory.deploy(await eas.getAddress(), futureIndexerAddr);

    // Register schemas
    await (await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, false)).wait();
    await (await registry.register("string value", futureIndexerAddr, false)).wait();
    await (await registry.register("bytes32 contentHash, uint64 size", futureIndexerAddr, false)).wait();
    await (await registry.register("bytes32 definition", await edgeResolver.getAddress(), true)).wait();
    await (await registry.register("bytes32 definition, int256 weight", await edgeResolver.getAddress(), true)).wait();
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
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await edgeResolver.getAddress());

    // Wire contracts
    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
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
    _httpsTransportUID = await mkAnchor(transportsUID, "https");
    _magnetTransportUID = await mkAnchor(transportsUID, "magnet");

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

  /**
   * Attach a PROPERTY to a container under the unified free-floating model
   * (ADR-0035) but with PIN-based binding (ADR-0041): key anchor under the
   * container, free-floating PROPERTY(value), and a PIN (cardinality 1) that
   * binds them. Returns the PROPERTY UID. Re-binding the same key with a new
   * PROPERTY UID supersedes the prior PIN in O(1).
   */
  async function createProperty(
    containerUID: string,
    key: string,
    value: string,
    signer: Signer = owner,
  ): Promise<string> {
    let keyAnchorUID: string = await indexer.resolveAnchor(containerUID, key, propertySchemaUID);
    if (keyAnchorUID === ZERO_BYTES32) {
      const keyTx = await eas.connect(signer).attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: containerUID,
          data: encodeAnchor(key, propertySchemaUID),
          value: 0n,
        },
      });
      keyAnchorUID = getUID(await keyTx.wait());
    }

    const propTx = await eas.connect(signer).attest({
      schema: propertySchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: encodePropertyValue(value),
        value: 0n,
      },
    });
    const propertyUID = getUID(await propTx.wait());

    await pinAt(propertyUID, keyAnchorUID, signer);
    return propertyUID;
  }

  /**
   * PIN a target under a definition (cardinality 1: each attester has one
   * active PIN per (definition, targetSchema) slot). Re-pinning at the same
   * slot supersedes prior PIN in O(1). Returns the PIN attestation UID.
   */
  async function pinAt(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: pinSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodePin(definitionUID),
        value: 0n,
      },
    });
    const uid = getUID(await tx.wait());
    activePinIndex.set(`${targetUID}|${definitionUID}|${await signer.getAddress()}`, uid);
    return uid;
  }

  /** Revoke the live PIN for (target, def, attester). */
  async function unpinAt(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<void> {
    const key = `${targetUID}|${definitionUID}|${await signer.getAddress()}`;
    const uid = activePinIndex.get(key);
    if (uid === undefined) throw new Error(`no active PIN tracked for ${key}`);
    await eas.connect(signer).revoke({
      schema: pinSchemaUID,
      data: { uid, value: 0n },
    });
    activePinIndex.delete(key);
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

  // ─── PIN-based file placement ─────────────────────────────────────────────

  describe("PIN-based file placement", function () {
    let memesUID: string;
    let catDataUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");

      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("cat picture"));
      catDataUID = await createData(contentHash, 5000n);
    });

    it("should place DATA at path via PIN", async function () {
      // ADR-0041: file placement is cardinality 1 — the active PIN at the
      // (definition=anchor, attester, schema=DATA) slot identifies the file.
      await pinAt(catDataUID, memesUID);

      const ownerAddr = await owner.getAddress();
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.isActiveEdge(ownerAddr, catDataUID, memesUID, pinSchemaUID)).to.equal(true);
    });

    it("should remove DATA from path via PIN revocation", async function () {
      const ownerAddr = await owner.getAddress();
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);

      // Removal under ADR-0041 is always EAS revoke — there is no `applies=false`
      await unpinAt(catDataUID, memesUID);

      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.isActiveEdge(ownerAddr, catDataUID, memesUID, pinSchemaUID)).to.equal(false);
    });

    it("should handle re-pin after revoke: slot reads correctly through pin → revoke → pin", async function () {
      const ownerAddr = await owner.getAddress();

      // Initial: empty slot
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(false);

      // Pin
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(true);

      // Revoke
      await unpinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(false);

      // Re-pin: DATA must reappear in the slot
      await pinAt(catDataUID, memesUID);
      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.hasActiveEdge(catDataUID, memesUID)).to.equal(true);
    });

    it("should support same DATA at multiple paths (one PIN per slot)", async function () {
      const animalsUID = await createAnchor(rootUID, "animals");
      const ownerAddr = await owner.getAddress();

      await pinAt(catDataUID, memesUID);
      await pinAt(catDataUID, animalsUID);

      expect(await edgeResolver.getActivePinTarget(memesUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
      expect(await edgeResolver.getActivePinTarget(animalsUID, ownerAddr, dataSchemaUID)).to.equal(catDataUID);
    });

    it("should support multiple DATAs at same path by different attesters", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Alice and Bob each create their own DATA and pin it at /memes/.
      // PIN cardinality 1 is per-attester — each gets their own slot.
      const aliceHash = ethers.keccak256(ethers.toUtf8Bytes("alice cat"));
      const aliceData = await createData(aliceHash, 100n, alice);
      await pinAt(aliceData, memesUID, alice);

      const bobHash = ethers.keccak256(ethers.toUtf8Bytes("bob cat"));
      const bobData = await createData(bobHash, 200n, bob);
      await pinAt(bobData, memesUID, bob);

      expect(await edgeResolver.getActivePinTarget(memesUID, aliceAddr, dataSchemaUID)).to.equal(aliceData);
      expect(await edgeResolver.getActivePinTarget(memesUID, bobAddr, dataSchemaUID)).to.equal(bobData);
    });

    it("should propagate containsAttestations up the tree", async function () {
      const aliceAddr = await alice.getAddress();

      // Create /memes/funny/
      const funnyUID = await createAnchor(memesUID, "funny");

      // Alice pins DATA at /memes/funny/
      const hash = ethers.keccak256(ethers.toUtf8Bytes("funny cat"));
      const dataUID = await createData(hash, 100n, alice);
      await pinAt(dataUID, funnyUID, alice);

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
    it("should return DATAs pinned at a path", async function () {
      const memesUID = await createAnchor(rootUID, "memes-view");
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("view test"));
      const dataUID = await createData(contentHash, 42n);
      await pinAt(dataUID, memesUID);

      const ownerAddr = await owner.getAddress();
      const { items } = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, "0x", 10);

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
    it("should create DATA + PROPERTY + MIRROR + PIN in sequence", async function () {
      // Create file anchor path
      const docsUID = await createAnchor(rootUID, "docs");

      // 1. Create DATA
      const contentHash = ethers.keccak256(ethers.toUtf8Bytes("# Hello World\n"));
      const dataUID = await createData(contentHash, 15n);

      // 2. Attach PROPERTY (contentType) — bound via PIN under the key anchor
      await createProperty(dataUID, "contentType", "text/markdown");

      // 3. Create MIRROR (onchain retrieval)
      await createMirror(dataUID, onchainTransportUID, "web3://0x1234567890123456789012345678901234567890");

      // 4. PIN to place at /docs/ (file placement is cardinality 1)
      await pinAt(dataUID, docsUID);

      // Verify: DATA at /docs/ via PIN read
      const ownerAddr = await owner.getAddress();
      expect(await edgeResolver.getActivePinTarget(docsUID, ownerAddr, dataSchemaUID)).to.equal(dataUID);

      // Verify: mirrors on DATA
      const mirrors = await indexer.getReferencingAttestations(dataUID, mirrorSchemaUID, 0, 10, false);
      expect(mirrors.length).to.equal(1);

      // Verify: dedup
      expect(await indexer.dataByContentKey(contentHash)).to.equal(dataUID);
    });
  });
});
