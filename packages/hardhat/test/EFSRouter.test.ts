import { expect } from "chai";
import { ethers } from "hardhat";
import { setCode } from "@nomicfoundation/hardhat-network-helpers";
import { Signer, ZeroAddress } from "ethers";
// We use `any` for contract instances to simplify testing without requiring full Typechain generation in this context.

const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSRouter Web3 Capabilities", function () {
  let router: any; // EFSRouter
  let indexer: any; // EFSIndexer
  let eas: any; // EAS
  let registry: any; // SchemaRegistry
  let owner: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let ideasUID: string;

  before(async function () {
    [owner] = await ethers.getSigners();
  });

  beforeEach(async function () {
    // 1. Deploy SchemaRegistry and EAS
    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    const expectedIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 2 });

    // Register Schemas
    const tx1 = await registry.register("string name, bytes32 schemaUID", expectedIndexerAddr, true);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1];

    const tx2 = await registry.register("string uri, string contentType, string fileMode", expectedIndexerAddr, true);
    const rc2 = await tx2.wait();
    dataSchemaUID = rc2!.logs[0].topics[1];

    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      anchorSchemaUID, // propertySchemaUID (placeholder)
      dataSchemaUID,
      anchorSchemaUID, // blobSchemaUID (placeholder)
    );
    await indexer.waitForDeployment();

    expect(await indexer.getAddress()).to.equal(expectedIndexerAddr);

    const RouterFactory = await ethers.getContractFactory("EFSRouter");
    router = await RouterFactory.deploy(await indexer.getAddress(), await eas.getAddress(), dataSchemaUID);
    await router.waitForDeployment();

    // --- Create mock test data so it's available for all it blocks ---
    const schemaEncoder = new ethers.AbiCoder();
    // 1. Root
    const txRoot = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]),
        value: 0n,
      },
    });
    const rcRoot = await txRoot.wait();
    const rootUID = getUIDFromReceipt(rcRoot);

    // 2. Folder "ideas"
    const txIdeas = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: rootUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["ideas", ZERO_BYTES32]),
        value: 0n,
      },
    });
    const rcIdeas = await txIdeas.wait();
    ideasUID = getUIDFromReceipt(rcIdeas);

    // 3. File Anchor "test.md"
    const txFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["test.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcFile = await txFile.wait();
    const fileUID = getUIDFromReceipt(rcFile);

    // 4. Data Attestation (Quad-Schema) - Default File
    const txData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: fileUID,
        data: schemaEncoder.encode(
          ["string", "string", "string"],
          ["web3://0x1234567890123456789012345678901234567890", "text/markdown", "file"],
        ),
        value: 0n,
      },
    });
    await txData.wait();

    // 5. Tombstone Mock File "deleted.md"
    const txTombFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["deleted.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcTombFile = await txTombFile.wait();
    const tombFileUID = getUIDFromReceipt(rcTombFile);

    const txTombData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: tombFileUID,
        data: schemaEncoder.encode(["string", "string", "string"], ["", "", "tombstone"]),
        value: 0n,
      },
    });
    await txTombData.wait();

    // 6. Symlink Mock File "link.md"
    const txSymFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["link.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcSymFile = await txSymFile.wait();
    const symFileUID = getUIDFromReceipt(rcSymFile);

    const txSymData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: symFileUID,
        data: schemaEncoder.encode(["string", "string", "string"], ["/ideas/test.md", "", "symlink"]),
        value: 0n,
      },
    });
    await txSymData.wait();

    // 7. IPFS Mock File "ipfs.md"
    const txIpfsFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["ipfs.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcIpfsFile = await txIpfsFile.wait();
    const ipfsFileUID = getUIDFromReceipt(rcIpfsFile);

    const txIpfsData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ipfsFileUID,
        data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://QmXxxx", "image/png", "file"]),
        value: 0n,
      },
    });
    await txIpfsData.wait();

    // 7b. Arweave Mock File "arweave.md"
    const txArFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["arweave.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const txArData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: getUIDFromReceipt(await txArFile.wait()),
        data: schemaEncoder.encode(["string", "string", "string"], ["ar://abc123XYZ", "text/plain", "file"]),
        value: 0n,
      },
    });
    await txArData.wait();

    // 7c. HTTPS Mock File "https_file.md"
    const txHttpsFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["https_file.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const txHttpsData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: getUIDFromReceipt(await txHttpsFile.wait()),
        data: schemaEncoder.encode(
          ["string", "string", "string"],
          ["https://example.com/file.txt", "text/html", "file"],
        ),
        value: 0n,
      },
    });
    await txHttpsData.wait();

    // 8. Chunked File "video.mp4"
    const txChunkFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["video.mp4", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcChunkFile = await txChunkFile.wait();
    const chunkFileUID = getUIDFromReceipt(rcChunkFile);

    const txChunkData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: chunkFileUID,
        data: schemaEncoder.encode(
          ["string", "string", "string"],
          ["web3://0x1234567890123456789012345678901234567890?chunkId=0", "video/mp4", "file"],
        ),
        value: 0n,
      },
    });
    await txChunkData.wait();

    // 9. Deeply Nested Folders: ideas -> deep -> nested -> deep_test.md
    const txDeepFolder = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ideasUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["deep", ZERO_BYTES32]),
        value: 0n,
      },
    });
    const rcDeepFolder = await txDeepFolder.wait();
    const deepFolderUID = getUIDFromReceipt(rcDeepFolder);

    const txNestedFolder = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: deepFolderUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["nested", ZERO_BYTES32]),
        value: 0n,
      },
    });
    const rcNestedFolder = await txNestedFolder.wait();
    const nestedFolderUID = getUIDFromReceipt(rcNestedFolder);

    const txDeepFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: nestedFolderUID,
        data: schemaEncoder.encode(["string", "bytes32"], ["deep_test.md", dataSchemaUID]),
        value: 0n,
      },
    });
    const rcDeepFile = await txDeepFile.wait();
    const deepFileUID = getUIDFromReceipt(rcDeepFile);

    const txDeepData = await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: deepFileUID,
        data: schemaEncoder.encode(
          ["string", "string", "string"],
          ["web3://0x1234567890123456789012345678901234567891", "text/markdown", "file"],
        ),
        value: 0n,
      },
    });
    await txDeepData.wait();
  });

  const getUIDFromReceipt = (receipt: any) => {
    const easInterface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = easInterface.parseLog(log);
        if (parsed && parsed.name === "Attested") {
          return parsed.args.uid;
        }
      } catch {}
    }
    throw new Error("Attested event not found");
  };

  describe("Directory Mocking and Resolution", function () {
    it("Should resolve correctly set mock structural attestations", async function () {
      expect(await indexer.resolvePath(ZERO_BYTES32, "root")).to.not.equal(ZERO_BYTES32);
      const rootUID = await indexer.resolvePath(ZERO_BYTES32, "root");
      expect(await indexer.resolvePath(rootUID, "ideas")).to.not.equal(ZERO_BYTES32);
    });
  });

  describe("EIP-6944: resolveMode()", function () {
    it('Should return strictly bytes32("5219") for resolveMode', async function () {
      const mode = await router.resolveMode();
      const expected = ethers.encodeBytes32String("5219");
      expect(mode).to.equal(expected);
    });
  });

  describe("EIP-5219: request()", function () {
    it("Should return 200, Content-Type, and ACTUAL file bytes for valid request", async function () {
      // Mock a real on-chain file payload mapped to the router's mock URI
      const targetAddress = "0x1234567890123456789012345678901234567890";
      const fileString = "Hello Decentralized World!";
      const fileBytes = Buffer.from(fileString, "utf8");
      // SSTORE2 encoded files start with a 0x00 byte
      const sstore2Bytecode = "0x00" + fileBytes.toString("hex");

      await setCode(targetAddress, sstore2Bytecode);

      // "root" is the base, not in the path for the web server to resolve
      const resource = ["ideas", "test.md"];
      const params: any[] = [];
      const [statusCode, body, headers] = await router.request(resource, params);

      expect(statusCode).to.equal(200);
      // body is now `bytes` (hex string) since EFSRouter returns bytes memory body
      const decodedBody = Buffer.from(ethers.getBytes(body)).toString("utf8");
      expect(decodedBody).to.equal(fileString);

      let hasContentType = false;
      for (const h of headers) {
        if (h.key === "Content-Type" && h.value === "text/markdown") hasContentType = true;
      }
      expect(hasContentType).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should return 404 for tombstone fileMode", async function () {
      const resource = ["ideas", "deleted.md"];
      const params: any[] = [];
      const [statusCode] = await router.request(resource, params);
      expect(statusCode).to.equal(404);
    });

    it("Should return 307 for symlink fileMode", async function () {
      const resource = ["ideas", "link.md"];
      const params: any[] = [];
      const [statusCode, , headers] = await router.request(resource, params);
      expect(statusCode).to.equal(307);

      let hasLocation = false;
      for (const h of headers) {
        if (h.key === "Location" && h.value === "/ideas/test.md") hasLocation = true;
      }
      expect(hasLocation).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should return message/external-body for IPFS URIs", async function () {
      const resource = ["ideas", "ipfs.md"];
      const params: any[] = [];
      const [statusCode, , headers] = await router.request(resource, params);
      expect(statusCode).to.equal(200);

      let hasExternalBody = false;
      for (const h of headers) {
        if (h.key === "Content-Type" && h.value.includes("message/external-body")) {
          expect(h.value).to.include('URL="ipfs://QmXxxx"');
          hasExternalBody = true;
        }
      }
      expect(hasExternalBody).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should return message/external-body for ar:// URIs", async function () {
      const [statusCode, , headers] = await router.request(["ideas", "arweave.md"], []);
      expect(statusCode).to.equal(200);

      let hasExternalBody = false;
      for (const h of headers) {
        if (h.key === "Content-Type" && h.value.includes("message/external-body")) {
          expect(h.value).to.include('URL="ar://abc123XYZ"');
          hasExternalBody = true;
        }
      }
      expect(hasExternalBody).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should return message/external-body for https:// URIs", async function () {
      const [statusCode, , headers] = await router.request(["ideas", "https_file.md"], []);
      expect(statusCode).to.equal(200);

      let hasExternalBody = false;
      for (const h of headers) {
        if (h.key === "Content-Type" && h.value.includes("message/external-body")) {
          expect(h.value).to.include('URL="https://example.com/file.txt"');
          hasExternalBody = true;
        }
      }
      expect(hasExternalBody).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    it("Should resolve deeply nested files across multiple folders", async function () {
      // Mock the test payload mapped to the router's mock URI
      const targetAddress = "0x1234567890123456789012345678901234567891"; // Mapped from our deep_test.md
      const fileString = "Deep Space Nine";
      const fileBytes = Buffer.from(fileString, "utf8");
      const sstore2Bytecode = "0x00" + fileBytes.toString("hex");

      await setCode(targetAddress, sstore2Bytecode);

      const resource = ["ideas", "deep", "nested", "deep_test.md"];
      const params: any[] = [];
      const [statusCode, body, headers] = await router.request(resource, params);

      expect(statusCode).to.equal(200);
      // body is now `bytes` (hex string) since EFSRouter returns bytes memory body
      const decodedBody = Buffer.from(ethers.getBytes(body)).toString("utf8");
      expect(decodedBody).to.equal(fileString);

      let hasContentType = false;
      for (const h of headers) {
        if (h.key === "Content-Type" && h.value === "text/markdown") hasContentType = true;
      }
      expect(hasContentType).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });
  });

  describe("EIP-7617: Chunking", function () {
    it("Should parse array storage and return web3-next-chunk header for multi-contract files", async function () {
      // 1. Setup the physical chunks
      const chunk0Address = "0x0000000000000000000000000000000000000001";
      const chunk1Address = "0x0000000000000000000000000000000000000002";

      const fileBytes0 = Buffer.from("Chunk 0 Data - ", "utf8");
      const fileBytes1 = Buffer.from("Chunk 1 Data", "utf8");

      await setCode(chunk0Address, "0x00" + fileBytes0.toString("hex"));
      await setCode(chunk1Address, "0x00" + fileBytes1.toString("hex"));

      // 2. Deploy MockChunkedFile wrapping those addresses
      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const mockChunkedFile = await MockChunkedFile.deploy([chunk0Address, chunk1Address]);
      await mockChunkedFile.waitForDeployment();

      // 3. Create a new file "long_video.mp4" pointing to our MockChunkedFile Address
      const bankAddr = await mockChunkedFile.getAddress();

      const schemaEncoder = {
        encode: (types: string[], values: any[]) => ethers.AbiCoder.defaultAbiCoder().encode(types, values),
      };

      const getUIDFromReceipt = (receipt: any) => {
        for (const log of receipt.logs) {
          try {
            const parsed = eas.interface.parseLog(log);
            if (parsed && parsed.name === "Attested") return parsed.args.uid;
          } catch {}
        }
        throw new Error("Attested event not found");
      };

      const txNewFile = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["long_video.mp4", dataSchemaUID]),
          value: 0n,
        },
      });
      const rcNewFile = await txNewFile.wait();
      const newFileUID = getUIDFromReceipt(rcNewFile);

      const txNewData = await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: newFileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            ["web3://" + bankAddr + "?chunkId=0", "video/mp4", "file"],
          ),
          value: 0n,
        },
      });
      await txNewData.wait();

      // --- Test Chunk 0 ---
      const resource = ["ideas", "long_video.mp4"];
      const params0 = [{ key: "chunk", value: "0" }];
      const [statusCode0, body0, headers0] = await router.request(resource, params0);

      expect(statusCode0).to.equal(200);
      // body is now `bytes` (hex string) since EFSRouter returns bytes memory body
      expect(Buffer.from(ethers.getBytes(body0)).toString("utf8")).to.equal("Chunk 0 Data - ");

      let hasNextChunk0 = false;
      for (const h of headers0) {
        if (h.key === "web3-next-chunk" && h.value === "?chunk=1") hasNextChunk0 = true;
      }
      expect(hasNextChunk0).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions

      // --- Test Chunk 1 ---
      const params1 = [{ key: "chunk", value: "1" }];
      const [statusCode1, body1, headers1] = await router.request(resource, params1);

      expect(statusCode1).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body1)).toString("utf8")).to.equal("Chunk 1 Data");

      let hasNextChunk1 = false;
      for (const h of headers1) {
        if (h.key === "web3-next-chunk") hasNextChunk1 = true;
      }
      // Last chunk should NOT have the next-chunk header
      expect(hasNextChunk1).to.be.false; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });
  });

  describe("Binary Data Fidelity", function () {
    /**
     * Bug #1 (SSTORE2 Prefix Stripping):
     * EFSRouter was returning the raw SSTORE2 contract bytecode including the mandatory
     * 0x00 prefix byte. This shifted the entire downloaded binary by 1, corrupting all files.
     * Fix: Yul assembly now reads extcodesize-1 bytes starting at offset 1.
     */
    it("Should strip the SSTORE2 0x00 prefix byte and return exact source bytes", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000010";
      // A small PNG-like binary payload with high bytes to detect corruption
      const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
      // SSTORE2 stores: [0x00 (STOP opcode)] + [data]
      await setCode(targetAddress, "0x00" + originalBytes.toString("hex"));

      const schemaEncoder = new ethers.AbiCoder();
      const txFileAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["bin_test.png", dataSchemaUID]),
          value: 0n,
        },
      });
      const rcFileAnchor = await txFileAnchor.wait();
      const fileUID = getUIDFromReceipt(rcFileAnchor);

      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(["string", "string", "string"], [`web3://${targetAddress}`, "image/png", "file"]),
          value: 0n,
        },
      });

      const [statusCode, body] = await router.request(["ideas", "bin_test.png"], []);
      expect(statusCode).to.equal(200);

      const returnedBytes = Buffer.from(ethers.getBytes(body));
      expect(returnedBytes.length).to.equal(
        originalBytes.length,
        `Expected ${originalBytes.length} bytes but got ${returnedBytes.length}. SSTORE2 prefix stripping may be broken.`,
      );
      expect(returnedBytes[0]).to.equal(0x89, "First byte should be 0x89 (PNG magic), not 0x00 (SSTORE2 prefix).");
      expect(returnedBytes.toString("hex")).to.equal(
        originalBytes.toString("hex"),
        "Returned bytes must match source exactly, byte-for-byte.",
      );
    });

    /**
     * Bug #2 (Binary Byte Fidelity / UTF-8 Corruption):
     * EFSRouter.request() was returning `string memory body` which caused Viem/ethers to
     * implicitly interpret the bytes as UTF-8, corrupting binary data like PNG headers.
     * Fix: Changed return type to `bytes memory body`.
     */
    it("Should return raw bytes without UTF-8 corruption for high-byte binary payloads", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000011";
      // Bytes that are illegal in UTF-8 and would be replaced with 0xEFBFBD if decoded as string
      const highBytes = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01, 0x80, 0xc0]);
      await setCode(targetAddress, "0x00" + highBytes.toString("hex"));

      const schemaEncoder = new ethers.AbiCoder();
      const txFileAnchor = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["raw_binary.bin", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFileAnchor.wait());

      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${targetAddress}`, "application/octet-stream", "file"],
          ),
          value: 0n,
        },
      });

      const [statusCode, body] = await router.request(["ideas", "raw_binary.bin"], []);
      expect(statusCode).to.equal(200);

      const returnedBytes = Buffer.from(ethers.getBytes(body));
      expect(returnedBytes.toString("hex")).to.equal(
        highBytes.toString("hex"),
        "High bytes (0xFF, 0xFE, etc.) must survive intact. UTF-8 decoding corrupts them.",
      );
      expect(returnedBytes[0]).to.equal(0xff, "0xFF must not become 0xEF (UTF-8 replacement byte).");
    });

    /**
     * Bug #3 (MockChunkedFile ABI Selector):
     * `Toolbar.tsx` was hardcoded with old MockChunkedFile bytecode that used a different
     * function selector for chunkCount(). EFSRouter could not detect it as a chunked file.
     * Fix: Updated to freshly compiled MockChunkedFile bytecode.
     * This test ensures chunkCount() is callable with the correct ABI.
     */
    it("Should detect MockChunkedFile via staticcall to chunkCount() with correct selector", async function () {
      const chunk0 = "0x0000000000000000000000000000000000000020";
      await setCode(chunk0, "0x00" + Buffer.from("hello").toString("hex"));

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy([chunk0]);
      await chunkedFile.waitForDeployment();

      // Verify chunkCount() is callable and returns 1
      expect(await chunkedFile.chunkCount()).to.equal(1n, "chunkCount() must return number of chunks");

      // Verify we can call chunkAddress(0) and get the first chunk
      const addr = await chunkedFile.chunkAddress(0);
      expect(addr.toLowerCase()).to.equal(chunk0.toLowerCase());

      // Verify the function selector for chunkCount() is correct
      // keccak256("chunkCount()") = 0x2bfedae0...
      const iface = MockChunkedFile.interface;
      const selector = iface.getFunction("chunkCount")!.selector;
      // keccak256("chunkCount()") = 0xf91f0937
      expect(selector).to.equal(
        "0xf91f0937",
        "chunkCount() selector must be 0xf91f0937. If this changes, update Toolbar.tsx bytecode.",
      );
    });

    /**
     * Bug #4 (Multi-Chunk Pagination):
     * FileBrowser.tsx fallback loop wasn't iterating through all chunks via web3-next-chunk.
     * This test verifies the full 3-chunk pagination chain works correctly from the router side.
     */
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

      const schemaEncoder = new ethers.AbiCoder();
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["chunked.bin", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());
      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${mgr}`, "application/octet-stream", "file"],
          ),
          value: 0n,
        },
      });

      const resource = ["ideas", "chunked.bin"];

      // Chunk 0: should have web3-next-chunk=?chunk=1
      const [s0, b0, h0] = await router.request(resource, [{ key: "chunk", value: "0" }]);
      expect(s0).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b0)).toString()).to.equal(d0.toString());
      const next0 = h0.find((h: any) => h.key === "web3-next-chunk");
      expect(next0, "Chunk 0 must have web3-next-chunk header").to.not.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
      expect(next0.value).to.equal("?chunk=1");

      // Chunk 1: should have web3-next-chunk=?chunk=2
      const [s1, b1, h1] = await router.request(resource, [{ key: "chunk", value: "1" }]);
      expect(s1).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b1)).toString()).to.equal(d1.toString());
      const next1 = h1.find((h: any) => h.key === "web3-next-chunk");
      expect(next1, "Chunk 1 must have web3-next-chunk header").to.not.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
      expect(next1.value).to.equal("?chunk=2");

      // Chunk 2 (last): must NOT have web3-next-chunk
      const [s2, b2, h2] = await router.request(resource, [{ key: "chunk", value: "2" }]);
      expect(s2).to.equal(200);
      expect(Buffer.from(ethers.getBytes(b2)).toString()).to.equal(d2.toString());
      const next2 = h2.find((h: any) => h.key === "web3-next-chunk");
      expect(next2, "Last chunk must NOT have web3-next-chunk header").to.be.undefined; // eslint-disable-line @typescript-eslint/no-unused-expressions
    });

    /**
     * Bug #5 (Chunk Out-of-Bounds):
     * Requesting a chunk index beyond the total chunk count should return 404, not revert.
     */
    it("Should return 404 for out-of-bounds chunk index", async function () {
      const c0 = "0x0000000000000000000000000000000000000040";
      await setCode(c0, "0x00" + Buffer.from("data").toString("hex"));

      const MockChunkedFile = await ethers.getContractFactory("MockChunkedFile");
      const chunkedFile = await MockChunkedFile.deploy([c0]);
      await chunkedFile.waitForDeployment();
      const mgr = await chunkedFile.getAddress();

      const schemaEncoder = new ethers.AbiCoder();
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["oob.bin", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());
      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${mgr}`, "application/octet-stream", "file"],
          ),
          value: 0n,
        },
      });

      const [statusCode] = await router.request(["ideas", "oob.bin"], [{ key: "chunk", value: "99" }]);
      expect(statusCode).to.equal(404, "Out-of-bounds chunk index must return 404, not revert.");
    });

    /**
     * Bug #6 (Full Concatenation / No Duplicate Chunks):
     * FileBrowser.tsx was not clearing `result = []` before the fallback loop, causing
     * web3protocol's partial first chunk to be double-counted, adding 24KB of duplicate data.
     * This test verifies the full reassembled file matches source bytes exactly.
     */
    it("Should reassemble all chunks byte-for-byte matching the original binary source", async function () {
      // Simulate a 3-chunk binary PNG-like file
      const chunks = [
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG header
        Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]), // IHDR chunk start
        Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), // Trailing zeros
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

      const schemaEncoder = new ethers.AbiCoder();
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["full_concat.png", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());
      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(["string", "string", "string"], [`web3://${mgr}`, "image/png", "file"]),
          value: 0n,
        },
      });

      // Reassemble all chunks exactly as FileBrowser.tsx does
      const result: number[] = [];
      for (let i = 0; i < chunks.length; i++) {
        const [statusCode, body] = await router.request(
          ["ideas", "full_concat.png"],
          [{ key: "chunk", value: String(i) }],
        );
        expect(statusCode).to.equal(200);
        const chunkBytes = ethers.getBytes(body);
        for (const b of chunkBytes) result.push(b);
      }

      const reassembled = Buffer.from(result);
      expect(reassembled.length).to.equal(
        originalFull.length,
        `Reassembled ${reassembled.length} bytes but expected ${originalFull.length}. Duplicate chunks may exist.`,
      );
      expect(reassembled.toString("hex")).to.equal(
        originalFull.toString("hex"),
        "Reassembled bytes must exactly match the original binary source.",
      );
    });
  });

  describe("Edge Cases (Code Review)", function () {
    /**
     * Review Issue #8: Empty resource path should return 404.
     * The empty-path guard was unreachable inside the for-loop; now moved before it.
     */
    it("Should return 404 for empty resource path", async function () {
      const [statusCode, body] = await router.request([], []);
      expect(statusCode).to.equal(404);
      const msg = Buffer.from(ethers.getBytes(body)).toString("utf8");
      expect(msg).to.include("Empty path");
    });

    /**
     * Review Issue #11: Malformed chunk param silently becomes 0.
     * `_parseUint` returns 0 for non-numeric strings. This test documents that behavior.
     */
    it("Should treat malformed chunk param as chunk 0", async function () {
      const targetAddress = "0x0000000000000000000000000000000000000060";
      const originalBytes = Buffer.from("chunk zero data");
      await setCode(targetAddress, "0x00" + originalBytes.toString("hex"));

      const schemaEncoder = new ethers.AbiCoder();
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["malformed_chunk.bin", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());
      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${targetAddress}`, "application/octet-stream", "file"],
          ),
          value: 0n,
        },
      });

      // "abc" is not a valid integer, _parseUint returns 0
      const [statusCode, body] = await router.request(
        ["ideas", "malformed_chunk.bin"],
        [{ key: "chunk", value: "abc" }],
      );
      expect(statusCode).to.equal(200, "Malformed chunk param should fall back to chunk 0 (non-chunked file).");

      const returnedBytes = Buffer.from(ethers.getBytes(body));
      expect(returnedBytes.toString()).to.equal("chunk zero data");
    });

    /**
     * Review Issue #12: Invalid web3:// URI format.
     * _parseContractFromWeb3URI returns address(0) for URIs shorter than 49 chars,
     * which hits the extcodesize==0 guard and returns 500.
     */
    it("Should return 500 for invalid web3:// URI format", async function () {
      const schemaEncoder = new ethers.AbiCoder();
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["bad_uri.bin", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());
      // URI too short to be valid web3://
      await eas.attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            ["web3://short", "application/octet-stream", "file"],
          ),
          value: 0n,
        },
      });

      const [statusCode] = await router.request(["ideas", "bad_uri.bin"], []);
      expect(statusCode).to.equal(
        500,
        "Invalid web3:// URI should return 500 because parsed address is address(0) with no code.",
      );
    });

    /**
     * EFSRouter _parseAddressList test for Editions.
     * Verifies that the router correctly parses a comma-separated list of addresses
     * and filters the file visibility accordingly.
     */
    it("Should parse comma-separated editions list and filter file visibility", async function () {
      const u1 = "0x1111111111111111111111111111111111111111";
      const u2 = "0x2222222222222222222222222222222222222222";

      const targetAddress1 = "0x0000000000000000000000000000000000000071";
      const targetAddress2 = "0x0000000000000000000000000000000000000072";

      await setCode(targetAddress1, "0x00" + Buffer.from("User 1 Data").toString("hex"));
      await setCode(targetAddress2, "0x00" + Buffer.from("User 2 Data").toString("hex"));

      const schemaEncoder = new ethers.AbiCoder();

      // Create a shared file anchor
      const txFA = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: false,
          refUID: ideasUID,
          data: schemaEncoder.encode(["string", "bytes32"], ["shared.txt", dataSchemaUID]),
          value: 0n,
        },
      });
      const fileUID = getUIDFromReceipt(await txFA.wait());

      // User 1 attaches Data
      // To mimic another user, we impersonate them via hardhat
      await ethers.provider.send("hardhat_impersonateAccount", [u1]);
      const signer1 = await ethers.getSigner(u1);
      // Give them eth to attest
      await owner.sendTransaction({ to: u1, value: ethers.parseEther("1.0") });

      await eas.connect(signer1).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${targetAddress1}`, "text/plain", "file"],
          ),
          value: 0n,
        },
      });

      // User 2 attaches Data
      await ethers.provider.send("hardhat_impersonateAccount", [u2]);
      const signer2 = await ethers.getSigner(u2);
      await owner.sendTransaction({ to: u2, value: ethers.parseEther("1.0") });

      await eas.connect(signer2).attest({
        schema: dataSchemaUID,
        data: {
          recipient: ZeroAddress,
          expirationTime: NO_EXPIRATION,
          revocable: true,
          refUID: fileUID,
          data: schemaEncoder.encode(
            ["string", "string", "string"],
            [`web3://${targetAddress2}`, "text/plain", "file"],
          ),
          value: 0n,
        },
      });

      // Request with ONLY User 2 in the editions list
      const [statusCode2, body2] = await router.request(["ideas", "shared.txt"], [{ key: "editions", value: u2 }]);
      expect(statusCode2).to.equal(200);
      expect(Buffer.from(ethers.getBytes(body2)).toString()).to.equal("User 2 Data");

      // Request with comma-separated list [u2, u1] -> should resolve u2 because round-robin prioritizes the first matching in list iteration
      const [statusCodeBoth, bodyBoth] = await router.request(
        ["ideas", "shared.txt"],
        [{ key: "editions", value: `${u2},${u1}` }],
      );
      expect(statusCodeBoth).to.equal(200);
      expect(Buffer.from(ethers.getBytes(bodyBoth)).toString()).to.equal(
        "User 2 Data",
        "Comma-separated parsing should prioritize earlier addresses in the list",
      );

      // Request with comma-separated list [u1, u2] -> should resolve u1
      const [statusCodeRev, bodyRev] = await router.request(
        ["ideas", "shared.txt"],
        [{ key: "editions", value: `${u1},${u2}` }],
      );
      expect(statusCodeRev).to.equal(200);
      expect(Buffer.from(ethers.getBytes(bodyRev)).toString()).to.equal("User 1 Data");

      // Request with nonsense and then u1
      const [statusCodeNonsense, bodyNonsense] = await router.request(
        ["ideas", "shared.txt"],
        [{ key: "editions", value: `nonsense,${u1}` }],
      );
      expect(statusCodeNonsense).to.equal(200);
      expect(Buffer.from(ethers.getBytes(bodyNonsense)).toString()).to.equal(
        "User 1 Data",
        "Should skip invalid addresses cleanly and continue to u1",
      );
    });
  });
});
