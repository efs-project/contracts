/**
 * EFS Data Model — End-to-End Integration Tests
 *
 * Exercises the full three-layer data model (Paths → Data → Mirrors) through
 * realistic user workflows under the ADR-0041 PIN/TAG split.
 *
 * Predicate-cardinality routing:
 *   - File placement (DATA at folder anchor)            → PIN  (singleton)
 *   - PROPERTY value binding (contentType, name, etc.)  → PIN  (singleton)
 *   - Sub-folder visibility under dataSchemaUID         → TAG  (cardinality N)
 *   - Descriptive labels (#nsfw, #spoiler)              → TAG  (cardinality N)
 *
 * Removal semantics: there is no `applies=false` — placements/labels are removed
 * via `eas.revoke()` on the active edge UID. PIN replacement is in-place
 * supersession by attesting at the same (def, attester, schema) slot with a
 * different target.
 */
import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EdgeResolver, MirrorResolver, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, ZeroHash } from "ethers";
import { deployIndexerProxy } from "./helpers/deployIndexerProxy";
import { deployResolverProxy } from "./helpers/deployResolverProxy";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;
const DEFAULT_TAG_WEIGHT = 1n;

describe("EFS Data Model — E2E Integration", function () {
  let indexer: EFSIndexer;
  let edgeResolver: EdgeResolver;
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
  let pinSchemaUID: string;
  let tagSchemaUID: string;
  let mirrorSchemaUID: string;

  let rootUID: string;

  // Transport anchors (created in beforeEach)
  let transportsUID: string;
  let onchainTransportUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let magnetTransportUID: string;
  let httpsTransportUID: string;

  const enc = new ethers.AbiCoder();

  // Active-edge index used by the helpers to look up the live UID for revocation.
  // Keys: `${target}|${definition}|${attester}` → live attestation UID.
  let activePinIndex: Map<string, string>;
  let activeTagIndex: Map<string, string>;

  // ─── Encoding Helpers ─────────────────────────────────────────────────────

  const encodeAnchor = (name: string, schema: string = ZERO_BYTES32) =>
    enc.encode(["string", "bytes32"], [name, schema]);

  const encodePropertyValue = (value: string) => enc.encode(["string"], [value]);

  const encodePin = (definition: string) => enc.encode(["bytes32"], [definition]);

  const encodeTag = (definition: string, weight: bigint) => enc.encode(["bytes32", "int256"], [definition, weight]);

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

  // DATA is an empty schema — pure identity (ADR-0049). The `_contentHash`/`_size` params are
  // ignored (kept so call sites read clearly about what the DATA stands for); the DATA itself
  // carries no inline payload.
  async function createData(_contentHash: string, _size: bigint, signer: Signer = owner): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: "0x",
        value: 0n,
      },
    });
    return getUID(await tx.wait());
  }

  /**
   * Attach a PROPERTY value to a container using the unified free-floating model
   * (ADR-0035 / ADR-0041): key anchor under the container, free-floating
   * PROPERTY(value), and a PIN binding them. Returns the PROPERTY UID.
   *
   * Binding cardinality is 1 (a key has one current value) — therefore PIN, not TAG.
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

    // PIN binds the value to the key anchor. Re-binding under the same key auto-supersedes.
    await pinTarget(propertyUID, keyAnchorUID, signer);
    return propertyUID;
  }

  /**
   * PIN a target to a definition (file placement, PROPERTY value binding).
   * Cardinality 1: re-attesting on the same (def, attester, schema) slot
   * supersedes the prior PIN automatically.
   */
  async function pinTarget(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<string> {
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

  /**
   * Revoke the live PIN for (target, def, attester). Idempotent — does nothing
   * if there is no active PIN.
   */
  async function unpinTarget(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<void> {
    const key = `${targetUID}|${definitionUID}|${await signer.getAddress()}`;
    const uid = activePinIndex.get(key);
    if (uid === undefined) return;
    await eas.connect(signer).revoke({
      schema: pinSchemaUID,
      data: { uid, value: 0n },
    });
    activePinIndex.delete(key);
  }

  /**
   * TAG a target with a definition (sub-folder visibility, descriptive labels).
   * Cardinality N: each new attestation accumulates in the active set.
   * Default weight is 1 (active, no sort key in use).
   */
  async function tagTarget(
    targetUID: string,
    definitionUID: string,
    signer: Signer = owner,
    weight: bigint = DEFAULT_TAG_WEIGHT,
  ): Promise<string> {
    const tx = await eas.connect(signer).attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: encodeTag(definitionUID, weight),
        value: 0n,
      },
    });
    const uid = getUID(await tx.wait());
    activeTagIndex.set(`${targetUID}|${definitionUID}|${await signer.getAddress()}`, uid);
    return uid;
  }

  /** Revoke the live TAG for (target, def, attester). */
  async function untagTarget(targetUID: string, definitionUID: string, signer: Signer = owner): Promise<void> {
    const key = `${targetUID}|${definitionUID}|${await signer.getAddress()}`;
    const uid = activeTagIndex.get(key);
    if (uid === undefined) return;
    await eas.connect(signer).revoke({
      schema: tagSchemaUID,
      data: { uid, value: 0n },
    });
    activeTagIndex.delete(key);
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
   * Full file upload mirroring the production seed pattern (`scripts/seed-impl.ts`):
   *   1. Filename anchor under `folderUID` with `schema=DATA_SCHEMA_UID` ("file slot").
   *   2. Standalone DATA (refUID=0x0) carrying contentHash + size.
   *   3. PROPERTY(contentType) bound to DATA via PIN under the contentType key anchor.
   *   4. MIRROR(refUID=DATA) for retrieval.
   *   5. PIN(target=DATA, definition=fileSlot) — Shape A placement (cardinality 1
   *      per attester per file slot, so PIN, not TAG).
   *
   * The optional `name` param lets tests place files predictably; otherwise an
   * auto-incremented unique name is used so multiple uploads don't collide on
   * `(parent, name, schema)`.
   *
   * Returns { fileSlotUID, dataUID, propertyUID, mirrorUID, pinUID, contentHash }.
   */
  let _uploadCounter = 0;
  async function uploadFile(
    content: string,
    contentType: string,
    transportUID: string,
    mirrorUri: string,
    folderUID: string,
    signer: Signer = owner,
    name?: string,
  ) {
    const contentHash = hash(content);
    const size = BigInt(Buffer.from(content).length);
    const fileName = name ?? `file-${_uploadCounter++}.bin`;

    // Reuse an existing file slot if one already exists at (folder, name, DATA_SCHEMA);
    // otherwise create one. Mirrors the `findAnchor` / `makeAnchor` idempotency in
    // the production seed.
    let fileSlotUID = await indexer.resolveAnchor(folderUID, fileName, dataSchemaUID);
    if (fileSlotUID === ZERO_BYTES32) {
      fileSlotUID = await createAnchor(folderUID, fileName, dataSchemaUID, signer);
    }

    const dataUID = await createData(contentHash, size, signer);
    const propertyUID = await createProperty(dataUID, "contentType", contentType, signer);
    const mirrorUID = await createMirror(dataUID, transportUID, mirrorUri, signer);
    const pinUID = await pinTarget(dataUID, fileSlotUID, signer);

    return { fileSlotUID, dataUID, propertyUID, mirrorUID, pinUID, contentHash };
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();
    const ownerAddr = await owner.getAddress();

    activePinIndex = new Map();
    activeTagIndex = new Map();

    // Deploy EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction (EdgeResolver, MirrorResolver, and EFSIndexer are all proxy-ified, ADR-0048):
    //   nonce+0:  EdgeResolver implementation deploy
    //   nonce+1:  EdgeResolver proxy deploy (the resolver baked into the PIN/TAG schema UIDs)
    //   nonce+2:  MirrorResolver implementation deploy
    //   nonce+3:  MirrorResolver proxy deploy (the resolver baked into the MIRROR schema UID)
    //   nonce+4..9: 6 schema registrations (anchor, property, data, PIN, TAG, mirror)
    //   nonce+10: EFSIndexer implementation deploy
    //   nonce+11: EFSIndexer proxy deploy (the resolver baked into the EFS schema UIDs)
    const currentNonce = await ethers.provider.getTransactionCount(ownerAddr);
    // EdgeResolver PROXY is the resolver (ADR-0048): impl = +0, proxy = +1. See deployResolverProxy().
    const futureEdgeResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 1 });
    // MirrorResolver PROXY is the resolver (ADR-0048): impl = +2, proxy = +3.
    const futureMirrorResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 3 });
    // EFSIndexer PROXY is the resolver (ADR-0048): impl = +10, proxy = +11. See deployIndexerProxy().
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 11 });

    // Pre-compute schema UIDs
    anchorSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string name, bytes32 forSchema", futureIndexerAddr, false],
    );
    propertySchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["string value", futureIndexerAddr, false],
    );
    // DATA is an empty schema — pure identity (ADR-0049).
    dataSchemaUID = ethers.solidityPackedKeccak256(["string", "address", "bool"], ["", futureIndexerAddr, false]);
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

    // Deploy resolvers. EdgeResolver behind a proxy (ADR-0048): impl + proxy; initialize() sets the
    // PIN/TAG schema UIDs + partner refs. The proxy address is baked into the PIN/TAG schema UIDs.
    edgeResolver = await deployResolverProxy<EdgeResolver>(
      "EdgeResolver",
      [await eas.getAddress()],
      [pinSchemaUID, tagSchemaUID, futureIndexerAddr, await registry.getAddress()],
      owner,
    );
    expect(await edgeResolver.getAddress()).to.equal(futureEdgeResolverAddr);

    // MirrorResolver behind a proxy (ADR-0048): impl + proxy; initialize() wires the (predicted)
    // indexer proxy address + owner. The proxy address is baked into the MIRROR schema UID.
    mirrorResolver = await deployResolverProxy<MirrorResolver>(
      "MirrorResolver",
      [await eas.getAddress()],
      [futureIndexerAddr, ownerAddr],
      owner,
    );
    expect(await mirrorResolver.getAddress()).to.equal(futureMirrorResolverAddr);

    // Register schemas
    await (await registry.register("string name, bytes32 forSchema", futureIndexerAddr, false)).wait();
    await (await registry.register("string value", futureIndexerAddr, false)).wait();
    await (await registry.register("", futureIndexerAddr, false)).wait(); // DATA: empty schema (ADR-0049)
    await (await registry.register("bytes32 definition", await edgeResolver.getAddress(), true)).wait();
    await (await registry.register("bytes32 definition, int256 weight", await edgeResolver.getAddress(), true)).wait();
    await (
      await registry.register("bytes32 transportDefinition, string uri", await mirrorResolver.getAddress(), true)
    ).wait();

    // Deploy Indexer behind a proxy (ADR-0048)
    indexer = await deployIndexerProxy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      owner,
    );
    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy FileView
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await edgeResolver.getAddress(), ZeroAddress);

    // Wire contracts
    await indexer.wireContracts(
      await edgeResolver.getAddress(),
      pinSchemaUID,
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

    // Wire /transports/ ancestry into MirrorResolver
    await mirrorResolver.setTransportsAnchor(transportsUID);
  });

  // =========================================================================
  // 1. FULL UPLOAD FLOWS
  // =========================================================================

  describe("Full Upload Flows", function () {
    let docsUID: string;

    beforeEach(async function () {
      docsUID = await createAnchor(rootUID, "docs");
    });

    it("on-chain upload: DATA + contentType PROPERTY + onchain MIRROR + PIN placement", async function () {
      const { dataUID, fileSlotUID } = await uploadFile(
        "# Hello World\nSome markdown content.",
        "text/markdown",
        onchainTransportUID,
        "web3://0x1234567890AbCdEf1234567890AbCdEf12345678",
        docsUID,
        owner,
        "hello.md",
      );

      // Verify DATA is standalone and empty (ADR-0049 — pure identity, no inline fields)
      const att = await eas.getAttestation(dataUID);
      expect(att.refUID).to.equal(ZERO_BYTES32);
      expect(att.revocable).to.equal(false);
      expect(att.data).to.equal("0x");

      // AGENT-NOTE: dropped the `dataByContentKey` dedup-key assertion — DATA is empty (ADR-0049)
      // and carries no contentHash; dedup is now property-index + REDIRECT work (ADR-0050).

      // Verify contentType PROPERTY exists (PIN-bound under key anchor — ADR-0041)
      const ctKeyAnchor = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
      expect(ctKeyAnchor).to.not.equal(ZERO_BYTES32);
      const ownerAddrForCT = await owner.getAddress();
      const ctPropertyUID = await edgeResolver.getActivePinTarget(ctKeyAnchor, ownerAddrForCT, propertySchemaUID);
      expect(ctPropertyUID).to.not.equal(ZERO_BYTES32);
      const propAtt = await eas.getAttestation(ctPropertyUID);
      const [decodedValue] = enc.decode(["string"], propAtt.data);
      expect(decodedValue).to.equal("text/markdown");

      // Verify onchain MIRROR exists
      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].transportDefinition).to.equal(onchainTransportUID);
      expect(mirrors[0].uri).to.equal("web3://0x1234567890AbCdEf1234567890AbCdEf12345678");

      // Verify PIN placement: file slot anchor under /docs/, DATA pinned at the slot.
      const ownerAddr = await owner.getAddress();
      const dirItems = (
        await fileView.getDirectoryPageBySchemaAndAddressList(docsUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(dirItems.length).to.equal(1);
      expect(dirItems[0].uid).to.equal(fileSlotUID);
      expect(dirItems[0].name).to.equal("hello.md");
      expect(dirItems[0].schema).to.equal(dataSchemaUID);

      // O(1) PIN read at the slot returns the active DATA — primary Shape A read.
      expect(await edgeResolver.getActivePinTarget(fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(dataUID);

      // `getFilesAtPath(slot, …)` then resolves to the underlying DATA itself.
      const slotItems = (await fileView.getFilesAtPath(fileSlotUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(slotItems.length).to.equal(1);
      expect(slotItems[0].uid).to.equal(dataUID);
      expect(slotItems[0].hasData).to.equal(true);
      // DATA is empty (ADR-0049); contentHash is no longer an inline field → listing surfaces 0.
      expect(slotItems[0].contentHash).to.equal(ZERO_BYTES32);
    });

    it("IPFS paste: DATA + contentType + ipfs MIRROR + PIN placement", async function () {
      const content = '{"name":"Cool NFT","image":"ipfs://QmImage"}';
      const { dataUID } = await uploadFile(
        content,
        "application/json",
        ipfsTransportUID,
        "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].transportDefinition).to.equal(ipfsTransportUID);
      expect(mirrors[0].uri).to.equal("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    });

    it("Arweave paste: DATA + contentType + arweave MIRROR + PIN placement", async function () {
      const { dataUID } = await uploadFile(
        "<html><body>Permaweb page</body></html>",
        "text/html",
        arweaveTransportUID,
        "ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors[0].transportDefinition).to.equal(arweaveTransportUID);
      expect(mirrors[0].uri).to.equal("ar://bNbA3TEQVL60xlgCcqdz4ZPHFZ711cZ3hmkpGttDt_U");
    });

    it("Magnet link paste: DATA + magnet MIRROR + PIN", async function () {
      const magnetUri = "magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=test.iso";
      const { dataUID } = await uploadFile(
        "large file content placeholder",
        "application/octet-stream",
        magnetTransportUID,
        magnetUri,
        docsUID,
      );

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors[0].transportDefinition).to.equal(magnetTransportUID);
      expect(mirrors[0].uri).to.equal(magnetUri);
    });

    it("HTTPS link paste: DATA + https MIRROR + PIN", async function () {
      const { dataUID } = await uploadFile(
        "remote hosted content",
        "image/png",
        httpsTransportUID,
        "https://example.com/images/photo.png",
        docsUID,
      );

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
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

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
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

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
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

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(2);
    });
  });

  // =========================================================================
  // 3. PROPERTY METADATA
  // =========================================================================

  describe("PROPERTY Metadata on DATA", function () {
    it("should store contentType as PROPERTY (PIN-bound)", async function () {
      const ownerAddr = await owner.getAddress();
      const dataUID = await createData(hash("typed file"), 10n);
      await createProperty(dataUID, "contentType", "image/jpeg");

      const keyAnchor = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
      expect(keyAnchor).to.not.equal(ZERO_BYTES32);
      const propUID = await edgeResolver.getActivePinTarget(keyAnchor, ownerAddr, propertySchemaUID);
      expect(propUID).to.not.equal(ZERO_BYTES32);

      const propAtt = await eas.getAttestation(propUID);
      const [val] = enc.decode(["string"], propAtt.data);
      expect(val).to.equal("image/jpeg");
    });

    it("should store previousVersion as PROPERTY linking two DATAs", async function () {
      const ownerAddr = await owner.getAddress();
      const v1Hash = hash("version 1 content");
      const v1 = await createData(v1Hash, 17n);

      const v2Hash = hash("version 2 content");
      const v2 = await createData(v2Hash, 17n);

      // Attach previousVersion PROPERTY to v2 referencing v1
      await createProperty(v2, "previousVersion", v1);

      const keyAnchor = await indexer.resolveAnchor(v2, "previousVersion", propertySchemaUID);
      expect(keyAnchor).to.not.equal(ZERO_BYTES32);
      const propUID = await edgeResolver.getActivePinTarget(keyAnchor, ownerAddr, propertySchemaUID);
      expect(propUID).to.not.equal(ZERO_BYTES32);
      const propAtt = await eas.getAttestation(propUID);
      const [prevVersion] = enc.decode(["string"], propAtt.data);
      expect(prevVersion).to.equal(v1);
    });

    it("should allow multiple PROPERTYs on same DATA (contentType + description)", async function () {
      const ownerAddr = await owner.getAddress();
      const dataUID = await createData(hash("multi prop"), 10n);
      await createProperty(dataUID, "contentType", "text/html");
      await createProperty(dataUID, "description", "A cool webpage");

      const ctAnchor = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
      const descAnchor = await indexer.resolveAnchor(dataUID, "description", propertySchemaUID);
      expect(ctAnchor).to.not.equal(ZERO_BYTES32);
      expect(descAnchor).to.not.equal(ZERO_BYTES32);

      expect(await edgeResolver.getActivePinTarget(ctAnchor, ownerAddr, propertySchemaUID)).to.not.equal(ZERO_BYTES32);
      expect(await edgeResolver.getActivePinTarget(descAnchor, ownerAddr, propertySchemaUID)).to.not.equal(
        ZERO_BYTES32,
      );
    });

    it("PROPERTY rebind supersedes the prior value (PIN cardinality 1)", async function () {
      // Resolves the historical ADR-0035 "PROPERTY singleton" flaw: with PIN, the new
      // value replaces the old in O(1) and no read-side newest-by-time scan is needed.
      const ownerAddr = await owner.getAddress();
      const dataUID = await createData(hash("rebind test"), 10n);

      await createProperty(dataUID, "contentType", "text/plain");
      await createProperty(dataUID, "contentType", "text/markdown");
      await createProperty(dataUID, "contentType", "text/html");

      const keyAnchor = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
      const liveProp = await edgeResolver.getActivePinTarget(keyAnchor, ownerAddr, propertySchemaUID);
      const att = await eas.getAttestation(liveProp);
      const [val] = enc.decode(["string"], att.data);
      expect(val).to.equal("text/html");
    });
  });

  // =========================================================================
  // 4. PIN-BASED FILE PLACEMENT & FOLDER LISTING
  // =========================================================================

  describe("PIN-based Folder Listing", function () {
    let memesUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");
    });

    it("should list file slots at a path via getDirectoryPageBySchemaAndAddressList", async function () {
      const ownerAddr = await owner.getAddress();

      // Upload 3 files to /memes/ — each gets its own filename anchor (file slot).
      const f1 = await uploadFile(
        "cat.jpg bytes",
        "image/jpeg",
        onchainTransportUID,
        "web3://0xCat",
        memesUID,
        owner,
        "cat.jpg",
      );
      const f2 = await uploadFile(
        "dog.png bytes",
        "image/png",
        onchainTransportUID,
        "web3://0xDog",
        memesUID,
        owner,
        "dog.png",
      );
      const f3 = await uploadFile(
        "meme.gif bytes",
        "image/gif",
        onchainTransportUID,
        "web3://0xMeme",
        memesUID,
        owner,
        "meme.gif",
      );

      // Listing /memes/ via the schema-scoped, attester-scoped page reader returns
      // all three filename anchors (Phase 1 — direct child anchors of schema=DATA
      // attested by `owner`).
      const items = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(items.length).to.equal(3);

      const slotUIDs = items.map((i: any) => i.uid);
      expect(slotUIDs).to.include(f1.fileSlotUID);
      expect(slotUIDs).to.include(f2.fileSlotUID);
      expect(slotUIDs).to.include(f3.fileSlotUID);

      // Each slot is a "file" (anchor with schema=DATA → not a folder per the
      // FileSystemItem semantics: isFolder = anchorType==bytes32(0)).
      for (const item of items) {
        expect(item.isFolder).to.equal(false);
        expect(item.schema).to.equal(dataSchemaUID);
      }

      // The actual DATA pinned at each slot is reachable in O(1) via getActivePinTarget.
      expect(await edgeResolver.getActivePinTarget(f1.fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(f1.dataUID);
      expect(await edgeResolver.getActivePinTarget(f2.fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(f2.dataUID);
      expect(await edgeResolver.getActivePinTarget(f3.fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(f3.dataUID);
    });

    it("should list TAG-visible sub-folders via Phase 0", async function () {
      const ownerAddr = await owner.getAddress();

      // Create sub-folders under /memes/. Generic anchors (schema=0) — these are
      // the folder shape that visibility TAGs target.
      const funnyUID = await createAnchor(memesUID, "funny");
      const catsUID = await createAnchor(memesUID, "cats");

      // Folder visibility (per seed-impl.ts `walkAncestorVisibility`): the attester
      // TAGs each subfolder with `definition=dataSchemaUID` to declare "this folder
      // is part of my lens and contains data." Cardinality N — many subfolders
      // can carry the same definition under the same attester, so TAG (not PIN).
      await tagTarget(funnyUID, dataSchemaUID);
      await tagTarget(catsUID, dataSchemaUID);

      // Phase 0 of the schema-scoped page reader gathers child anchors carrying an
      // active edge under `anchorSchema=dataSchemaUID`. Phase 1 fires too but
      // returns nothing here (no DATA-schema'd file slots under /memes/).
      const items = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(items.length).to.equal(2);

      const names = items.map((i: any) => i.name).sort();
      expect(names).to.deep.equal(["cats", "funny"]);

      for (const item of items) {
        expect(item.isFolder).to.equal(true);
      }
    });

    it("should show mixed content: file slots and sub-folders surface in one call", async function () {
      const ownerAddr = await owner.getAddress();

      // Files: each gets its own filename anchor (file slot) with schema=DATA_SCHEMA.
      await uploadFile("file1", "text/plain", onchainTransportUID, "web3://0x1", memesUID, owner, "f1.txt");
      await uploadFile("file2", "text/plain", onchainTransportUID, "web3://0x2", memesUID, owner, "f2.txt");

      // Sub-folder is a generic anchor (schema=0) the attester TAGs as visible.
      const subUID = await createAnchor(memesUID, "subfolder");
      await tagTarget(subUID, dataSchemaUID);

      // Single call surfaces both: Phase 0 returns the TAG-visible subfolder
      // (`subfolder`), Phase 1 returns the two file-slot anchors (`f1.txt`, `f2.txt`).
      // Production directory listings rely on this combined output.
      const items = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(items.length).to.equal(3);

      const names = items.map((i: any) => i.name).sort();
      expect(names).to.deep.equal(["f1.txt", "f2.txt", "subfolder"]);

      const fileSlots = items.filter((i: any) => i.schema === dataSchemaUID);
      const folders = items.filter((i: any) => i.isFolder);
      expect(fileSlots.length).to.equal(2);
      expect(folders.length).to.equal(1);
      expect(folders[0].name).to.equal("subfolder");
    });

    it("should remove a file from listing when its PIN is revoked", async function () {
      const ownerAddr = await owner.getAddress();
      const { dataUID, fileSlotUID } = await uploadFile(
        "removeme",
        "text/plain",
        onchainTransportUID,
        "web3://0x1",
        memesUID,
      );

      // Slot is listed and the active DATA is reachable in O(1) via PIN.
      const items = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(items.length).to.equal(1);
      expect(await edgeResolver.getActivePinTarget(fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(dataUID);

      // Revoke the PIN. The file slot anchor itself remains (anchors are non-revocable
      // and append-only), but its active PIN target is now zero.
      await unpinTarget(dataUID, fileSlotUID);
      expect(await edgeResolver.getActivePinTarget(fileSlotUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);

      // The slot anchor is still listed (it's a non-revocable child of `memesUID`),
      // but `getFilesAtPath(slot, …)` resolves to nothing.
      const slotItems = (await fileView.getFilesAtPath(fileSlotUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(slotItems.length).to.equal(0);

      // DATA itself still exists.
      const att = await eas.getAttestation(dataUID);
      expect(att.uid).to.equal(dataUID);
    });

    it("should show empty folder (no items pinned)", async function () {
      const ownerAddr = await owner.getAddress();
      const emptyUID = await createAnchor(rootUID, "empty-folder");

      const items = (await fileView.getFilesAtPath(emptyUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items.length).to.equal(0);
    });
  });

  // =========================================================================
  // 5. CROSS-REFERENCING (same DATA in multiple folders)
  // =========================================================================

  describe("Cross-Referencing", function () {
    it("same DATA pinned at two different paths shares metadata and mirrors", async function () {
      const ownerAddr = await owner.getAddress();
      const memesUID = await createAnchor(rootUID, "memes");
      const animalsUID = await createAnchor(rootUID, "animals");

      // Create DATA + contentType + mirror once
      const contentHash = hash("cat picture shared");
      const dataUID = await createData(contentHash, 18n);
      await createProperty(dataUID, "contentType", "image/jpeg");
      await createMirror(dataUID, ipfsTransportUID, "ipfs://QmSharedCat");

      // PIN at both /memes/ and /animals/ — different definitions, both cardinality 1 per slot
      await pinTarget(dataUID, memesUID);
      await pinTarget(dataUID, animalsUID);

      // Both paths list the DATA
      const memesItems = (await fileView.getFilesAtPath(memesUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      const animalsItems = (await fileView.getFilesAtPath(animalsUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(memesItems.length).to.equal(1);
      expect(animalsItems.length).to.equal(1);
      expect(memesItems[0].uid).to.equal(dataUID);
      expect(animalsItems[0].uid).to.equal(dataUID);

      // Shared mirrors
      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].uri).to.equal("ipfs://QmSharedCat");
    });

    it("removing DATA from one path doesn't affect the other", async function () {
      const ownerAddr = await owner.getAddress();
      const path1 = await createAnchor(rootUID, "path1");
      const path2 = await createAnchor(rootUID, "path2");

      const dataUID = await createData(hash("shared file"), 11n);
      await pinTarget(dataUID, path1);
      await pinTarget(dataUID, path2);

      // Remove from path1
      await unpinTarget(dataUID, path1);

      const items1 = (await fileView.getFilesAtPath(path1, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      const items2 = (await fileView.getFilesAtPath(path2, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items1.length).to.equal(0);
      expect(items2.length).to.equal(1);
    });
  });

  // =========================================================================
  // 6. FILE VERSIONING
  // =========================================================================

  describe("File Versioning", function () {
    it("should replace file: revoke old PIN, attest new PIN, link via previousVersion", async function () {
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

      // Revoke v1's PIN, place v2's PIN
      await unpinTarget(v1.dataUID, docsUID);
      await pinTarget(v2DataUID, docsUID);

      // Only v2 should appear
      const items = (await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(v2DataUID);

      // v1 DATA still exists on-chain (non-revocable)
      const v1Att = await eas.getAttestation(v1.dataUID);
      expect(v1Att.uid).to.equal(v1.dataUID);

      // Version chain is traversable via PROPERTY (unified model — two key anchors)
      const v2ContentTypeAnchor = await indexer.resolveAnchor(v2DataUID, "contentType", propertySchemaUID);
      const v2PrevVersionAnchor = await indexer.resolveAnchor(v2DataUID, "previousVersion", propertySchemaUID);
      expect(v2ContentTypeAnchor).to.not.equal(ZERO_BYTES32);
      expect(v2PrevVersionAnchor).to.not.equal(ZERO_BYTES32);
    });

    it("should handle three-version chain", async function () {
      const docsUID = await createAnchor(rootUID, "docs");

      const v1 = await createData(hash("v1"), 2n);
      await pinTarget(v1, docsUID);

      const v2 = await createData(hash("v2"), 2n);
      await createProperty(v2, "previousVersion", v1); // previousVersion
      await unpinTarget(v1, docsUID);
      await pinTarget(v2, docsUID);

      const v3 = await createData(hash("v3"), 2n);
      await createProperty(v3, "previousVersion", v2); // previousVersion
      await unpinTarget(v2, docsUID);
      await pinTarget(v3, docsUID);

      // Only v3 should be in the folder
      const ownerAddr = await owner.getAddress();
      const items = (await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(v3);

      // All three DATAs still exist
      expect((await eas.getAttestation(v1)).uid).to.equal(v1);
      expect((await eas.getAttestation(v2)).uid).to.equal(v2);
      expect((await eas.getAttestation(v3)).uid).to.equal(v3);
    });
  });

  // =========================================================================
  // 7. CONTENT DEDUP — removed at the DATA layer (ADR-0049)
  // =========================================================================

  // AGENT-NOTE: the old "Content Dedup" block tested `indexer.dataByContentKey` canonicalization
  // (first-created-wins) and `fileView.getCanonicalData` returning that canonical UID. DATA is
  // now an empty schema (ADR-0049) carrying no contentHash, so there is no intrinsic content-hash
  // index and `dataByContentKey` is no longer written. Dedup *prevention* is best-effort
  // client-side (query the property index before upload); dedup *resolution* is the REDIRECT
  // primitive (ADR-0050). Both are future PROPERTY/SDK work, out of scope here.
  describe("Content Dedup (deprecated, ADR-0049)", function () {
    it("getCanonicalData is a deprecated no-op returning bytes32(0)", async function () {
      // Even for content that has been "uploaded", the reverse lookup no longer resolves —
      // identical bytes now mint distinct DATA UIDs and there is no canonical index.
      const contentHash = hash("identical bytes");
      const first = await createData(contentHash, 15n);
      const second = await createData(contentHash, 15n);

      expect(first).to.not.equal(second); // identical bytes → distinct DATA UIDs (no dedup)
      expect(await fileView.getCanonicalData(contentHash)).to.equal(ZERO_BYTES32);
    });
  });

  // =========================================================================
  // 8. LENSES (multi-attester scenarios)
  // =========================================================================

  describe("Lenses (Multi-Attester)", function () {
    let memesUID: string;

    beforeEach(async function () {
      memesUID = await createAnchor(rootUID, "memes");
    });

    it("each attester has independent lens at the same file slot", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Shared file slot (filename anchor created by alice — could be anyone).
      const slotUID = await createAnchor(memesUID, "cat.jpg", dataSchemaUID, alice);

      // Alice's lens.
      const aliceData = await createData(hash("alice cat"), 9n, alice);
      await pinTarget(aliceData, slotUID, alice);

      // Bob's lens — same slot, different DATA.
      const bobData = await createData(hash("bob cat"), 7n, bob);
      await pinTarget(bobData, slotUID, bob);

      // Per-attester O(1) PIN read at the slot — exactly the production pattern
      // for "render this file slot under <attester>'s lens." First-attester-wins
      // resolution (ADR-0031) is done by trying each attester in order and taking
      // the first non-zero target.
      expect(await edgeResolver.getActivePinTarget(slotUID, aliceAddr, dataSchemaUID)).to.equal(aliceData);
      expect(await edgeResolver.getActivePinTarget(slotUID, bobAddr, dataSchemaUID)).to.equal(bobData);

      // `getFilesAtPath(slot, …)` returns ALL lenses of a slot — one DirectoryItem
      // per attester whose PIN target hasn't already been claimed by an earlier
      // attester (cross-attester dedup is by target UID, not by slot). When alice
      // and bob PIN *different* DATAs to the same slot, both surface. Higher-level
      // first-attester-wins rendering uses `getActivePinTarget` directly.
      const bothLenses = (await fileView.getFilesAtPath(slotUID, [aliceAddr, bobAddr], dataSchemaUID, "0x", 50)).items;
      expect(bothLenses.length).to.equal(2);
      const lensTargets = bothLenses.map((i: any) => i.uid).sort();
      expect(lensTargets).to.deep.equal([aliceData, bobData].sort());
    });

    it("multiple attesters, multiple file slots: directory listing surfaces all slots", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Two slots, each PINned to its own DATA by different attesters.
      const slotShared = await createAnchor(memesUID, "shared.png", dataSchemaUID, alice);
      const slotAliceOnly = await createAnchor(memesUID, "alice-only.png", dataSchemaUID, alice);

      // Both attesters PIN distinct DATAs to the shared slot (different lenses of the same file).
      const aliceShared = await createData(hash("alice's shared"), 11n, alice);
      const bobShared = await createData(hash("bob's shared"), 11n, bob);
      await pinTarget(aliceShared, slotShared, alice);
      await pinTarget(bobShared, slotShared, bob);

      // Alice has an additional file slot only she uses.
      const aliceUnique = await createData(hash("alice unique"), 10n, alice);
      await pinTarget(aliceUnique, slotAliceOnly, alice);

      // Directory listing: both file slots appear (both created by alice, attester
      // filter accepts alice). Bob isn't in the attester list for the directory
      // call but the slots themselves are alice-attested anchors — which is what
      // the listing filters on.
      const items = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [aliceAddr, bobAddr], "0x", 50)
      ).items;
      expect(items.length).to.equal(2);
      const names = items.map((i: any) => i.name).sort();
      expect(names).to.deep.equal(["alice-only.png", "shared.png"]);
    });

    it("one attester removing PIN doesn't affect another attester at the same slot", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      // Shared slot, both lenses PIN their own DATA.
      const slotUID = await createAnchor(memesUID, "contested.png", dataSchemaUID, alice);
      const aliceData = await createData(hash("alice contested"), 9n, alice);
      const bobData = await createData(hash("bob contested"), 9n, bob);
      await pinTarget(aliceData, slotUID, alice);
      await pinTarget(bobData, slotUID, bob);

      // Alice revokes her PIN.
      await unpinTarget(aliceData, slotUID, alice);

      // Bob still sees his DATA at the slot; alice's slot is empty.
      expect(await edgeResolver.getActivePinTarget(slotUID, aliceAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
      expect(await edgeResolver.getActivePinTarget(slotUID, bobAddr, dataSchemaUID)).to.equal(bobData);
    });

    it("three attesters with overlapping files: correct unique count via directory listing", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const charlieAddr = await charlie.getAddress();

      // Three distinct file slots in the folder (one per file in the test scenario).
      // The slots are alice-attested for predictable listing membership.
      const slot1 = await createAnchor(memesUID, "f1.bin", dataSchemaUID, alice);
      const slot2 = await createAnchor(memesUID, "f2.bin", dataSchemaUID, alice);
      const slot3 = await createAnchor(memesUID, "f3.bin", dataSchemaUID, alice);

      const d1 = await createData(hash("d1"), 2n);
      const d2 = await createData(hash("d2"), 2n);
      const d3 = await createData(hash("d3"), 2n);

      // Lenses overlap on different slots.
      await pinTarget(d1, slot1, alice);
      await pinTarget(d2, slot2, alice);
      await pinTarget(d2, slot2, bob);
      await pinTarget(d3, slot3, bob);
      await pinTarget(d1, slot1, charlie);
      await pinTarget(d3, slot3, charlie);

      // Directory listing returns the 3 unique slots.
      const all = (
        await fileView.getDirectoryPageBySchemaAndAddressList(
          memesUID,
          dataSchemaUID,
          [aliceAddr, bobAddr, charlieAddr],
          "0x",
          50,
        )
      ).items;
      expect(all.length).to.equal(3);
      const names = all.map((i: any) => i.name).sort();
      expect(names).to.deep.equal(["f1.bin", "f2.bin", "f3.bin"]);

      // Spot-check: per-attester PIN resolution at each slot returns the right lens.
      expect(await edgeResolver.getActivePinTarget(slot2, aliceAddr, dataSchemaUID)).to.equal(d2);
      expect(await edgeResolver.getActivePinTarget(slot2, bobAddr, dataSchemaUID)).to.equal(d2);
      expect(await edgeResolver.getActivePinTarget(slot1, charlieAddr, dataSchemaUID)).to.equal(d1);
      expect(await edgeResolver.getActivePinTarget(slot3, charlieAddr, dataSchemaUID)).to.equal(d3);
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

    it("should TAG a DATA as NSFW and check via point lookup", async function () {
      const dataUID = await createData(hash("spicy content"), 14n);
      const ownerAddr = await owner.getAddress();

      await tagTarget(dataUID, nsfwUID);

      // Schema-aware point lookup: get the active TAG UID for (owner, data, nsfw, TAG)
      const tagUID = await edgeResolver.getActiveEdgeUID(ownerAddr, dataUID, nsfwUID, tagSchemaUID);
      expect(tagUID).to.not.equal(ZERO_BYTES32);

      // hasActiveEdge: true iff anyone (any schema, any attester) is asserting (target, def)
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(true);
    });

    it("should track active state across attesters via hasActiveEdgeFromAny", async function () {
      const dataUID = await createData(hash("maybe nsfw"), 10n);
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();
      const charlieAddr = await charlie.getAddress();

      // Initially not tagged
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(false);

      // Alice TAGs NSFW
      await tagTarget(dataUID, nsfwUID, alice);
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(true);
      expect(await edgeResolver.getActiveEdgeUID(aliceAddr, dataUID, nsfwUID, tagSchemaUID)).to.not.equal(ZERO_BYTES32);

      // Bob also TAGs NSFW
      await tagTarget(dataUID, nsfwUID, bob);
      expect(await edgeResolver.getActiveEdgeUID(bobAddr, dataUID, nsfwUID, tagSchemaUID)).to.not.equal(ZERO_BYTES32);

      // Charlie has never asserted NSFW. There is no "applies=false" anymore — we just
      // assert nothing on Charlie's behalf and the aggregate stays driven by Alice + Bob.
      expect(await edgeResolver.hasActiveEdgeFromAny(dataUID, nsfwUID, [charlieAddr])).to.equal(false);
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(true);

      // Alice changes mind → revoke
      await untagTarget(dataUID, nsfwUID, alice);
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(true);

      // Bob also changes mind → revoke. No more active TAGs.
      await untagTarget(dataUID, nsfwUID, bob);
      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(false);
    });

    it("should filter NSFW items from a folder listing (client-side pattern)", async function () {
      const memesUID = await createAnchor(rootUID, "memes");
      const ownerAddr = await owner.getAddress();

      // Three file slots, each PINned to its own DATA. Production model: every file
      // has its own filename anchor under the folder (cardinality 1 PIN per slot).
      const safeFile = await uploadFile(
        "safe meme",
        "image/png",
        onchainTransportUID,
        "web3://0xSafe",
        memesUID,
        owner,
        "safe.png",
      );
      const nsfwFile = await uploadFile(
        "nsfw meme",
        "image/png",
        onchainTransportUID,
        "web3://0xNsfw",
        memesUID,
        owner,
        "nsfw.png",
      );
      const alsoSafeFile = await uploadFile(
        "another safe",
        "image/png",
        onchainTransportUID,
        "web3://0xSafe2",
        memesUID,
        owner,
        "safe2.png",
      );

      // Mark the NSFW DATA as NSFW (TAG, not PIN — labels are cardinality N).
      await tagTarget(nsfwFile.dataUID, nsfwUID);

      // Directory listing returns the 3 file-slot anchors.
      const allItems = (
        await fileView.getDirectoryPageBySchemaAndAddressList(memesUID, dataSchemaUID, [ownerAddr], "0x", 50)
      ).items;
      expect(allItems.length).to.equal(3);

      // Client-side filter: for each slot, resolve the active DATA and check whether
      // it carries the NSFW label. Resolves via the same O(1) PIN read the production
      // FileBrowser uses.
      const filtered = [];
      for (const item of allItems) {
        const dataUID = await edgeResolver.getActivePinTarget(item.uid, ownerAddr, dataSchemaUID);
        const isNsfw = await edgeResolver.hasActiveEdge(dataUID, nsfwUID);
        if (!isNsfw) filtered.push(item);
      }
      expect(filtered.length).to.equal(2);
      const filteredNames = filtered.map((i: any) => i.name).sort();
      expect(filteredNames).to.deep.equal(["safe.png", "safe2.png"]);

      // Reference vars reachable so they're not stripped by tooling.
      expect(safeFile.dataUID).to.not.equal(ZERO_BYTES32);
      expect(alsoSafeFile.dataUID).to.not.equal(ZERO_BYTES32);
    });

    it("should support multiple labels on same DATA", async function () {
      const dataUID = await createData(hash("tagged content"), 14n);

      await tagTarget(dataUID, nsfwUID);
      await tagTarget(dataUID, spoilerUID);

      expect(await edgeResolver.hasActiveEdge(dataUID, nsfwUID)).to.equal(true);
      expect(await edgeResolver.hasActiveEdge(dataUID, spoilerUID)).to.equal(true);

      // Edge definitions for this DATA (PIN + TAG, schema-blind)
      const defCount = await edgeResolver.getEdgeDefinitionCount(dataUID);
      expect(defCount).to.be.gte(2n);
    });
  });

  // =========================================================================
  // 10. TREE VISIBILITY PROPAGATION (containsAttestations)
  // =========================================================================

  describe("Tree Visibility Propagation", function () {
    it("PIN-placing DATA at deep path propagates to all ancestors", async function () {
      const aliceAddr = await alice.getAddress();

      // /media/images/cats/funny/
      const mediaUID = await createAnchor(rootUID, "media");
      const imagesUID = await createAnchor(mediaUID, "images");
      const catsUID = await createAnchor(imagesUID, "cats");
      const funnyUID = await createAnchor(catsUID, "funny");

      const dataUID = await createData(hash("deep cat"), 8n);
      await pinTarget(dataUID, funnyUID, alice);

      // All ancestors should show containsAttestations for alice
      expect(await indexer.containsAttestations(funnyUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(catsUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(imagesUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(mediaUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);
    });

    it("propagation is per-attester (alice visible, bob not until bob places)", async function () {
      const aliceAddr = await alice.getAddress();
      const bobAddr = await bob.getAddress();

      const folderUID = await createAnchor(rootUID, "perm-test");
      const dataUID = await createData(hash("alice only data"), 15n);
      await pinTarget(dataUID, folderUID, alice);

      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(folderUID, bobAddr)).to.equal(false);

      // Now bob places something there too
      const bobData = await createData(hash("bob data"), 8n);
      await pinTarget(bobData, folderUID, bob);

      expect(await indexer.containsAttestations(folderUID, bobAddr)).to.equal(true);
    });

    it("early-exit optimization: second placement under same parent doesn't re-walk tree", async function () {
      const aliceAddr = await alice.getAddress();
      const folderUID = await createAnchor(rootUID, "opt-test");

      // Each file has its own filename slot under `folderUID` (production pattern —
      // PIN cardinality 1 per slot means two files cannot share one slot).
      const slot1 = await createAnchor(folderUID, "f1.bin", dataSchemaUID, alice);
      const slot2 = await createAnchor(folderUID, "f2.bin", dataSchemaUID, alice);

      const d1 = await createData(hash("d1"), 2n, alice);
      const d2 = await createData(hash("d2"), 2n, alice);

      // First PIN propagates `containsAttestations` up the ancestor chain.
      await pinTarget(d1, slot1, alice);
      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(true);

      // Second PIN at the *same parent folder* should early-exit in `propagateContains`
      // — the per-attester flag is already set on `folderUID`, so no further ancestor
      // walk is needed.
      await pinTarget(d2, slot2, alice);

      // Both PINs are live in their respective slots (PIN cardinality 1 per slot).
      const d1Live = await edgeResolver.getActiveEdgeUID(aliceAddr, d1, slot1, pinSchemaUID);
      const d2Live = await edgeResolver.getActiveEdgeUID(aliceAddr, d2, slot2, pinSchemaUID);
      expect(d1Live).to.not.equal(ZERO_BYTES32);
      expect(d2Live).to.not.equal(ZERO_BYTES32);
    });

    it("remove-then-readd does not duplicate entries in _childrenByAttester", async function () {
      // Regression: EdgeResolver.onRevoke clears _containsAttestations[folder][attester] when
      // the folder's per-attester edge count hits zero. If _propagateContains used
      // _containsAttestations as its dedup guard on a subsequent re-add, it would push
      // `folder` into _childrenByAttester[parent][attester] a second time — inflating
      // getChildrenByAttesterCount and producing duplicate entries in the children-by-attester
      // listing.
      //
      // The fix is a dedicated append-only dedup flag (_childInChildrenByAttester) that is
      // set on push and never cleared by clearContains.
      const aliceAddr = await alice.getAddress();
      const folderUID = await createAnchor(rootUID, "readd-dup-test");

      const d1 = await createData(hash("readd-d1"), 2n);
      await pinTarget(d1, folderUID, alice);

      // After first placement, folder is in alice's root children-by-attester exactly once.
      expect(await indexer.getChildrenByAttesterCount(rootUID, aliceAddr)).to.equal(1n);
      let children = await indexer.getChildrenByAttester(rootUID, aliceAddr, 0, 10, false, false);
      expect(children).to.deep.equal([folderUID]);

      // Revoke the only PIN. EdgeResolver will fire clearContains(folder, alice), flipping
      // _containsAttestations[folder][alice] to false while leaving _containsAttestations[root][alice]
      // intact (sticky at higher levels).
      await unpinTarget(d1, folderUID, alice);
      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(false);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);

      // Re-add under the same folder. _propagateContains walks: folder (flag cleared, re-enters loop;
      // BEFORE fix, pushes folder into root's children array AGAIN) → root (flag still true, break).
      const d2 = await createData(hash("readd-d2"), 2n);
      await pinTarget(d2, folderUID, alice);

      // Count and contents must remain 1/[folder] — the fix's guard prevents the second push.
      expect(await indexer.getChildrenByAttesterCount(rootUID, aliceAddr)).to.equal(1n);
      children = await indexer.getChildrenByAttester(rootUID, aliceAddr, 0, 10, false, false);
      expect(children).to.deep.equal([folderUID]);

      // Sanity: folder's flag is restored so it shows up in lens-filtered views again.
      expect(await indexer.containsAttestations(folderUID, aliceAddr)).to.equal(true);
    });
  });

  // =========================================================================
  // 11. SWAP-AND-POP ORDERING (TAG accumulation; PIN slot replacement)
  // =========================================================================

  describe("Swap-and-Pop Compact Index (TAG)", function () {
    // PIN is cardinality 1 — the swap-and-pop pattern only matters for TAG (cardinality N).
    // We exercise it via folder-visibility TAGs where the active set genuinely grows/shrinks.

    it("removing middle TAG preserves other TAGs", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-test");

      const sub1 = await createAnchor(folderUID, "sub1");
      const sub2 = await createAnchor(folderUID, "sub2");
      const sub3 = await createAnchor(folderUID, "sub3");

      await tagTarget(sub1, folderUID);
      await tagTarget(sub2, folderUID);
      await tagTarget(sub3, folderUID);

      expect(await edgeResolver.getActiveTagsCount(folderUID, ownerAddr, anchorSchemaUID)).to.equal(3n);

      // Remove middle TAG via revoke
      await untagTarget(sub2, folderUID);

      const remaining = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        anchorSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(2);
      expect(remaining).to.include(sub1);
      expect(remaining).to.include(sub3);
      expect(remaining).to.not.include(sub2);
    });

    it("removing first TAG works correctly", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-first");

      const sub1 = await createAnchor(folderUID, "first");
      const sub2 = await createAnchor(folderUID, "second");

      await tagTarget(sub1, folderUID);
      await tagTarget(sub2, folderUID);

      // Remove first
      await untagTarget(sub1, folderUID);

      const remaining = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        anchorSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(1);
      expect(remaining[0]).to.equal(sub2);
    });

    it("removing last TAG works correctly", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-last");

      const sub1 = await createAnchor(folderUID, "first-l");
      const sub2 = await createAnchor(folderUID, "last-l");

      await tagTarget(sub1, folderUID);
      await tagTarget(sub2, folderUID);

      // Remove last
      await untagTarget(sub2, folderUID);

      const remaining = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        anchorSchemaUID,
        0,
        10,
      );
      expect(remaining.length).to.equal(1);
      expect(remaining[0]).to.equal(sub1);
    });

    it("removing only TAG results in empty list", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-only");

      const sub1 = await createAnchor(folderUID, "lonely");
      await tagTarget(sub1, folderUID);
      await untagTarget(sub1, folderUID);

      expect(await edgeResolver.getActiveTagsCount(folderUID, ownerAddr, anchorSchemaUID)).to.equal(0n);
    });

    it("re-add after remove: item appears at end", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "swap-readd");

      const sub1 = await createAnchor(folderUID, "readd1");
      const sub2 = await createAnchor(folderUID, "readd2");
      const sub3 = await createAnchor(folderUID, "readd3");

      await tagTarget(sub1, folderUID);
      await tagTarget(sub2, folderUID);
      await tagTarget(sub3, folderUID);

      // Remove sub1, re-add sub1
      await untagTarget(sub1, folderUID);
      await tagTarget(sub1, folderUID);

      const items = await edgeResolver.getActiveTargetsByAttesterAndSchema(
        folderUID,
        ownerAddr,
        anchorSchemaUID,
        0,
        10,
      );
      expect(items.length).to.equal(3);
      // sub1 should be at the end now (after swap-and-pop removed it, re-push puts it at end)
      expect(items[2]).to.equal(sub1);
    });
  });

  // =========================================================================
  // 12. DISCOVERY INDICES
  // =========================================================================

  describe("Discovery Indices", function () {
    it("getEdgeDefinitions returns all definitions ever attested against a target (PIN + TAG)", async function () {
      const memesUID = await createAnchor(rootUID, "memes-disc");
      const animalsUID = await createAnchor(rootUID, "animals-disc");
      const tagsUID = await createAnchor(rootUID, "tags-disc");
      const nsfwUID = await createAnchor(tagsUID, "nsfw");

      const dataUID = await createData(hash("multi-edged"), 12n);

      // PIN at two folder paths, TAG with one label
      await pinTarget(dataUID, memesUID);
      await pinTarget(dataUID, animalsUID);
      await tagTarget(dataUID, nsfwUID);

      const defCount = await edgeResolver.getEdgeDefinitionCount(dataUID);
      expect(defCount).to.equal(3n);

      const defs = await edgeResolver.getEdgeDefinitions(dataUID, 0, 10);
      expect(defs).to.include(memesUID);
      expect(defs).to.include(animalsUID);
      expect(defs).to.include(nsfwUID);
    });

    it("getTargetsByDefinition returns all targets ever attested under a definition", async function () {
      const folderUID = await createAnchor(rootUID, "browse-test");

      const d1 = await createData(hash("browse1"), 7n);
      const d2 = await createData(hash("browse2"), 7n);
      const d3 = await createData(hash("browse3"), 7n);

      await pinTarget(d1, folderUID);
      await pinTarget(d2, folderUID);
      await pinTarget(d3, folderUID);

      const targetCount = await edgeResolver.getTargetsByDefinitionCount(folderUID);
      expect(targetCount).to.equal(3n);

      const targets = await edgeResolver.getTargetsByDefinition(folderUID, 0, 10);
      expect(targets).to.include(d1);
      expect(targets).to.include(d2);
      expect(targets).to.include(d3);
    });

    it("getTargetsByDefinition is append-only (revoked items still appear)", async function () {
      const folderUID = await createAnchor(rootUID, "append-test");

      const d1 = await createData(hash("append1"), 7n);
      await pinTarget(d1, folderUID);
      await unpinTarget(d1, folderUID); // revoke

      // Still in append-only list
      const targets = await edgeResolver.getTargetsByDefinition(folderUID, 0, 10);
      expect(targets).to.include(d1);
    });
  });

  // =========================================================================
  // 13. EDGE CASES
  // =========================================================================

  describe("Edge Cases", function () {
    it("PIN re-attestation at same slot supersedes the prior PIN (cardinality 1)", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "supersede");

      const d1 = await createData(hash("supersede-d1"), 4n);
      const d2 = await createData(hash("supersede-d2"), 4n);

      await pinTarget(d1, folderUID);
      // Re-attest at the same (def=folder, attester, schema=PIN) slot with a different
      // target → supersedes d1 in O(1).
      await pinTarget(d2, folderUID);

      const live = await edgeResolver.getActivePinTarget(folderUID, ownerAddr, dataSchemaUID);
      expect(live).to.equal(d2);

      // d1's PIN is no longer the active edge for the slot.
      // Folder listing should show only d2.
      const items = (await fileView.getFilesAtPath(folderUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items.length).to.equal(1);
      expect(items[0].uid).to.equal(d2);
    });

    it("revoking a never-attested PIN is a no-op (no underflow)", async function () {
      const folderUID = await createAnchor(rootUID, "no-underflow");
      const dataUID = await createData(hash("never-pinned"), 12n);

      // unpinTarget is a no-op when there's no live PIN — we never attested one.
      await unpinTarget(dataUID, folderUID);

      const ownerAddr = await owner.getAddress();
      expect(await edgeResolver.getActivePinTarget(folderUID, ownerAddr, dataSchemaUID)).to.equal(ZERO_BYTES32);
    });

    it("DATA with no mirrors is valid", async function () {
      const docsUID = await createAnchor(rootUID, "no-mirrors");
      const dataUID = await createData(hash("mirrorless"), 10n);
      await pinTarget(dataUID, docsUID);

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(0);

      // But it still appears in folder listing
      const ownerAddr = await owner.getAddress();
      const items = (await fileView.getFilesAtPath(docsUID, [ownerAddr], dataSchemaUID, "0x", 50)).items;
      expect(items.length).to.equal(1);
    });

    it("DATA with no PROPERTY is valid (no contentType)", async function () {
      const dataUID = await createData(hash("raw bytes"), 9n);
      // No key anchor was ever created under this DATA
      const keyAnchor = await indexer.resolveAnchor(dataUID, "contentType", propertySchemaUID);
      expect(keyAnchor).to.equal(ZERO_BYTES32);
    });

    it("mirror from different attester on someone else's DATA", async function () {
      // Alice creates DATA
      const dataUID = await createData(hash("alice's file"), 12n, alice);

      // Bob adds an IPFS mirror to Alice's DATA
      const mirrorUID = await createMirror(dataUID, ipfsTransportUID, "ipfs://QmBobMirror", bob);
      expect(mirrorUID).to.not.equal(ZERO_BYTES32);

      const mirrors = await fileView.getDataMirrorsAllAttesters(dataUID, 0, 10);
      expect(mirrors.length).to.equal(1);
      expect(mirrors[0].attester).to.equal(await bob.getAddress());
    });

    it("pagination: getDirectoryPageBySchemaAndAddressList via opaque cursor (ADR-0036)", async function () {
      const ownerAddr = await owner.getAddress();
      const folderUID = await createAnchor(rootUID, "paginate");

      // Five file slots (one per file) — production pattern under PIN cardinality 1.
      const slots: string[] = [];
      for (let i = 0; i < 5; i++) {
        const d = await createData(hash(`page-item-${i}`), BigInt(i + 1));
        const slot = await createAnchor(folderUID, `f${i}.bin`, dataSchemaUID);
        await pinTarget(d, slot);
        slots.push(slot);
      }

      // First page: maxItems=3 — slots come back in newest-first order.
      const page1 = await fileView.getDirectoryPageBySchemaAndAddressList(
        folderUID,
        dataSchemaUID,
        [ownerAddr],
        "0x",
        3,
      );
      expect(page1.items.length).to.equal(3);
      expect(page1.nextCursor).to.not.equal("0x");

      // Second page: resume with cursor
      const page2 = await fileView.getDirectoryPageBySchemaAndAddressList(
        folderUID,
        dataSchemaUID,
        [ownerAddr],
        page1.nextCursor,
        3,
      );
      expect(page2.items.length).to.equal(2);
      expect(page2.nextCursor).to.equal("0x");

      // All 5 unique slots across both pages.
      const allUIDs = [...page1.items.map((i: any) => i.uid), ...page2.items.map((i: any) => i.uid)];
      const uniqueUIDs = new Set(allUIDs);
      expect(uniqueUIDs.size).to.equal(5);
      for (const slot of slots) expect(uniqueUIDs.has(slot)).to.equal(true);
    });

    it("MAX_ANCHOR_DEPTH allows deep trees (256, ADR-0068)", async function () {
      // Value lock + positive regression: deep trees beyond the old 32-level cap now create.
      // The boundary-revert proof (build to cap+1) is the opt-in RUN_SLOW_TESTS test in
      // EFSTransports.test.ts — building 1025 anchors here would blow the mocha timeout.
      this.timeout(180000); // dozens of sequential attestations
      expect(await indexer.MAX_ANCHOR_DEPTH()).to.equal(256n);
      let parent = rootUID;
      for (let i = 0; i < 40; i++) {
        parent = await createAnchor(parent, `d${i}`);
      }
      expect(parent).to.not.equal(rootUID); // 40 deep — old cap of 32 would have reverted
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
      const photosUID = await createAnchor(rootUID, "photos", ZERO_BYTES32, alice);
      const vacationUID = await createAnchor(photosUID, "vacation", ZERO_BYTES32, alice);
      const favoritesUID = await createAnchor(photosUID, "favorites", ZERO_BYTES32, alice);

      // Label anchors
      const tagsUID = await createAnchor(rootUID, "tags");
      const nsfwUID = await createAnchor(tagsUID, "nsfw");

      // ── Alice uploads 3 photos to /photos/vacation/ ──
      // Each photo gets its own filename anchor (production pattern: PIN cardinality 1
      // per file slot, so multiple files require multiple slots).
      const photo1 = await uploadFile(
        "beach sunrise pixels",
        "image/jpeg",
        onchainTransportUID,
        "web3://0xBeach",
        vacationUID,
        alice,
        "beach.jpg",
      );
      const photo2 = await uploadFile(
        "mountain view pixels",
        "image/jpeg",
        ipfsTransportUID,
        "ipfs://QmMountain",
        vacationUID,
        alice,
        "mountain.jpg",
      );
      const photo3 = await uploadFile(
        "sunset over water",
        "image/png",
        arweaveTransportUID,
        "ar://SunsetHash",
        vacationUID,
        alice,
        "sunset.png",
      );

      // ── Verify /photos/vacation/ lists all 3 file slots for Alice ──
      let vacationItems = (
        await fileView.getDirectoryPageBySchemaAndAddressList(vacationUID, dataSchemaUID, [aliceAddr], "0x", 50)
      ).items;
      expect(vacationItems.length).to.equal(3);
      const initialNames = vacationItems.map((i: any) => i.name).sort();
      expect(initialNames).to.deep.equal(["beach.jpg", "mountain.jpg", "sunset.png"]);

      // ── Alice cross-references photo1 into /photos/favorites/ ──
      // Cross-reference = a separate filename slot under /favorites/ that PINs the
      // same DATA. Same DATA, two slots — content dedup at the DATA layer, distinct
      // slots at the placement layer.
      const favBeachSlot = await createAnchor(favoritesUID, "beach.jpg", dataSchemaUID, alice);
      await pinTarget(photo1.dataUID, favBeachSlot, alice);

      const favItems = (
        await fileView.getDirectoryPageBySchemaAndAddressList(favoritesUID, dataSchemaUID, [aliceAddr], "0x", 50)
      ).items;
      expect(favItems.length).to.equal(1);
      expect(favItems[0].name).to.equal("beach.jpg");
      expect(await edgeResolver.getActivePinTarget(favItems[0].uid, aliceAddr, dataSchemaUID)).to.equal(photo1.dataUID);

      // ── Bob adds an IPFS mirror to Alice's beach photo ──
      await createMirror(photo1.dataUID, ipfsTransportUID, "ipfs://QmBeachBackup", bob);
      const beachMirrors = await fileView.getDataMirrorsAllAttesters(photo1.dataUID, 0, 10);
      expect(beachMirrors.length).to.equal(2); // onchain + IPFS

      // ── Alice edits photo2 (new version) ──
      // PIN replacement at the same slot supersedes the prior DATA in O(1) — no
      // explicit revoke needed for the supersede semantic.
      const photo2v2Hash = hash("mountain view pixels ENHANCED");
      const photo2v2 = await createData(photo2v2Hash, 30n, alice);
      await createProperty(photo2v2, "contentType", "image/jpeg", alice);
      await createMirror(photo2v2, ipfsTransportUID, "ipfs://QmMountainV2", alice);
      await createProperty(photo2v2, "previousVersion", photo2.dataUID, alice);
      await pinTarget(photo2v2, photo2.fileSlotUID, alice); // supersedes photo2.dataUID at the slot

      // Still 3 file slots; the mountain slot now resolves to v2.
      vacationItems = (
        await fileView.getDirectoryPageBySchemaAndAddressList(vacationUID, dataSchemaUID, [aliceAddr], "0x", 50)
      ).items;
      expect(vacationItems.length).to.equal(3);
      expect(await edgeResolver.getActivePinTarget(photo2.fileSlotUID, aliceAddr, dataSchemaUID)).to.equal(photo2v2);

      // ── Bob marks photo3's DATA as NSFW (TAG, not PIN — labels are cardinality N) ──
      await tagTarget(photo3.dataUID, nsfwUID, bob);

      // ── Client-side NSFW filter: resolve each slot's active DATA, drop labelled ones ──
      const allVacation = (
        await fileView.getDirectoryPageBySchemaAndAddressList(vacationUID, dataSchemaUID, [aliceAddr], "0x", 50)
      ).items;
      const safeVacation = [];
      for (const item of allVacation) {
        const dataUID = await edgeResolver.getActivePinTarget(item.uid, aliceAddr, dataSchemaUID);
        const isNsfw = await edgeResolver.hasActiveEdge(dataUID, nsfwUID);
        if (!isNsfw) safeVacation.push(item);
      }
      expect(safeVacation.length).to.equal(2); // beach.jpg (photo1) and mountain.jpg (photo2v2)
      const safeNames = safeVacation.map((i: any) => i.name).sort();
      expect(safeNames).to.deep.equal(["beach.jpg", "mountain.jpg"]);

      // ── Tree visibility: alice visible up to root ──
      expect(await indexer.containsAttestations(vacationUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(photosUID, aliceAddr)).to.equal(true);
      expect(await indexer.containsAttestations(rootUID, aliceAddr)).to.equal(true);

      // Bob hasn't placed anything at these paths, so no containsAttestations
      // (Bob's NSFW TAG is at /tags/nsfw, not /photos/vacation/)
      expect(await indexer.containsAttestations(vacationUID, bobAddr)).to.equal(false);

      // AGENT-NOTE: dropped the dedup re-upload sub-assertion — DATA is empty (ADR-0049), so
      // `getCanonicalData` is a deprecated no-op (always bytes32(0)). Content dedup is now
      // best-effort client-side via the property index + REDIRECT (ADR-0050); future work.
      expect(await fileView.getCanonicalData(photo1.contentHash)).to.equal(ZERO_BYTES32);
    });
  });
});
