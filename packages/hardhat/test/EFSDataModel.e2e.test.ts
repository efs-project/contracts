/**
 * EFS Data Model — End-to-End Integration Tests
 *
 * Exercises the full three-layer data model (Paths → Data → Mirrors) through
 * realistic user workflows. Tests cover:
 *
 *   1. Full upload flows (on-chain, IPFS, Arweave, multi-transport)
 *   2. PROPERTY metadata (contentType, previousVersion)
 *   3. TAG-based file placement and removal
 *   4. Folder/sub-folder listing via EFSFileView.getFilesAtPath
 *   5. Cross-referencing (same DATA in multiple folders)
 *   6. File versioning (untag old, tag new, previousVersion chain)
 *   7. Dedup (dataByContentKey canonical lookup)
 *   8. Editions (multi-attester scenarios)
 *   9. NSFW-style label tagging and filtering
 *  10. Tree visibility propagation (containsAttestations)
 *  11. Mirror queries (getDataMirrors)
 *  12. Swap-and-pop ordering correctness
 *  13. Edge cases: re-tag, tag non-existent, deep nesting
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, TagResolver, MirrorResolver, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

describe("EFS Data Model — E2E Integration", function () {
  let indexer: EFSIndexer;
  let tagResolver: TagResolver;
  let mirrorResolver: MirrorResolver;
  let fileView: EFSFileView;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;
  let alice: Signer;
  let bob: Signer;
  let charlie: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let tagSchemaUID: string;
  let mirrorSchemaUID: string;
  let blobSchemaUID: string;

  let rootUID: string;

  // Transport anchors (created in beforeEach)
  let transportsUID: string;
  let onchainTransportUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let magnetTransportUID: string;
  let httpsTransportUID: string;

  const enc = new ethers.AbiCoder();

  // ─── Encoding Helpers ─────────────────────────────────────────────────────

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
      } catch {
        // not an EAS log
      }
    }
    throw new Error("No Attested event found");
  };

  const hash = (text: string) => ethers.keccak256(ethers.toUtf8Bytes(text));

  // ─── Action Helpers ───────────────────────────────────────────────────────

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

  /**
   * Full file upload: DATA + PROPERTY(contentType) + MIRROR + TAG
   * Returns { dataUID, propertyUID, mirrorUID, tagUID }
   */
  async function uploadFile(
    content: string,
    contentType: string,
    transportUID: string,
    mirrorUri: string,
    folderUID: string,
    signer: Signer = owner,
  ) {
    const contentHash = hash(content);
    const size = BigInt(Buffer.from(content).length);

    const dataUID = await createData(contentHash, size, signer);
    const propertyUID = await createProperty(dataUID, "contentType", contentType, signer);
    const mirrorUID = await createMirror(dataUID, transportUID, mirrorUri, signer);
    const tagUID = await tagTarget(dataUID, folderUID, true, signer);

    return { dataUID, propertyUID, mirrorUID, tagUID, contentHash };
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();

    // Deploy EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction (same layout as EFSTransports.test.ts)
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

    // Deploy resolvers
    const TagResolverFactory = await ethers.getContractFactory("TagResolver");
    tagResolver = await TagResolverFactory.deploy(
      await eas.getAddress(),
      tagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );

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

    // Deploy Indexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
    );
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy FileView
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await tagResolver.getAddress());

    // Wire contracts
    await indexer.wireContracts(
      await tagResolver.getAddress(),
      tagSchemaUID,
      ZeroAddress, // no sort overlay
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

    // Create transport anchors: /transports/{onchain,ipfs,arweave,magnet,https}
    transportsUID = await createAnchor(rootUID, "transports");
    onchainTransportUID = await createAnchor(transportsUID, "onchain");
    ipfsTransportUID = await createAnchor(transportsUID, "ipfs");
    arweaveTransportUID = await createAnchor(transportsUID, "arweave");
    magnetTransportUID = await createAnchor(transportsUID, "magnet");
    httpsTransportUID = await createAnchor(transportsUID, "https");
  });

  // =========================================================================
  // 1. FULL UPLOAD FLOWS
  // =========================================================================

  describe("Full Upload Flows", function () {
    let docsUID: string;

    beforeEach(async function () {
      docsUID = await createAnchor(rootUID, "docs");
    });

    it("on-chain upload: DATA + contentType PROPERTY + onchain MIRROR + TAG placement", async function () {
      const { dataUID, contentHash } = await uploadFile(
        "# Hello World\nSome markdown content.",
        "text/markdown",
        onchainTransportUID,
        "web3://0x1234567890AbCdEf1234567890AbCdEf12345678",
        docsUID,
      );

      // Verify DATA is standalone
      const att = await eas.getAttestation(dataUID);
      expect(att.refUID).to.equal(ZERO_BYTES32);
      expect(att.revocable).to.equal(false);

      // Verify dedup key
      expect(await indexer.dataByContentKey(contentHash)).to.equal(dataUID);

      // Verify contentType PROPERTY exists
      const props = await indexer.getReferencingAttestations(dataUID, propertySchemaUID, 0, 10, false);
      expect(props.length).to.equal(1);
      const propAtt = await eas.getAttestation(props[0]);
      const [decodedKey, decodedValue] = enc.decode(["string", "string"], propAtt.data);
      expect(decodedKey).to.equal("contentType");
      expect(decodedValue).to.equal("text/markdown");

      // Verify onchain MIRROR exists
      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].transportDefinition).to.equal(onchainTransportUID);
      expect(mirrors[0].uri).to.equal("web3://0x1234567890AbCdEf1234567890AbCdEf12345678");

      // Verify TAG placement — DATA appears in /docs/ listing
      const ownerAddr = await owner.getAddress();
      const items = await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(dataUID);
      expect(items[0].hasData).to.equal(true);
      expect(items[0].contentHash).to.equal(contentHash);
    });

    it("IPFS paste: DATA + contentType + ipfs MIRROR + TAG placement", async function () {
      const content = '{"name":"Cool NFT","image":"ipfs://QmImage"}';
      const { dataUID } = await uploadFile(
        content,
        "application/json",
        ipfsTransportUID,
        "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].transportDefinition).to.equal(ipfsTransportUID);
      expect(mirrors[0].uri).to.equal("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    });

    it("Arweave paste: DATA + contentType + arweave MIRROR + TAG placement", async function () {
      const { dataUID } = await uploadFile(
        "<html><body>Permaweb page</body></html>",
        "text/html",
        arweaveTransportUID,
        "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors[0].transportDefinition).to.equal(arweaveTransportUID);
      expect(mirrors[0].uri).to.equal("ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U");
    });

    it("Magnet link paste: DATA + magnet MIRROR + TAG", async function () {
      const magnetUri = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=test.iso";
      const { dataUID } = await uploadFile(
        "large file content placeholder",
        "application/octet-stream",
        magnetTransportUID,
        magnetUri,
        docsUID,
      );

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors[0].transportDefinition).to.equal(magnetTransportUID);
      expect(mirrors[0].uri).to.equal(magnetUri);
    });

    it("HTTPS link paste: DATA + https MIRROR + TAG", async function () {
      const { dataUID } = await uploadFile(
        "remote hosted content",
        "image/png",
        httpsTransportUID,
        "https://example.com/images/photo.png",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors[0].transportDefinition).to.equal(httpsTransportUID);
      expect(mirrors[0].uri).to.equal("https://example.com/images/photo.png");
    });
  });

  // =========================================================================
  // 2. MULTI-TRANSPORT (multiple mirrors on same DATA)
  // =========================================================================

  describe("Multi-Transport Mirrors", function () {
    it("should attach onchain + IPFS + Arweave mirrors to the same DATA", async function () {
      const contentHash = hash("multi-mirror file");
      const dataUID = await createData(contentHash, 19n);

      await createMirror(dataUID, onchainTransportUID, "web3://0xABCDEF");
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmMulti1");
      await createMirror(dataUID, arweaveTransportUID, "ar://ArMulti1");

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(3);

      const transports = mirrors.map((m: any) => m.transportDefinition);
      expect(transports).to.include(onchainTransportUID);
      expect(transports).to.include(ipfsTransportUID);
      expect(transports).to.include(arweaveTransportUID);

      const uris = mirrors.map((m: any) => m.uri);
      expect(uris).to.include("web3://0xABCDEF");
      expect(uris).to.include("ipfs://QmMulti1");
      expect(uris).to.include("ar://ArMulti1");
    });

    it("should allow multiple mirrors per transport type (e.g. two IPFS gateways)", async function () {
      const dataUID = await createData(hash("two-ipfs"), 8n);

      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmGateway1");
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmGateway2");

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(2);
      expect(mirrors[0].uri).to.not.equal(mirrors[1].uri);
    });

    it("add mirror to existing DATA (no new DATA needed)", async function () {
      const docsUID = await createAnchor(rootUID, "docs");
      const { dataUID } = await uploadFile(
        "original file",
        "text/plain",
        onchainTransportUID,
        "web3://0xOriginal",
        docsUID,
      );

      // Later: add an IPFS mirror to the same DATA
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmBackup");

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(2);
    });
  });

  // =========================================================================
  // 3. PROPERTY METADATA
  // =========================================================================

  describe("PROPERTY Metadata on DATA", function () {
    it("should store contentType as PROPERTY", async function () {
      const dataUID = await createData(hash("typed file"), 10n);
      await createProperty(dataUID, "contentType", "image/jpeg");

      const props = await indexer.getReferencingAttestations(dataUID, propertySchemaUID, 0, 10, false);
      expect(props.length).to.equal(1);

      const propAtt = await eas.getAttestation(props[0]);
      const [key, val] = enc.decode(["string", "string"], propAtt.data);
      expect(key).to.equal("contentType");
      expect(val).to.equal("image/jpeg");
    });

    it("should store previousVersion as PROPERTY linking two DATAs", async function () {
      const v1Hash = hash("version 1 content");
      const v1 = await createData(v1Hash, 17n);

      const v2Hash = hash("version 2 content");
      const v2 = await createData(v2Hash, 17n);

      // Attach previousVersion PROPERTY to v2 referencing v1
      await createProperty(v2, "previousVersion", v1);

      const props = await indexer.getReferencingAttestations(v2, propertySchemaUID, 0, 10, false);
      expect(props.length).to.equal(1);
      const propAtt = await eas.getAttestation(props[0]);
      const [key, prevVersion] = enc.decode(["string", "string"], propAtt.data);
      expect(key).to.equal("previousVersion");
      expect(prevVersion).to.equal(v1);
    });

    it("should allow multiple PROPERTYs on same DATA (contentType + description)", async function () {
      const dataUID = await createData(hash("multi prop"), 10n);
      await createProperty(dataUID, "contentType", "text/html");
      await createProperty(dataUID, "description", "A cool webpage");

      const props = await indexer.getReferencingAttestations(dataUID, propertySchemaUID, 0, 10, false);
      expect(props.length).to.equal(2);
    });
  });

  // =========================================================================
  // 4. TAG-BASED FILE PLACEMENT & FOLDER LISTING
  // =========================================================================

  describe("TAG-based Folder Listing", function () {
    let memesUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");
    });

    it("should list DATAs at a path via getFilesAtPath", async function () {
      const ownerAddr = await owner.getAddress();

      // Upload 3 files to /memes/
      const f1 = await uploadFile("cat.jpg bytes", "image/jpeg", onchainTransportUID, "web3://0xCat", memesUID);
      const f2 = await uploadFile("dog.png bytes", "image/png", onchainTransportUID, "web3://0xDog", memesUID);
      const f3 = await uploadFile("meme.gif bytes", "image/gif", onchainTransportUID, "web3://0xMeme", memesUID);

      const items = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(3);

      const uids = items.map((i: any) => i.uid);
      expect(uids).to.include(f1.dataUID);
      expect(uids).to.include(f2.dataUID);
      expect(uids).to.include(f3.dataUID);

      // All should be DATA (hasData=true, isFolder=false)
      for (const item of items) {
        expect(item.hasData).to.equal(true);
        expect(item.isFolder).to.equal(false);
      }
    });

    it("should list sub-folders via getFilesAtPath with ANCHOR_SCHEMA", async function () {
      const ownerAddr = await owner.getAddress();

      // Create sub-folders under /memes/
      const funnyUID = await createAnchor(memesUID, "funny");
      const catsUID = await createAnchor(memesUID, "cats");

      // Tag sub-folders at the parent (sub-folder placement)
      await tagTarget(funnyUID, memesUID, true);
      await tagTarget(catsUID, memesUID, true);

      const items = await fileView.getFilesAtPath(memesUID, [ownerAddr], anchorSchemaUID, 0, 50);
      expect(items.length).to.equal(2);

      const names = items.map((i: any) => i.name);
      expect(names).to.include("funny");
      expect(names).to.include("cats");

      for (const item of items) {
        expect(item.isFolder).to.equal(true);
        expect(item.hasData).to.equal(false);
      }
    });

    it("should show mixed content: DATAs and sub-folders in same parent", async function () {
      const ownerAddr = await owner.getAddress();

      // Files
      await uploadFile("file1", "text/plain", onchainTransportUID, "web3://0x1", memesUID);
      await uploadFile("file2", "text/plain", onchainTransportUID, "web3://0x2", memesUID);

      // Sub-folders tagged at parent
      const subUID = await createAnchor(memesUID, "subfolder");
      await tagTarget(subUID, memesUID, true);

      // Query DATAs
      const dataItems = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(dataItems.length).to.equal(2);

      // Query sub-folders
      const folderItems = await fileView.getFilesAtPath(memesUID, [ownerAddr], anchorSchemaUID, 0, 50);
      expect(folderItems.length).to.equal(1);
      expect(folderItems[0].name).to.equal("subfolder");
    });

    it("should remove a file from listing when TAG applies=false", async function () {
      const ownerAddr = await owner.getAddress();
      const { dataUID } = await uploadFile("removeme", "text/plain", onchainTransportUID, "web3://0x1", memesUID);

      // Verify it's listed
      let items = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(1);

      // Untag
      await tagTarget(dataUID, memesUID, false);

      // Verify it's gone
      items = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(0);

      // DATA itself still exists
      const att = await eas.getAttestation(dataUID);
      expect(att.uid).to.equal(dataUID);
    });

    it("should show empty folder (no items tagged)", async function () {
      const ownerAddr = await owner.getAddress();
      const emptyUID = await createAnchor(rootUID, "empty-folder");

      const items = await fileView.getFilesAtPath(emptyUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(0);
    });
  });

  // =========================================================================
  // 5. CROSS-REFERENCING (same DATA in multiple folders)
  // =========================================================================

  describe("Cross-Referencing", function () {
    it("same DATA tagged at two different paths shares metadata and mirrors", async function () {
      const ownerAddr = await owner.getAddress();
      const memesUID = await createAnchor(rootUID, "memes");
      const animalsUID = await createAnchor(rootUID, "animals");

      // Create DATA + contentType + mirror once
      const contentHash = hash("cat picture shared");
      const dataUID = await createData(contentHash, 18n);
      await createProperty(dataUID, "contentType", "image/jpeg");
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmSharedCat");

      // Tag at both /memes/ and /animals/
      await tagTarget(dataUID, memesUID, true);
      await tagTarget(dataUID, animalsUID, true);

      // Both paths list the DATA
      const memesItems = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      const animalsItems = await fileView.getFilesAtPath(animalsUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(memesItems.length).to.equal(1);
      expect(animalsItems.length).to.equal(1);
      expect(memesItems[0].uid).to.equal(dataUID);
      expect(animalsItems[0].uid).to.equal(dataUID);

      // Shared mirrors
      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].uri).to.equal("ipfs://QmSharedCat");
    });

    it("removing DATA from one path doesn't affect the other", async function () {
      const ownerAddr = await owner.getAddress();
      const path1 = await createAnchor(rootUID, "path1");
      const path2 = await createAnchor(rootUID, "path2");

      const dataUID = await createData(hash("shared file"), 11n);
      await tagTarget(dataUID, path1, true);
      await tagTarget(dataUID, path2, true);

      // Remove from path1
      await tagTarget(dataUID, path1, false);

      const items1 = await fileView.getFilesAtPath(path1, [ownerAddr], dataSchemaUID, 0, 50);
      const items2 = await fileView.getFilesAtPath(path2, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items1.length).to.equal(0);
      expect(items2.length).to.equal(1);
    });
  });

  // =========================================================================
  // 6. FILE VERSIONING
  // =========================================================================

  describe("File Versioning", function () {
    it("should replace file: untag old DATA, tag new DATA, link via previousVersion", async function () {
      const ownerAddr = await owner.getAddress();
      const docsUID = await createAnchor(rootUID, "docs");

      // Upload v1
      const v1 = await uploadFile("v1 content", "text/markdown", onchainTransportUID, "web3://0xV1", docsUID);

      // Upload v2 (different content, same folder)
      const v2Hash = hash("v2 content updated");
      const v2DataUID = await createData(v2Hash, 18n);
      await createProperty(v2DataUID, "contentType", "text/markdown");
      await createMirror(v2DataUID, onchainTransportUID, "web3://0xV2");

      // Link v2 → v1 via previousVersion PROPERTY
      await createProperty(v2DataUID, "previousVersion", v1.dataUID);

      // Untag v1, tag v2
      await tagTarget(v1.dataUID, docsUID, false);
      await tagTarget(v2DataUID, docsUID, true);

      // Only v2 should appear
      const items = await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(v2DataUID);

      // v1 DATA still exists on-chain (non-revocable)
      const v1Att = await eas.getAttestation(v1.dataUID);
      expect(v1Att.uid).to.equal(v1.dataUID);

      // Version chain is traversable via PROPERTY
      const v2Props = await indexer.getReferencingAttestations(v2DataUID, propertySchemaUID, 0, 10, false);
      expect(v2Props.length).to.equal(2); // contentType + previousVersion
    });

    it("should handle three-version chain", async function () {
      const docsUID = await createAnchor(rootUID, "docs");

      const v1 = await createData(hash("v1"), 2n);
      await tagTarget(v1, docsUID, true);

      const v2 = await createData(hash("v2"), 2n);
      await createProperty(v2, "previousVersion", v1); // previousVersion
      await tagTarget(v1, docsUID, false);
      await tagTarget(v2, docsUID, true);

      const v3 = await createData(hash("v3"), 2n);
      await createProperty(v3, "previousVersion", v2); // previousVersion
      await tagTarget(v2, docsUID, false);
      await tagTarget(v3, docsUID, true);

      // Only v3 should be in the folder
      const ownerAddr = await owner.getAddress();
      const items = await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(v3);

      // All three DATAs still exist
      expect((await eas.getAttestation(v1)).uid).to.equal(v1);
      expect((await eas.getAttestation(v2)).uid).to.equal(v2);
      expect((await eas.getAttestation(v3)).uid).to.equal(v3);
    });
  });

  // =========================================================================
  // 7. DEDUP (dataByContentKey)
  // =========================================================================

  describe("Content Dedup", function () {
    it("canonical DATA for a contentHash is the first created", async function () {
      const contentHash = hash("identical bytes");
      const first = await createData(contentHash, 15n);
      const second = await createData(contentHash, 15n);

      expect(first).to.not.equal(second);
      expect(await indexer.dataByContentKey(contentHash)).to.equal(first);
      expect(await fileView.getCanonicalData(contentHash)).to.equal(first);
    });

    it("different content produces different canonical entries", async function () {
      const h1 = hash("content A");
      const h2 = hash("content B");
      const d1 = await createData(h1, 9n);
      const d2 = await createData(h2, 9n);

      expect(await indexer.dataByContentKey(h1)).to.equal(d1);
      expect(await indexer.dataByContentKey(h2)).to.equal(d2);
    });

    it("getCanonicalData returns zero for unknown content hash", async function () {
      const unknownHash = hash("never uploaded");
      expect(await fileView.getCanonicalData(unknownHash)).to.equal(ZERO_BYTES32);
    });
  });

  // =========================================================================
  // 8. EDITIONS (multi-attester scenarios)
  // =========================================================================

  describe("Editions (Multi-Attester)", function () {
    let memesUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");
    });

    it("each attester has independent file listing at same path", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Alice uploads her version
      const aliceData = await createData(hash("alice cat"), 9n);
      await tagTarget(aliceData, memesUID, true, alice);

      // Bob uploads his version
      const bobData = await createData(hash("bob cat"), 7n);
      await tagTarget(bobData, memesUID, true, bob);

      // Query Alice's edition
      const aliceItems = await fileView.getFilesAtPath(memesUID, [aliceAddr], dataSchemaUID, 0, 50);
      expect(aliceItems.length).to.equal(1);
      expect(aliceItems[0].uid).to.equal(aliceData);

      // Query Bob's edition
      const bobItems = await fileView.getFilesAtPath(memesUID, [bobAddr], dataSchemaUID, 0, 50);
      expect(bobItems.length).to.equal(1);
      expect(bobItems[0].uid).to.equal(bobData);
    });

    it("query with multiple attesters merges and deduplicates", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Both tag the same DATA
      const sharedData = await createData(hash("shared meme"), 11n);
      await tagTarget(sharedData, memesUID, true, alice);
      await tagTarget(sharedData, memesUID, true, bob);

      // Alice-only also has a unique file
      const aliceOnly = await createData(hash("alice only"), 10n);
      await tagTarget(aliceOnly, memesUID, true, alice);

      // Query both → should show 2 unique items (deduped shared + aliceOnly)
      const items = await fileView.getFilesAtPath(memesUID, [aliceAddr, bobAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(2);

      const uids = items.map((i: any) => i.uid);
      expect(uids).to.include(sharedData);
      expect(uids).to.include(aliceOnly);
    });

    it("one attester removing file doesn't affect other attester's listing", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const data = await createData(hash("contested"), 9n);
      await tagTarget(data, memesUID, true, alice);
      await tagTarget(data, memesUID, true, bob);

      // Alice untags
      await tagTarget(data, memesUID, false, alice);

      // Bob still sees it
      const bobItems = await fileView.getFilesAtPath(memesUID, [bobAddr], dataSchemaUID, 0, 50);
      expect(bobItems.length).to.equal(1);

      // Alice doesn't
      const aliceItems = await fileView.getFilesAtPath(memesUID, [aliceAddr], dataSchemaUID, 0, 50);
      expect(aliceItems.length).to.equal(0);
    });

    it("three attesters with overlapping files: correct counts per edition", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const charlieAddr = await charlie.getAddress();

      const d1 = await createData(hash("d1"), 2n);
      const d2 = await createData(hash("d2"), 2n);
      const d3 = await createData(hash("d3"), 2n);

      // Alice: d1, d2
      await tagTarget(d1, memesUID, true, alice);
      await tagTarget(d2, memesUID, true, alice);

      // Bob: d2, d3
      await tagTarget(d2, memesUID, true, bob);
      await tagTarget(d3, memesUID, true, bob);

      // Charlie: d1, d3
      await tagTarget(d1, memesUID, true, charlie);
      await tagTarget(d3, memesUID, true, charlie);

      // Each should have 2
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, aliceAddr, dataSchemaUID)).to.equal(
        2n,
      );
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, bobAddr, dataSchemaUID)).to.equal(2n);
      expect(
        await tagResolver.getActiveTargetsByAttesterAndSchemaCount(memesUID, charlieAddr, dataSchemaUID),
      ).to.equal(2n);

      // Query all three → 3 unique items
      const all = await fileView.getFilesAtPath(
        memesUID,
        [aliceAddr, bobAddr, charlieAddr],
        dataSchemaUID,
        0,
        50,
      );
      expect(all.length).to.equal(3);
    });
  });

  // =========================================================================
  // 9. NSFW-STYLE LABEL TAGS & FILTERING
  // =========================================================================

  describe("Label Tags (NSFW-style filtering)", function () {
    let tagsUID: string;
    let nsfwUID: string;
    let spoilerUID: string;

    beforeEach(async function () {
      tagsUID = await createAnchor(rootUID, "tags");
      nsfwUID = await createAnchor(tagsUID, "nsfw");
      spoilerUID = await createAnchor(tagsUID, "spoiler");
    });

    it("should tag a DATA as NSFW and check via point lookup", async function () {
      const dataUID = await createData(hash("spicy content"), 14n);
      const ownerAddr = await owner.getAddress();

      await tagTarget(dataUID, nsfwUID, true);

      // Point lookup
      const tagUID = await tagResolver.getActiveTagUID(ownerAddr, dataUID, nsfwUID);
      expect(tagUID).to.not.equal(ZERO_BYTES32);

      // isActivelyTagged (any attester)
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(true);
    });

    it("should track active state across attesters via isActivelyTagged", async function () {
      const dataUID = await createData(hash("maybe nsfw"), 10n);
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Initially not tagged
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(false);

      // Alice says NSFW
      await tagTarget(dataUID, nsfwUID, true, alice);
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(true);
      expect(await tagResolver.getActiveTagUID(aliceAddr, dataUID, nsfwUID)).to.not.equal(ZERO_BYTES32);

      // Bob also says NSFW
      await tagTarget(dataUID, nsfwUID, true, bob);
      expect(await tagResolver.getActiveTagUID(bobAddr, dataUID, nsfwUID)).to.not.equal(ZERO_BYTES32);

      // Charlie says NOT NSFW (applies=false — they never said true, so no effect on others)
      await tagTarget(dataUID, nsfwUID, false, charlie);
      // Still actively tagged (alice + bob have applies=true)
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(true);

      // Alice changes mind
      await tagTarget(dataUID, nsfwUID, false, alice);
      // Still actively tagged (bob still has applies=true)
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(true);

      // Bob also changes mind → no more active tags
      await tagTarget(dataUID, nsfwUID, false, bob);
      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(false);
    });

    it("should filter NSFW items from a folder listing (client-side pattern)", async function () {
      const memesUID = await createAnchor(rootUID, "memes");
      const ownerAddr = await owner.getAddress();

      const safeData = await createData(hash("safe meme"), 9n);
      const nsfwData = await createData(hash("nsfw meme"), 9n);
      const alsoSafe = await createData(hash("another safe"), 12n);

      await tagTarget(safeData, memesUID, true);
      await tagTarget(nsfwData, memesUID, true);
      await tagTarget(alsoSafe, memesUID, true);

      // Mark one as NSFW
      await tagTarget(nsfwData, nsfwUID, true);

      // Get all items in folder
      const allItems = await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(allItems.length).to.equal(3);

      // Client-side filter: for each item, check NSFW tag
      const filtered = [];
      for (const item of allItems) {
        const isNsfw = await tagResolver.isActivelyTagged(item.uid, nsfwUID);
        if (!isNsfw) filtered.push(item);
      }
      expect(filtered.length).to.equal(2);
      expect(filtered.map((i: any) => i.uid)).to.not.include(nsfwData);
    });

    it("should support multiple labels on same DATA", async function () {
      const dataUID = await createData(hash("tagged content"), 14n);

      await tagTarget(dataUID, nsfwUID, true);
      await tagTarget(dataUID, spoilerUID, true);

      expect(await tagResolver.isActivelyTagged(dataUID, nsfwUID)).to.equal(true);
      expect(await tagResolver.isActivelyTagged(dataUID, spoilerUID)).to.equal(true);

      // Tag definitions for this DATA
      const defCount = await tagResolver.getTagDefinitionCount(dataUID);
      expect(defCount).to.be.gte(2n);
    });
  });

  // =========================================================================
  // 10. TREE VISIBILITY PROPAGATION (containsAttestations)
  // =========================================================================

  describe("Tree Visibility Propagation", function () {
    it("tagging DATA at deep path propagates to all ancestors", async function () {
      const aliceAddr = await alice.getAddress();

      // /media/images/cats/funny/
      const mediaUID = await createAnchor(rootUID, "media");
      const imagesUID = await createAnchor(mediaUID, "images");
      const catsUID = await createAnchor(imagesUID, "cats");
      const funnyUID = await createAnchor(catsUID, "funny");

      const dataUID = await createData(hash("deep cat"), 8n);
      await tagTarget(dataUID, funnyUID, true, alice);

      // All ancestors should show containsAttestations for alice
      expect(await indexer.containsAttestations(funnyUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(catsUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(imagesUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(mediaUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);
    });

    it("propagation is per-attester (alice visible, bob not until bob tags)", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const folderUID = await createAnchor(rootUID, "perm-test");
      const dataUID = await createData(hash("alice only data"), 15n);
      await tagTarget(dataUID, folderUID, true, alice);

      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(folderUID, bobAddr)).to.equal(false);

      // Now bob tags something there too
      const bobData = await createData(hash("bob data"), 8n);
      await tagTarget(bobData, folderUID, true, bob);

      expect(await indexer.containsAttestations(folderUID, bobAddr)).to.equal(true);
    });

    it("early-exit optimization: second tag at same path doesn't re-walk tree", async function () {
      const aliceAddr = await alice.getAddress();
      const folderUID = await createAnchor(rootUID, "opt-test");

      const d1 = await createData(hash("d1"), 2n);
      const d2 = await createData(hash("d2"), 2n);

      // First tag propagates up the tree
      await tagTarget(d1, folderUID, true, alice);
      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(true);

      // Second tag — should succeed without issue (early exit in propagateContains)
      await tagTarget(d2, folderUID, true, alice);

      // Both files visible
      const items = await tagResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        aliceAddr,
        dataSchemaUID,
        0,
        10,
      );
      expect(items.length).to.equal(2);
    });
  });

  // =========================================================================
  // 11. SWAP-AND-POP ORDERING
  // =========================================================================

  describe("Swap-and-Pop Compact Index", function () {
    it("removing middle item preserves other items", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-test");

      const d1 = await createData(hash("item1"), 5n);
      const d2 = await createData(hash("item2"), 5n);
      const d3 = await createData(hash("item3"), 5n);

      await tagTarget(d1, folderUID, true);
      await tagTarget(d2, folderUID, true);
      await tagTarget(d3, folderUID, true);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(folderUID, ownerAddr, dataSchemaUID)).to.equal(
        3n,
      );

      // Remove middle item
      await tagTarget(d2, folderUID, false);

      const remaining = await tagResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        dataSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(2);
      expect(remaining).to.include(d1);
      expect(remaining).to.include(d3);
      expect(remaining).to.not.include(d2);
    });

    it("removing first item works correctly", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-first");

      const d1 = await createData(hash("first"), 5n);
      const d2 = await createData(hash("second"), 6n);

      await tagTarget(d1, folderUID, true);
      await tagTarget(d2, folderUID, true);

      // Remove first
      await tagTarget(d1, folderUID, false);

      const remaining = await tagResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        dataSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(1);
      expect(remaining[0]).to.equal(d2);
    });

    it("removing last item works correctly", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-last");

      const d1 = await createData(hash("first-l"), 7n);
      const d2 = await createData(hash("last-l"), 6n);

      await tagTarget(d1, folderUID, true);
      await tagTarget(d2, folderUID, true);

      // Remove last
      await tagTarget(d2, folderUID, false);

      const remaining = await tagResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        dataSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(1);
      expect(remaining[0]).to.equal(d1);
    });

    it("removing only item results in empty list", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-only");

      const d1 = await createData(hash("lonely"), 6n);
      await tagTarget(d1, folderUID, true);
      await tagTarget(d1, folderUID, false);

      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(folderUID, ownerAddr, dataSchemaUID)).to.equal(
        0n,
      );
    });

    it("re-add after remove: item appears at end", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-readd");

      const d1 = await createData(hash("readd1"), 6n);
      const d2 = await createData(hash("readd2"), 6n);
      const d3 = await createData(hash("readd3"), 6n);

      await tagTarget(d1, folderUID, true);
      await tagTarget(d2, folderUID, true);
      await tagTarget(d3, folderUID, true);

      // Remove d1, re-add d1
      await tagTarget(d1, folderUID, false);
      await tagTarget(d1, folderUID, true);

      const items = await tagResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        dataSchemaUID,
        0,
        10,
      );
      expect(items.length).to.equal(3);
      // d1 should be at the end now (after swap-and-pop removed it, re-push puts it at end)
      expect(items[2]).to.equal(d1);
    });
  });

  // =========================================================================
  // 12. DISCOVERY INDICES
  // =========================================================================

  describe("Discovery Indices", function () {
    it("getTagDefinitions returns all definitions ever applied to a target", async function () {
      const memesUID = await createAnchor(rootUID, "memes-disc");
      const animalsUID = await createAnchor(rootUID, "animals-disc");
      const tagsUID = await createAnchor(rootUID, "tags-disc");
      const nsfwUID = await createAnchor(tagsUID, "nsfw");

      const dataUID = await createData(hash("multi-tagged"), 12n);

      // Tag at two paths + one label
      await tagTarget(dataUID, memesUID, true);
      await tagTarget(dataUID, animalsUID, true);
      await tagTarget(dataUID, nsfwUID, true);

      const defCount = await tagResolver.getTagDefinitionCount(dataUID);
      expect(defCount).to.equal(3n);

      const defs = await tagResolver.getTagDefinitions(dataUID, 0, 10);
      expect(defs).to.include(memesUID);
      expect(defs).to.include(animalsUID);
      expect(defs).to.include(nsfwUID);
    });

    it("getTaggedTargets returns all targets ever tagged with a definition", async function () {
      const folderUID = await createAnchor(rootUID, "browse-test");

      const d1 = await createData(hash("browse1"), 7n);
      const d2 = await createData(hash("browse2"), 7n);
      const d3 = await createData(hash("browse3"), 7n);

      await tagTarget(d1, folderUID, true);
      await tagTarget(d2, folderUID, true);
      await tagTarget(d3, folderUID, true);

      const targetCount = await tagResolver.getTaggedTargetCount(folderUID);
      expect(targetCount).to.equal(3n);

      const targets = await tagResolver.getTaggedTargets(folderUID, 0, 10);
      expect(targets).to.include(d1);
      expect(targets).to.include(d2);
      expect(targets).to.include(d3);
    });

    it("getTaggedTargets is append-only (untagged items still appear)", async function () {
      const folderUID = await createAnchor(rootUID, "append-test");

      const d1 = await createData(hash("append1"), 7n);
      await tagTarget(d1, folderUID, true);
      await tagTarget(d1, folderUID, false); // untag

      // Still in append-only list
      const targets = await tagResolver.getTaggedTargets(folderUID, 0, 10);
      expect(targets).to.include(d1);
    });
  });

  // =========================================================================
  // 13. EDGE CASES
  // =========================================================================

  describe("Edge Cases", function () {
    it("duplicate TAG (applies=true twice) is idempotent in compact index", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "idempotent");

      const dataUID = await createData(hash("idem"), 4n);
      await tagTarget(dataUID, folderUID, true);
      await tagTarget(dataUID, folderUID, true); // second applies=true

      // Should still be count 1, not 2
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(folderUID, ownerAddr, dataSchemaUID)).to.equal(
        1n,
      );
    });

    it("TAG applies=false on never-tagged item is safe (no underflow)", async function () {
      const folderUID = await createAnchor(rootUID, "no-underflow");
      const dataUID = await createData(hash("never-tagged"), 12n);

      // This should not revert
      await tagTarget(dataUID, folderUID, false);

      const ownerAddr = await owner.getAddress();
      expect(await tagResolver.getActiveTargetsByAttesterAndSchemaCount(folderUID, ownerAddr, dataSchemaUID)).to.equal(
        0n,
      );
    });

    it("DATA with no mirrors is valid", async function () {
      const docsUID = await createAnchor(rootUID, "no-mirrors");
      const dataUID = await createData(hash("mirrorless"), 10n);
      await tagTarget(dataUID, docsUID, true);

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(0);

      // But it still appears in folder listing
      const ownerAddr = await owner.getAddress();
      const items = await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, 0, 50);
      expect(items.length).to.equal(1);
    });

    it("DATA with no PROPERTY is valid (no contentType)", async function () {
      const dataUID = await createData(hash("raw bytes"), 9n);
      const props = await indexer.getReferencingAttestations(dataUID, propertySchemaUID, 0, 10, false);
      expect(props.length).to.equal(0);
    });

    it("mirror from different attester on someone else's DATA", async function () {
      // Alice creates DATA
      const dataUID = await createData(hash("alice's file"), 12n, alice);

      // Bob adds an IPFS mirror to Alice's DATA
      const mirrorUID = await createMirror(dataUID, ipfsTransportUID, "ipfs://QmBobMirror", bob);
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);

      const mirrors = await fileView.getDataMirrors(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].attester).to.equal(await bob.getAddress());
    });

    it("pagination: getFilesAtPath with start offset", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "paginate");

      const datas: string[] = [];
      for (let i = 0; i < 5; i++) {
        const d = await createData(hash(`page-item-${i}`), BigInt(i + 1));
        await tagTarget(d, folderUID, true);
        datas.push(d);
      }

      // First page: 3 items
      const page1 = await fileView.getFilesAtPath(folderUID, [ownerAddr], dataSchemaUID, 0, 3);
      expect(page1.length).to.equal(3);

      // Second page: 2 items
      const page2 = await fileView.getFilesAtPath(folderUID, [ownerAddr], dataSchemaUID, 3, 3);
      expect(page2.length).to.equal(2);

      // All 5 unique UIDs across both pages
      const allUIDs = [...page1.map((i: any) => i.uid), ...page2.map((i: any) => i.uid)];
      const uniqueUIDs = new Set(allUIDs);
      expect(uniqueUIDs.size).to.equal(5);
    });

    it("MAX_ANCHOR_DEPTH is enforced (prevents gas griefing)", async function () {
      let parent = rootUID;
      for (let i = 0; i < 32; i++) {
        parent = await createAnchor(parent, `d${i}`);
      }
      await expect(createAnchor(parent, "too-deep")).to.be.revertedWithCustomError(indexer, "AnchorTooDeep");
    });
  });

  // =========================================================================
  // 14. REALISTIC SCENARIO: Curated album with versions + cross-references
  // =========================================================================

  describe("Realistic Scenario: Shared photo album", function () {
    it("full workflow: create album, upload photos, add mirrors, version, cross-ref, filter NSFW", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // ── Setup folder structure ──
      const photosUID = await createAnchor(rootUID, "photos");
      const vacationUID = await createAnchor(photosUID, "vacation");
      const favoritesUID = await createAnchor(photosUID, "favorites");

      // Label anchors
      const tagsUID = await createAnchor(rootUID, "tags");
      const nsfwUID = await createAnchor(tagsUID, "nsfw");

      // ── Alice uploads 3 photos to /photos/vacation/ ──
      const photo1 = await uploadFile(
        "beach sunrise pixels",
        "image/jpeg",
        onchainTransportUID,
        "web3://0xBeach",
        vacationUID,
        alice,
      );
      const photo2 = await uploadFile(
        "mountain view pixels",
        "image/jpeg",
        ipfsTransportUID,
        "ipfs://QmMountain",
        vacationUID,
        alice,
      );
      const photo3 = await uploadFile(
        "sunset over water",
        "image/png",
        arweaveTransportUID,
        "ar://SunsetHash",
        vacationUID,
        alice,
      );

      // ── Verify /photos/vacation/ shows 3 photos for Alice ──
      let vacationItems = await fileView.getFilesAtPath(vacationUID, [aliceAddr], dataSchemaUID, 0, 50);
      expect(vacationItems.length).to.equal(3);

      // ── Alice cross-references photo1 into /photos/favorites/ ──
      await tagTarget(photo1.dataUID, favoritesUID, true, alice);

      let favItems = await fileView.getFilesAtPath(favoritesUID, [aliceAddr], dataSchemaUID, 0, 50);
      expect(favItems.length).to.equal(1);
      expect(favItems[0].uid).to.equal(photo1.dataUID);

      // ── Bob adds an IPFS mirror to Alice's beach photo ──
      await createMirror(photo1.dataUID, ipfsTransportUID, "ipfs://QmBeachBackup", bob);
      const beachMirrors = await fileView.getDataMirrors(photo1.dataUID, 0, 10);
      expect(beachMirrors.length).to.equal(2); // onchain + IPFS

      // ── Alice edits photo2 (new version) ──
      const photo2v2Hash = hash("mountain view pixels ENHANCED");
      const photo2v2 = await createData(photo2v2Hash, 30n, alice);
      await createProperty(photo2v2, "contentType", "image/jpeg", alice);
      await createMirror(photo2v2, ipfsTransportUID, "ipfs://QmMountainV2", alice);
      await createProperty(photo2v2, "previousVersion", photo2.dataUID, alice); // previousVersion

      // Untag old, tag new
      await tagTarget(photo2.dataUID, vacationUID, false, alice);
      await tagTarget(photo2v2, vacationUID, true, alice);

      // Still 3 items (photo1, photo2v2, photo3)
      vacationItems = await fileView.getFilesAtPath(vacationUID, [aliceAddr], dataSchemaUID, 0, 50);
      expect(vacationItems.length).to.equal(3);
      const vacUIDs = vacationItems.map((i: any) => i.uid);
      expect(vacUIDs).to.include(photo2v2);
      expect(vacUIDs).to.not.include(photo2.dataUID);

      // ── Bob marks photo3 as NSFW ──
      await tagTarget(photo3.dataUID, nsfwUID, true, bob);

      // ── Client-side NSFW filter: only show non-NSFW items ──
      const allVacation = await fileView.getFilesAtPath(vacationUID, [aliceAddr], dataSchemaUID, 0, 50);
      const safeVacation = [];
      for (const item of allVacation) {
        const isNsfw = await tagResolver.isActivelyTagged(item.uid, nsfwUID);
        if (!isNsfw) safeVacation.push(item);
      }
      expect(safeVacation.length).to.equal(2); // photo1 and photo2v2

      // ── Tree visibility: alice visible up to root ──
      expect(await indexer.containsAttestations(vacationUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(photosUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);

      // Bob hasn't tagged anything at these paths, so no containsAttestations
      // (Bob's NSFW tag definition is /tags/nsfw, not /photos/vacation/)
      expect(await indexer.containsAttestations(vacationUID, bobAddr)).to.equal(false);

      // ── Dedup: re-uploading same beach photo returns same canonical ──
      expect(await fileView.getCanonicalData(photo1.contentHash)).to.equal(photo1.dataUID);
    });
  });
});
