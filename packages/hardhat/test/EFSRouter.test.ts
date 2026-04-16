import { expect } from "chai";
import { ethers } from "hardhat";
import { setCode } from "@nomicfoundation/hardhat-network-helpers";
import { Signer, ZeroAddress, ZeroHash } from "ethers";

const ZERO_BYTES32 = ZeroHash;
const NO_EXPIRATION = 0n;

describe("EFSRouter Web3 Capabilities", function () {
  let indexer: any;
  let tagResolver: any;
  let mirrorResolver: any;
  let eas: any;
  let registry: any;
  let router: any;
  let owner: Signer;
  let _user1: Signer;
  let _user2: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let tagSchemaUID: string;
  let mirrorSchemaUID: string;
  let blobSchemaUID: string;

  let rootUID: string;
  let ideasUID: string;
  let ownerAddr: string;
  let onchainTransportUID: string;
  let ipfsTransportUID: string;
  let arweaveTransportUID: string;
  let httpsTransportUID: string;
  let magnetTransportUID: string;

  const enc = new ethers.AbiCoder();

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
    [owner, _user1, _user2] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();

    // Deploy EAS infrastructure
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    // Nonce prediction (same as EFSTransports.test.ts)
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

    // Deploy Router (4 args: indexer, eas, tagResolver, dataSchemaUID)
    const RouterFactory = await ethers.getContractFactory("EFSRouter");
    router = await RouterFactory.deploy(
      await indexer.getAddress(),
      await eas.getAddress(),
      await tagResolver.getAddress(),
      dataSchemaUID,
    );
    await router.waitForDeployment();

    // Create root anchor
    rootUID = getUID(
      await (
        await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: enc.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
            value: 0n,
          },
        })
      ).wait(),
    );

    // Create /ideas/ folder
    ideasUID = getUID(
      await (
        await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID,
            data: enc.encode(["string", "bytes32"], ["ideas", ZERO_BYTES32]),
            value: 0n,
          },
        })
      ).wait(),
    );

    // Create /transports/ tree
    const transportsUID = getUID(
      await (
        await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: rootUID,
            data: enc.encode(["string", "bytes32"], ["transports", ZERO_BYTES32]),
            value: 0n,
          },
        })
      ).wait(),
    );

    const createTransport = async (name: string) =>
      getUID(
        await (
          await eas.attest({
            schema: anchorSchemaUID,
            data: {
              recipient: ZeroAddress,
              expirationTime: NO_EXPIRATION,
              revocable: false,
              refUID: transportsUID,
              data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
              value: 0n,
            },
          })
        ).wait(),
      );

    onchainTransportUID = await createTransport("onchain");
    ipfsTransportUID = await createTransport("ipfs");
    arweaveTransportUID = await createTransport("arweave");
    httpsTransportUID = await createTransport("https");
    magnetTransportUID = await createTransport("magnet");

    // Wire /transports/ ancestry into MirrorResolver
    await mirrorResolver.setTransportsAnchor(transportsUID);
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async function createFileAnchor(parentUID: string, name: string): Promise<string> {
    return getUID(
      await (
        await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: enc.encode(["string", "bytes32"], [name, dataSchemaUID]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  async function createFolder(parentUID: string, name: string): Promise<string> {
    return getUID(
      await (
        await eas.attest({
          schema: anchorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: parentUID,
            data: enc.encode(["string", "bytes32"], [name, ZERO_BYTES32]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  async function createData(content: string, signer: Signer = owner): Promise<string> {
    const contentHash = ethers.keccak256(Buffer.from(content));
    const size = BigInt(Buffer.from(content).length);
    return getUID(
      await (
        await eas.connect(signer).attest({
          schema: dataSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: false,
            refUID: ZERO_BYTES32,
            data: enc.encode(["bytes32", "uint64"], [contentHash, size]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  async function addProperty(dataUID: string, key: string, value: string, signer: Signer = owner): Promise<string> {
    return getUID(
      await (
        await eas.connect(signer).attest({
          schema: propertySchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: dataUID,
            data: enc.encode(["string", "string"], [key, value]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  async function addMirror(
    dataUID: string,
    transportUID: string,
    uri: string,
    signer: Signer = owner,
  ): Promise<string> {
    return getUID(
      await (
        await eas.connect(signer).attest({
          schema: mirrorSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: dataUID,
            data: enc.encode(["bytes32", "string"], [transportUID, uri]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  async function tagAtPath(
    dataUID: string,
    anchorUID: string,
    applies: boolean,
    signer: Signer = owner,
  ): Promise<string> {
    return getUID(
      await (
        await eas.connect(signer).attest({
          schema: tagSchemaUID,
          data: {
            recipient: ZeroAddress,
            expirationTime: NO_EXPIRATION,
            revocable: true,
            refUID: dataUID,
            data: enc.encode(["bytes32", "bool"], [anchorUID, applies]),
            value: 0n,
          },
        })
      ).wait(),
    );
  }

  /** Full upload: DATA + PROPERTY(contentType) + MIRROR + TAG placement */
  async function uploadOnchain(
    content: string,
    contentType: string,
    targetAddress: string,
    anchorUID: string,
    signer: Signer = owner,
  ): Promise<string> {
    // Deploy SSTORE2 bytecode at target address
    const sstore2Bytecode = "0x00" + Buffer.from(content, "utf8").toString("hex");
    await setCode(targetAddress, sstore2Bytecode);

    const dataUID = await createData(content, signer);
    await addProperty(dataUID, "contentType", contentType, signer);
    await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`, signer);
    await tagAtPath(dataUID, anchorUID, true, signer);
    return dataUID;
  }

  /** Builds params array with owner's address as editions (required for TAG-based lookup) */
  function ownerParams(...extra: { key: string; value: string }[]): { key: string; value: string }[] {
    return [{ key: "editions", value: ownerAddr }, ...extra];
  }

  // ─── Tests ────────────────────────────────────────────────────────────────

  describe("EIP-6944: resolveMode()", function () {
    it('Should return bytes32("5219") for resolveMode', async function () {
      const mode = await router.resolveMode();
      expect(mode).to.equal(ethers.encodeBytes32String("5219"));
    });
  });

  describe("On-chain file serving", function () {
    it("Should return 200, Content-Type, and ACTUAL file bytes for valid on-chain file", async function () {
      const fileContent = "Hello Decentralized World!";
      const targetAddress = "0x1234567890123456789012345678901234567890";
      const fileAnchorUID = await createFileAnchor(ideasUID, "test.md");

      await uploadOnchain(fileContent, "text/markdown", targetAddress, fileAnchorUID);

      const [statusCode, body, headers] = await router.request(["ideas", "test.md"], ownerParams());
      expect(statusCode).to.equal(200);

      const decodedBody = Buffer.from(ethers.getBytes(body)).toString("utf8");
      expect(decodedBody).to.equal(fileContent);

      const ctHeader = headers.find((h: any) => h.key === "Content-Type");
      expect(ctHeader?.value).to.equal("text/markdown");
    });

    it("Should strip the SSTORE2 0x00 prefix byte and return exact source bytes", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000010";
      const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      await setCode(targetAddress, "0x00" + originalBytes.toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "bin_test.png");
      const dataUID = await createData("binary-png-content");
      await addProperty(dataUID, "contentType", "image/png");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body] = await router.request(["ideas", "bin_test.png"], ownerParams());
      expect(statusCode).to.equal(200);

      const returnedBytes = Buffer.from(ethers.getBytes(body));
      expect(returnedBytes.length).to.equal(originalBytes.length);
      expect(returnedBytes[0]).to.equal(0x89, "First byte should be 0x89, not 0x00 (SSTORE2 prefix).");
      expect(returnedBytes.toString("hex")).to.equal(originalBytes.toString("hex"));
    });

    it("Should return raw bytes without UTF-8 corruption for high-byte payloads", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000011";
      const highBytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x80, 0xc0]);
      await setCode(targetAddress, "0x00" + highBytes.toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "raw_binary.bin");
      const dataUID = await createData("raw-binary-content");
      await addProperty(dataUID, "contentType", "application/octet-stream");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body] = await router.request(["ideas", "raw_binary.bin"], ownerParams());
      expect(statusCode).to.equal(200);

      const returnedBytes = Buffer.from(ethers.getBytes(body));
      expect(returnedBytes.toString("hex")).to.equal(highBytes.toString("hex"));
      expect(returnedBytes[0]).to.equal(0xff, "0xFF must not become 0xEF (UTF-8 replacement).");
    });
  });

  describe("External URI delegation", function () {
    it("Should return message/external-body for IPFS URIs", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "ipfs.png");
      const dataUID = await createData("ipfs-content");
      await addProperty(dataUID, "contentType", "image/png");
      await addMirror(dataUID, ipfsTransportUID, "ipfs://QmXxxx");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "ipfs.png"], ownerParams());
      expect(statusCode).to.equal(200);

      const ctHeader = headers.find((h: any) => h.key === "Content-Type");
      expect(ctHeader?.value).to.include("message/external-body");
      expect(ctHeader?.value).to.include('URL="ipfs://QmXxxx"');
    });

    it("Should return message/external-body for ar:// URIs", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "arweave.md");
      const dataUID = await createData("arweave-content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, arweaveTransportUID, "ar://abc123XYZ");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "arweave.md"], ownerParams());
      expect(statusCode).to.equal(200);
      const ctHeader = headers.find((h: any) => h.key === "Content-Type");
      expect(ctHeader?.value).to.include('URL="ar://abc123XYZ"');
    });

    it("Should return message/external-body for https:// URIs", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "https_file.md");
      const dataUID = await createData("https-content");
      await addProperty(dataUID, "contentType", "text/html");
      await addMirror(dataUID, httpsTransportUID, "https://example.com/file.txt");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "https_file.md"], ownerParams());
      expect(statusCode).to.equal(200);
      const ctHeader = headers.find((h: any) => h.key === "Content-Type");
      expect(ctHeader?.value).to.include('URL="https://example.com/file.txt"');
    });

    it("Should return message/external-body for magnet: URIs", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "torrent.iso");
      const dataUID = await createData("magnet-content");
      await addProperty(dataUID, "contentType", "application/x-iso9660-image");
      await addMirror(dataUID, magnetTransportUID, "magnet:?xt=urn:btih:ABCDEF123456");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "torrent.iso"], ownerParams());
      expect(statusCode).to.equal(200);
      const ctHeader = headers.find((h: any) => h.key === "Content-Type");
      expect(ctHeader?.value).to.include('URL="magnet:?xt=urn:btih:ABCDEF123456"');
    });
  });

  describe("EIP-7617: Chunking", function () {
    it("Should paginate through all chunks via web3-next-chunk headers (3-chunk file)", async function () {
      const c0 = "0x0000000000000000000000000000000000000030";
      const c1 = "0x0000000000000000000000000000000000000031";
      const c2 = "0x0000000000000000000000000000000000000032";

      const d0 = Buffer.from("CHUNK_ZERO_DATA");
      const d1 = Buffer.from("CHUNK_ONE_DATA!");
      const d2 = Buffer.from("CHUNK_TWO_FINAL");

      await setCode(c0, "0x00" + d0.toString("hex"));
      await setCode(c1, "0x00" + d1.toString("hex"));
      await setCode(c2, "0x00" + d2.toString("hex"));

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy([c0, c1, c2]);
      await chunkedFile.waitForDeployment();
      const mgr = await chunkedFile.getAddress();

      const fileAnchorUID = await createFileAnchor(ideasUID, "chunked.bin");
      const dataUID = await createData("chunked-file-content");
      await addProperty(dataUID, "contentType", "application/octet-stream");
      await addMirror(dataUID, onchainTransportUID, `web3://${mgr}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      // Chunk 0: should have web3-next-chunk=?chunk=1
      const [s0, b0, h0] = await router.request(["ideas", "chunked.bin"], ownerParams({ key: "chunk", value: "0" }));
      expect(s0).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b0)).toString()).to.equal(d0.toString());
      const next0 = h0.find((h: any) => h.key === "web3-next-chunk");
      expect(next0, "Chunk 0 must have web3-next-chunk header").to.not.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
      expect(next0.value).to.equal("?chunk=1");

      // Chunk 1: should have web3-next-chunk=?chunk=2
      const [s1, b1, h1] = await router.request(["ideas", "chunked.bin"], ownerParams({ key: "chunk", value: "1" }));
      expect(s1).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b1)).toString()).to.equal(d1.toString());
      const next1 = h1.find((h: any) => h.key === "web3-next-chunk");
      expect(next1, "Chunk 1 must have web3-next-chunk header").to.not.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
      expect(next1.value).to.equal("?chunk=2");

      // Chunk 2 (last): must NOT have web3-next-chunk
      const [s2, b2, h2] = await router.request(["ideas", "chunked.bin"], ownerParams({ key: "chunk", value: "2" }));
      expect(s2).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b2)).toString()).to.equal(d2.toString());
      const next2 = h2.find((h: any) => h.key === "web3-next-chunk");
      expect(next2, "Last chunk must NOT have web3-next-chunk header").to.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should return 404 for out-of-bounds chunk index", async function () {
      const c0 = "0x0000000000000000000000000000000000000040";
      await setCode(c0, "0x00" + Buffer.from("data").toString("hex"));

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy([c0]);
      await chunkedFile.waitForDeployment();
      const mgr = await chunkedFile.getAddress();

      const fileAnchorUID = await createFileAnchor(ideasUID, "oob.bin");
      const dataUID = await createData("oob-content");
      await addProperty(dataUID, "contentType", "application/octet-stream");
      await addMirror(dataUID, onchainTransportUID, `web3://${mgr}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode] = await router.request(["ideas", "oob.bin"], ownerParams({ key: "chunk", value: "99" }));
      expect(statusCode).to.equal(404);
    });

    it("Should reassemble all chunks byte-for-byte matching the original binary source", async function () {
      const chunks = [
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
      ];
      const originalFull = Buffer.concat(chunks);

      const addrs = [
        "0x0000000000000000000000000000000000000050",
        "0x0000000000000000000000000000000000000051",
        "0x0000000000000000000000000000000000000052",
      ];
      for (let i = 0; i < chunks.length; i++) {
        await setCode(addrs[i], "0x00" + chunks[i].toString("hex"));
      }

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy(addrs);
      await chunkedFile.waitForDeployment();
      const mgr = await chunkedFile.getAddress();

      const fileAnchorUID = await createFileAnchor(ideasUID, "full_concat.png");
      const dataUID = await createData("full-concat-content");
      await addProperty(dataUID, "contentType", "image/png");
      await addMirror(dataUID, onchainTransportUID, `web3://${mgr}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const result: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const [statusCode, body] = await router.request(
          ["ideas", "full_concat.png"],
          ownerParams({ key: "chunk", value: String(i) }),
        );
        expect(statusCode).to.equal(200);
        for (const b of ethers.getBytes(body)) result.push(b);
      }

      const reassembled = Buffer.from(result);
      expect(reassembled.length).to.equal(originalFull.length);
      expect(reassembled.toString("hex")).to.equal(originalFull.toString("hex"));
    });

    it("Should detect MockChunkedFile via staticcall to chunkCount() with correct selector", async function () {
      const chunk0 = "0x0000000000000000000000000000000000000020";
      await setCode(chunk0, "0x00" + Buffer.from("hello").toString("hex"));

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy([chunk0]);
      await chunkedFile.waitForDeployment();

      expect(await chunkedFile.chunkCount()).to.equal(1n);
      const iface = MockChunkedFile.interface;
      const selector = iface.getFunction("chunkCount")!.selector;
      expect(selector).to.equal("0xf91f0937");
    });
  });

  describe("Deep path resolution", function () {
    it("Should resolve deeply nested files across multiple folders", async function () {
      const deepUID = await createFolder(ideasUID, "deep");
      const nestedUID = await createFolder(deepUID, "nested");

      const targetAddress = "0x1234567890123456789012345678901234567891";
      const fileContent = "Deep Space Nine";
      await setCode(targetAddress, "0x00" + Buffer.from(fileContent).toString("hex"));

      const fileAnchorUID = await createFileAnchor(nestedUID, "deep_test.md");
      const dataUID = await createData(fileContent);
      await addProperty(dataUID, "contentType", "text/markdown");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body, headers] = await router.request(
        ["ideas", "deep", "nested", "deep_test.md"],
        ownerParams(),
      );
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString("utf8")).to.equal(fileContent);
      expect(headers.find((h: any) => h.key === "Content-Type")?.value).to.equal("text/markdown");
    });
  });

  describe("Editions (multi-attester)", function () {
    it("Should parse comma-separated editions list and filter file visibility", async function () {
      const u1 = "0x1111111111111111111111111111111111111111";
      const u2 = "0x2222222222222222222222222222222222222222";

      const targetAddress1 = "0x0000000000000000000000000000000000000071";
      const targetAddress2 = "0x0000000000000000000000000000000000000072";
      await setCode(targetAddress1, "0x00" + Buffer.from("User 1 Data").toString("hex"));
      await setCode(targetAddress2, "0x00" + Buffer.from("User 2 Data").toString("hex"));

      // Create file anchor
      const fileAnchorUID = await createFileAnchor(ideasUID, "shared.txt");

      // User 1 uploads
      await ethers.provider.send("hardhat_impersonateAccount", [u1]);
      const signer1 = await ethers.getSigner(u1);
      await owner.sendTransaction({ to: u1, value: ethers.parseEther("1.0") });

      const data1UID = await createData("User 1 Data", signer1);
      await addProperty(data1UID, "contentType", "text/plain", signer1);
      await addMirror(data1UID, onchainTransportUID, `web3://${targetAddress1}`, signer1);
      await tagAtPath(data1UID, fileAnchorUID, true, signer1);

      // User 2 uploads
      await ethers.provider.send("hardhat_impersonateAccount", [u2]);
      const signer2 = await ethers.getSigner(u2);
      await owner.sendTransaction({ to: u2, value: ethers.parseEther("1.0") });

      const data2UID = await createData("User 2 Data", signer2);
      await addProperty(data2UID, "contentType", "text/plain", signer2);
      await addMirror(data2UID, onchainTransportUID, `web3://${targetAddress2}`, signer2);
      await tagAtPath(data2UID, fileAnchorUID, true, signer2);

      // Request with ONLY User 2
      const [statusCode2, body2] = await router.request(["ideas", "shared.txt"], [{ key: "editions", value: u2 }]);
      expect(statusCode2).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body2)).toString()).to.equal("User 2 Data");

      // Request with [u1, u2] -> should resolve u1 (first match)
      const [statusCodeRev, bodyRev] = await router.request(
        ["ideas", "shared.txt"],
        [{ key: "editions", value: `${u1},${u2}` }],
      );
      expect(statusCodeRev).to.equal(200);
      expect(Buffer.from(ethers.getBytes(bodyRev)).toString()).to.equal("User 1 Data");
    });
  });

  describe("Edge Cases", function () {
    it("Should return 404 for empty resource path", async function () {
      const [statusCode, body] = await router.request([], []);
      expect(statusCode).to.equal(404);
      expect(Buffer.from(ethers.getBytes(body)).toString("utf8")).to.include("Empty path");
    });

    it("Should return 404 for nonexistent path", async function () {
      const [statusCode] = await router.request(["nonexistent", "file.txt"], []);
      expect(statusCode).to.equal(404);
    });

    it("Should return 404 when no mirror available", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "no_mirror.txt");
      const dataUID = await createData("no-mirror-content");
      await addProperty(dataUID, "contentType", "text/plain");
      // No mirror created
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body] = await router.request(["ideas", "no_mirror.txt"], ownerParams());
      expect(statusCode).to.equal(404);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.include("No mirror");
    });

    it("Should treat malformed chunk param as chunk 0", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000060";
      await setCode(targetAddress, "0x00" + Buffer.from("chunk zero data").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "malformed.bin");
      const dataUID = await createData("malformed-chunk-content");
      await addProperty(dataUID, "contentType", "application/octet-stream");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      // "abc" is not numeric, _parseUint returns 0
      const [statusCode, body] = await router.request(
        ["ideas", "malformed.bin"],
        ownerParams({ key: "chunk", value: "abc" }),
      );
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("chunk zero data");
    });

    it("Should return 500 when only mirror has a malformed web3:// URI (no valid address)", async function () {
      // A malformed web3:// URI is filtered out in _getBestMirrorURI before committing.
      // hadMirrors=true (the mirror existed) but best="" → router returns 500, not 404.
      const fileAnchorUID = await createFileAnchor(ideasUID, "bad_uri.bin");
      const dataUID = await createData("bad-uri-content");
      await addProperty(dataUID, "contentType", "application/octet-stream");
      await addMirror(dataUID, onchainTransportUID, "web3://short"); // too short to parse an address
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode] = await router.request(["ideas", "bad_uri.bin"], ownerParams());
      expect(statusCode).to.equal(500);
    });

    it("Should ignore mirrors attached by third parties not in editions", async function () {
      // owner places the file and attaches a valid onchain mirror
      // user1 (not in editions) attaches an https mirror to the same DATA
      // Router should only consider owner's mirror
      const u1 = "0x1111111111111111111111111111111111111113";
      await ethers.provider.send("hardhat_impersonateAccount", [u1]);
      const signer1 = await ethers.getSigner(u1);
      await owner.sendTransaction({ to: u1, value: ethers.parseEther("1.0") });

      const targetAddress = "0x0000000000000000000000000000000000000090";
      await setCode(targetAddress, "0x00" + Buffer.from("owner content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "spam_test.txt");
      const dataUID = await createData("spam-content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await addMirror(dataUID, httpsTransportUID, "https://evil.example/hijack", signer1); // third-party mirror
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body, headers] = await router.request(["ideas", "spam_test.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      // Must serve owner's onchain mirror, not the third-party https mirror
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("owner content");
      // Content-Type should not be message/external-body (which https would produce)
      const ct = headers.find((h: any) => h.key === "Content-Type")?.value ?? "";
      expect(ct).to.not.include("evil.example");
    });

    it("Should fall back to ipfs:// when web3:// mirror has a malformed address", async function () {
      // Router skips the invalid web3:// and uses the next-best valid mirror.
      const fileAnchorUID = await createFileAnchor(ideasUID, "fallback.txt");
      const dataUID = await createData("fallback-content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, onchainTransportUID, "web3://short"); // invalid
      await addMirror(dataUID, ipfsTransportUID, "ipfs://QmFallback");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "fallback.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      const ct = headers.find((h: any) => h.key === "Content-Type")?.value ?? "";
      expect(ct).to.include("ipfs://QmFallback");
    });

    it("Should default to application/octet-stream when no contentType PROPERTY", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000080";
      await setCode(targetAddress, "0x00" + Buffer.from("no-ct").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "no_ct.bin");
      const dataUID = await createData("no-ct-content");
      // No contentType PROPERTY
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "no_ct.bin"], ownerParams());
      expect(statusCode).to.equal(200);
      expect(headers.find((h: any) => h.key === "Content-Type")?.value).to.equal("application/octet-stream");
    });

    it("Should serve content with no ?editions= param (falls back to anchor attester)", async function () {
      // When no editions param is supplied, _findDataAtPath falls back to
      // eas.getAttestation(targetAnchor).attester. The anchor was created by owner,
      // so owner's DATA (placed via TAG) should be found.
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000A0");
      await setCode(targetAddress, "0x00" + Buffer.from("bare web3 content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "bare_web3.txt");
      const dataUID = await createData("bare web3 content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      // Request with NO editions param — empty array
      const [statusCode, body] = await router.request(["ideas", "bare_web3.txt"], []);
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("bare web3 content");
    });

    it("Should prefer ar:// over ipfs:// when both mirrors exist", async function () {
      // ar:// priority = 1, ipfs:// priority = 2 — arweave should win
      const fileAnchorUID = await createFileAnchor(ideasUID, "priority_test.txt");
      const dataUID = await createData("priority-content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, ipfsTransportUID, "ipfs://QmPriorityTest");
      await addMirror(dataUID, arweaveTransportUID, "ar://ArweavePriorityTest");
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, , headers] = await router.request(["ideas", "priority_test.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      const ct = headers.find((h: any) => h.key === "Content-Type")?.value ?? "";
      // ar:// mirror wins — Content-Type contains the arweave gateway URI
      expect(ct).to.include("ArweavePriorityTest");
      expect(ct).to.not.include("QmPriorityTest");
    });

    it("Should skip a revoked mirror and return 404 when it was the only mirror", async function () {
      const fileAnchorUID = await createFileAnchor(ideasUID, "revoked_mirror.txt");
      const dataUID = await createData("revoked-mirror-content");
      await addProperty(dataUID, "contentType", "text/plain");
      const mirrorUID = await addMirror(dataUID, ipfsTransportUID, "ipfs://QmRevoked");
      await tagAtPath(dataUID, fileAnchorUID, true);

      // Verify it serves before revocation
      const [statusBefore] = await router.request(["ideas", "revoked_mirror.txt"], ownerParams());
      expect(statusBefore).to.equal(200);

      // Revoke the mirror
      await eas.revoke({ schema: mirrorSchemaUID, data: { uid: mirrorUID, value: 0n } });

      // After revocation, the mirror is skipped — no valid mirrors remain → 404
      const [statusAfter, bodyAfter] = await router.request(["ideas", "revoked_mirror.txt"], ownerParams());
      expect(statusAfter).to.equal(404);
      expect(Buffer.from(ethers.getBytes(bodyAfter)).toString()).to.include("No mirror");
    });

    it("Should prefer web3:// over ar:// (highest-priority pair)", async function () {
      // web3:// priority = 0, ar:// priority = 1 — on-chain mirror must win
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000D0");
      await setCode(targetAddress, "0x00" + Buffer.from("onchain beats arweave").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "web3_vs_ar.txt");
      const dataUID = await createData("onchain beats arweave");
      await addProperty(dataUID, "contentType", "text/plain");
      // Add ar:// first so it appears earlier in the attestation array
      await addMirror(dataUID, arweaveTransportUID, "ar://ShouldNotWin");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body] = await router.request(["ideas", "web3_vs_ar.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      // web3:// mirror is served inline — body contains the actual content
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("onchain beats arweave");
    });

    it("Should fall back to next-best mirror when highest-priority mirror is revoked", async function () {
      // web3:// mirror gets revoked → should fall back to ipfs:// (not 404)
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000D1");
      await setCode(targetAddress, "0x00" + Buffer.from("fallback content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "fallback_mirror.txt");
      const dataUID = await createData("fallback content");
      await addProperty(dataUID, "contentType", "text/plain");
      const web3MirrorUID = await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await addMirror(dataUID, ipfsTransportUID, "ipfs://QmFallbackHash");
      await tagAtPath(dataUID, fileAnchorUID, true);

      // Before revocation: web3:// serves content directly
      const [statusBefore, bodyBefore] = await router.request(["ideas", "fallback_mirror.txt"], ownerParams());
      expect(statusBefore).to.equal(200);
      expect(Buffer.from(ethers.getBytes(bodyBefore)).toString()).to.equal("fallback content");

      // Revoke the web3:// mirror
      await eas.revoke({ schema: mirrorSchemaUID, data: { uid: web3MirrorUID, value: 0n } });

      // After revocation: falls back to ipfs:// (message/external-body, not 404)
      const [statusAfter, , headersAfter] = await router.request(["ideas", "fallback_mirror.txt"], ownerParams());
      expect(statusAfter).to.equal(200);
      const ct = headersAfter.find((h: any) => h.key === "Content-Type")?.value ?? "";
      expect(ct).to.include("message/external-body");
      expect(ct).to.include("QmFallbackHash");
    });

    it("Should continue past editions with no DATA and serve from a later edition", async function () {
      // First edition has no DATA at this anchor; second edition has a file.
      // Router should skip the first and serve from the second.
      const [, , user2] = await ethers.getSigners();
      const u2Addr = await user2.getAddress();

      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000B0");
      await setCode(targetAddress, "0x00" + Buffer.from("user2 file content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "fallthrough.txt");
      // Only user2 places a file here; owner does not
      const dataUID = await createData("user2 file content", user2);
      await addProperty(dataUID, "contentType", "text/plain", user2);
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`, user2);
      await tagAtPath(dataUID, fileAnchorUID, true, user2);

      // Pass owner first (has no DATA here), then user2 (has DATA) — should fall through to user2
      const noDataAddr = ownerAddr;
      const [statusCode, body] = await router.request(
        ["ideas", "fallthrough.txt"],
        [{ key: "editions", value: `${noDataAddr},${u2Addr}` }],
      );
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("user2 file content");
    });

    it("Should return application/octet-stream when the contentType PROPERTY is revoked", async function () {
      // _getContentType skips revoked PROPERTY attestations (isRevoked check).
      // When the only contentType prop is revoked, the default MIME type must be returned.
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000E0");
      await setCode(targetAddress, "0x00" + Buffer.from("no content type").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "revoked_ct.txt");
      const dataUID = await createData("no content type");
      const propUID = await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      // Sanity: text/plain before revocation
      const [statusBefore, , headersBefore] = await router.request(["ideas", "revoked_ct.txt"], ownerParams());
      expect(statusBefore).to.equal(200);
      expect(headersBefore.find((h: any) => h.key === "Content-Type")?.value).to.equal("text/plain");

      // Revoke the PROPERTY
      await eas.revoke({ schema: propertySchemaUID, data: { uid: propUID, value: 0n } });

      // After revocation: falls back to application/octet-stream
      const [statusAfter, , headersAfter] = await router.request(["ideas", "revoked_ct.txt"], ownerParams());
      expect(statusAfter).to.equal(200);
      expect(headersAfter.find((h: any) => h.key === "Content-Type")?.value).to.equal("application/octet-stream");
    });

    it("Should return 404 when the placement TAG is revoked", async function () {
      // Revoking a TAG(applies=true) removes the DATA from _activeByAAS.
      // The router can no longer find a DATA at the anchor → 404.
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000E1");
      await setCode(targetAddress, "0x00" + Buffer.from("tag revoked content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "tag_revoked.txt");
      const dataUID = await createData("tag revoked content");
      await addProperty(dataUID, "contentType", "text/plain");
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}`);
      const tagUID = await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusBefore] = await router.request(["ideas", "tag_revoked.txt"], ownerParams());
      expect(statusBefore).to.equal(200);

      // Revoke the TAG — removes DATA from the active compact index in TagResolver
      await eas.revoke({ schema: tagSchemaUID, data: { uid: tagUID, value: 0n } });

      const [statusAfter] = await router.request(["ideas", "tag_revoked.txt"], ownerParams());
      expect(statusAfter).to.equal(404);
    });

    it("Should parse web3:// URI with :chainId suffix (suffix ignored, address extracted)", async function () {
      // _parseContractFromWeb3URI reads exactly 40 hex chars after '0x' and stops.
      // A :chainId suffix does not interfere with address parsing.
      const targetAddress = ethers.getAddress("0x00000000000000000000000000000000000000E2");
      await setCode(targetAddress, "0x00" + Buffer.from("chainid suffix content").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "chainid_suffix.txt");
      const dataUID = await createData("chainid suffix content");
      await addProperty(dataUID, "contentType", "text/plain");
      // URI with :1 chain ID suffix appended
      await addMirror(dataUID, onchainTransportUID, `web3://${targetAddress}:1`);
      await tagAtPath(dataUID, fileAnchorUID, true);

      const [statusCode, body] = await router.request(["ideas", "chainid_suffix.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("chainid suffix content");
    });

    it("Should pick the DATA with the highest attestation timestamp when multiple are active", async function () {
      // Two DATAs placed at the same anchor by the same attester — newest timestamp wins.
      const addr1 = ethers.getAddress("0x00000000000000000000000000000000000000C0");
      const addr2 = ethers.getAddress("0x00000000000000000000000000000000000000C1");
      await setCode(addr1, "0x00" + Buffer.from("version 1").toString("hex"));
      await setCode(addr2, "0x00" + Buffer.from("version 2").toString("hex"));

      const fileAnchorUID = await createFileAnchor(ideasUID, "versioned.txt");

      // Create two DATAs and place both at the same anchor (unusual but valid)
      const dataUID1 = await createData("version 1");
      await addProperty(dataUID1, "contentType", "text/plain");
      await addMirror(dataUID1, onchainTransportUID, `web3://${addr1}`);
      await tagAtPath(dataUID1, fileAnchorUID, true);

      const dataUID2 = await createData("version 2");
      await addProperty(dataUID2, "contentType", "text/plain");
      await addMirror(dataUID2, onchainTransportUID, `web3://${addr2}`);
      await tagAtPath(dataUID2, fileAnchorUID, true);

      // dataUID2 was attested after dataUID1 → higher timestamp → should be served
      const [statusCode, body] = await router.request(["ideas", "versioned.txt"], ownerParams());
      expect(statusCode).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body)).toString()).to.equal("version 2");
    });
  });
});
