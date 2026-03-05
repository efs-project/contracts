import { expect } from "chai";
import { ethers } from "hardhat";
import { setCode } from "@nomicfoundation/hardhat-network-helpers";
import { Contract, Signer, ZeroAddress } from "ethers";
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
            anchorSchemaUID,
            dataSchemaUID,
            anchorSchemaUID,
            anchorSchemaUID
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
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ZERO_BYTES32, data: schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]), value: 0n },
        });
        const rcRoot = await txRoot.wait();
        const rootUID = getUIDFromReceipt(rcRoot);

        // 2. Folder "ideas"
        const txIdeas = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: rootUID, data: schemaEncoder.encode(["string", "bytes32"], ["ideas", ZERO_BYTES32]), value: 0n },
        });
        const rcIdeas = await txIdeas.wait();
        ideasUID = getUIDFromReceipt(rcIdeas);

        // 3. File Anchor "test.md"
        const txFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["test.md", dataSchemaUID]), value: 0n },
        });
        const rcFile = await txFile.wait();
        const fileUID = getUIDFromReceipt(rcFile);

        // 4. Data Attestation (Quad-Schema) - Default File
        const txData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: fileUID, data: schemaEncoder.encode(["string", "string", "string"], ["web3://0x1234567890123456789012345678901234567890", "text/markdown", "file"]), value: 0n },
        });
        await txData.wait();

        // 5. Tombstone Mock File "deleted.md"
        const txTombFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["deleted.md", dataSchemaUID]), value: 0n },
        });
        const rcTombFile = await txTombFile.wait();
        const tombFileUID = getUIDFromReceipt(rcTombFile);

        const txTombData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: tombFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["", "", "tombstone"]), value: 0n },
        });
        await txTombData.wait();

        // 6. Symlink Mock File "link.md"
        const txSymFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["link.md", dataSchemaUID]), value: 0n },
        });
        const rcSymFile = await txSymFile.wait();
        const symFileUID = getUIDFromReceipt(rcSymFile);

        const txSymData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: symFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["/ideas/test.md", "", "symlink"]), value: 0n },
        });
        await txSymData.wait();

        // 7. IPFS Mock File "ipfs.md"
        const txIpfsFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["ipfs.md", dataSchemaUID]), value: 0n },
        });
        const rcIpfsFile = await txIpfsFile.wait();
        const ipfsFileUID = getUIDFromReceipt(rcIpfsFile);

        const txIpfsData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: ipfsFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["ipfs://QmXxxx", "image/png", "file"]), value: 0n },
        });
        await txIpfsData.wait();

        // 8. Chunked File "video.mp4"
        const txChunkFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["video.mp4", dataSchemaUID]), value: 0n },
        });
        const rcChunkFile = await txChunkFile.wait();
        const chunkFileUID = getUIDFromReceipt(rcChunkFile);

        const txChunkData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: chunkFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["web3://0x1234567890123456789012345678901234567890?chunkId=0", "video/mp4", "file"]), value: 0n },
        });
        await txChunkData.wait();

        // 9. Deeply Nested Folders: ideas -> deep -> nested -> deep_test.md
        const txDeepFolder = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["deep", ZERO_BYTES32]), value: 0n },
        });
        const rcDeepFolder = await txDeepFolder.wait();
        const deepFolderUID = getUIDFromReceipt(rcDeepFolder);

        const txNestedFolder = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: deepFolderUID, data: schemaEncoder.encode(["string", "bytes32"], ["nested", ZERO_BYTES32]), value: 0n },
        });
        const rcNestedFolder = await txNestedFolder.wait();
        const nestedFolderUID = getUIDFromReceipt(rcNestedFolder);

        const txDeepFile = await eas.attest({
            schema: anchorSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: nestedFolderUID, data: schemaEncoder.encode(["string", "bytes32"], ["deep_test.md", dataSchemaUID]), value: 0n },
        });
        const rcDeepFile = await txDeepFile.wait();
        const deepFileUID = getUIDFromReceipt(rcDeepFile);

        const txDeepData = await eas.attest({
            schema: dataSchemaUID,
            data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: true, refUID: deepFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["web3://0x1234567890123456789012345678901234567891", "text/markdown", "file"]), value: 0n },
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
            } catch { }
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
        it("Should return strictly bytes32(\"5219\") for resolveMode", async function () {
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
            expect(body).to.equal(fileString);

            let hasContentType = false;
            for (let h of headers) {
                if (h.key === "Content-Type" && h.value === "text/markdown") hasContentType = true;
            }
            expect(hasContentType).to.be.true;
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
            for (let h of headers) {
                if (h.key === "Location" && h.value === "/ideas/test.md") hasLocation = true;
            }
            expect(hasLocation).to.be.true;
        });

        it("Should return message/external-body for IPFS URIs", async function () {
            const resource = ["ideas", "ipfs.md"];
            const params: any[] = [];
            const [statusCode, , headers] = await router.request(resource, params);
            expect(statusCode).to.equal(200);

            let hasExternalBody = false;
            for (let h of headers) {
                if (h.key === "Content-Type" && h.value.includes("message/external-body")) {
                    expect(h.value).to.include('URL="ipfs://QmXxxx"');
                    hasExternalBody = true;
                }
            }
            expect(hasExternalBody).to.be.true;
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
            expect(body).to.equal(fileString);

            let hasContentType = false;
            for (let h of headers) {
                if (h.key === "Content-Type" && h.value === "text/markdown") hasContentType = true;
            }
            expect(hasContentType).to.be.true;
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
                encode: (types: string[], values: any[]) => ethers.AbiCoder.defaultAbiCoder().encode(types, values)
            };

            const getUIDFromReceipt = (receipt: any) => {
                for (const log of receipt.logs) {
                    try {
                        const parsed = eas.interface.parseLog(log);
                        if (parsed && parsed.name === "Attested") return parsed.args.uid;
                    } catch { }
                }
                throw new Error("Attested event not found");
            };

            const txNewFile = await eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: 0n, revocable: false, refUID: ideasUID, data: schemaEncoder.encode(["string", "bytes32"], ["long_video.mp4", dataSchemaUID]), value: 0n },
            });
            const rcNewFile = await txNewFile.wait();
            const newFileUID = getUIDFromReceipt(rcNewFile);

            const txNewData = await eas.attest({
                schema: dataSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: 0n, revocable: true, refUID: newFileUID, data: schemaEncoder.encode(["string", "string", "string"], ["web3://" + bankAddr + "?chunkId=0", "video/mp4", "file"]), value: 0n },
            });
            await txNewData.wait();

            // --- Test Chunk 0 ---
            const resource = ["ideas", "long_video.mp4"];
            const params0 = [{ key: "chunk", value: "0" }];
            const [statusCode0, body0, headers0] = await router.request(resource, params0);

            expect(statusCode0).to.equal(200);
            expect(body0).to.equal("Chunk 0 Data - ");

            let hasNextChunk0 = false;
            for (let h of headers0) {
                if (h.key === "web3-next-chunk" && h.value === "?chunk=1") hasNextChunk0 = true;
            }
            expect(hasNextChunk0).to.be.true;

            // --- Test Chunk 1 ---
            const params1 = [{ key: "chunk", value: "1" }];
            const [statusCode1, body1, headers1] = await router.request(resource, params1);

            expect(statusCode1).to.equal(200);
            expect(body1).to.equal("Chunk 1 Data");

            let hasNextChunk1 = false;
            for (let h of headers1) {
                if (h.key === "web3-next-chunk") hasNextChunk1 = true;
            }
            // Last chunk should NOT have the next-chunk header
            expect(hasNextChunk1).to.be.false;
        });
    });
});
