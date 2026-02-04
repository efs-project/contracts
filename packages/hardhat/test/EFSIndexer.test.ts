import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress, encodeBytes32String, solidityPackedKeccak256 } from "ethers";

// Constants
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSIndexer", function () {
    let indexer: EFSIndexer;
    let eas: EAS;
    let registry: SchemaRegistry;
    let owner: Signer;
    let user1: Signer;
    let user2: Signer;

    let anchorSchemaUID: string;
    let propertySchemaUID: string;
    let dataSchemaUID: string;
    let blobSchemaUID: string;
    let tagSchemaUID: string;
    let likeSchemaUID: string; // For generic indexing tests
    let commentSchemaUID: string; // For generic indexing tests

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

        // Determine future address of Indexer to register schemas with it first.
        // This resolves the circular dependency where schemas need a resolver address, 
        // but the resolver (Indexer) needs schema UIDs in its constructor.

        const ownerAddr = await owner.getAddress();
        const nonce = await ethers.provider.getTransactionCount(ownerAddr);
        // Calculate the future address of the Indexer using the owner's nonce.
        // The Indexer is deployed after SchemaRegistry registration transactions.
        const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 7 }); // Adjusted nonce for new schemas

        // Register Schemas with the future resolver address
        // ANCHOR: string name
        const tx1 = await registry.register("string name", futureIndexerAddr, true);
        const rc1 = await tx1.wait();
        anchorSchemaUID = rc1!.logs[0].topics[1]; // Registered(bytes32 uid, ...)

        // PROPERTY: string key, string value
        const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
        const rc2 = await tx2.wait();
        propertySchemaUID = rc2!.logs[0].topics[1];

        // DATA: bytes32 blobUID, string fileMode (Removed metadata)
        const tx3 = await registry.register("bytes32 blobUID, string fileMode", futureIndexerAddr, true);
        const rc3 = await tx3.wait();
        dataSchemaUID = rc3!.logs[0].topics[1];

        // BLOB: string mimeType, uint8 storageType, bytes location
        // Register BLOB schema with no resolver (resolver = ZeroAddress) as it holds raw data.
        const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true); // No resolver
        const rc4 = await tx4.wait();
        blobSchemaUID = rc4!.logs[0].topics[1];

        // TAG: bytes32 labelUID, int256 weight (Changed from bool isNegative)
        const tx5 = await registry.register("bytes32 labelUID, int256 weight", futureIndexerAddr, true);
        const rc5 = await tx5.wait();
        tagSchemaUID = rc5!.logs[0].topics[1];

        // LIKE: bytes32 targetUID
        const tx6 = await registry.register("bytes32 targetUID", futureIndexerAddr, true);
        const rc6 = await tx6.wait();
        likeSchemaUID = rc6!.logs[0].topics[1];

        // COMMENT: bytes32 targetUID, string comment
        const tx7 = await registry.register("bytes32 targetUID, string comment", futureIndexerAddr, true);
        const rc7 = await tx7.wait();
        commentSchemaUID = rc7!.logs[0].topics[1];

        // 3. Deploy Indexer
        const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
        indexer = await IndexerFactory.deploy(
            await eas.getAddress(),
            anchorSchemaUID,
            propertySchemaUID,
            dataSchemaUID,
            blobSchemaUID,
            tagSchemaUID
        );
        await indexer.waitForDeployment();

        expect(await indexer.getAddress()).to.equal(futureIndexerAddr);
    });

    const getUIDFromReceipt = (receipt: any) => {
        const easInterface = eas.interface;
        for (const log of receipt.logs) {
            try {
                const parsed = easInterface.parseLog(log);
                if (parsed && parsed.name === "Attested") {
                    return parsed.args.uid;
                }
            } catch (e) {
                // ignore
            }
        }
        throw new Error("Attested event not found");
    };

    describe("Enforcement (Anchor)", function () {
        // ... (Existing tests) ...

        it("should allow creating a root anchor (First Anchor)", async function () {
            // ... (Existing logic) ...
            const schemaEncoder = new ethers.AbiCoder();
            const data = schemaEncoder.encode(["string"], ["root"]);
            const tx = await eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ZERO_BYTES32, data: data, value: 0n }
            });
            const receipt = await tx.wait();

            // Verify Indexer State
            // Note: TypeScript might not see 'rootAnchorUID' yet if typechain isn't recompiled
            // We cast to any to bypass valid compile error until recompile happens
            const rootUID = await (indexer as any).rootAnchorUID();
            const attestedUID = getUIDFromReceipt(receipt);
            expect(rootUID).to.equal(attestedUID);
        });

        it("Should fail if creating second root anchor", async function () {
            const schemaEncoder = new ethers.AbiCoder();

            // 1. Create First Root (Should Succeed)
            const data1 = schemaEncoder.encode(["string"], ["root1"]);
            await eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ZERO_BYTES32, data: data1, value: 0n }
            });

            // 2. Try to create Second Root (Should ensure parentUID is checked properly)
            // Note: New logic allows multiple roots if they have internal validation? NO.
            // Logic: if rootAnchorUID != 0, and parent == 0, and uid != rootAnchorUID -> MissingParent.
            // So this test should still pass (revert).

            const data2 = schemaEncoder.encode(["string"], ["root2"]);
            await expect(eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ZERO_BYTES32, data: data2, value: 0n }
            })).to.be.revertedWithCustomError(indexer, "MissingParent");
        });

        it("should Revert when creating duplicate filename in same directory", async function () {
            const schemaEncoder = new ethers.AbiCoder();

            // 1. Create Root
            const rootData = schemaEncoder.encode(["string"], ["root"]);
            const rootTx = await eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: ZERO_BYTES32, data: rootData, value: 0n }
            });
            const rootReceipt = await rootTx.wait();
            const rootUID = getUIDFromReceipt(rootReceipt);

            // 2. Create "config.json" in Root
            const data = schemaEncoder.encode(["string"], ["config.json"]);
            await eas.attest({
                schema: anchorSchemaUID,
                data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: rootUID, data: data, value: 0n }
            });

            // 3. Attempt Duplicate "config.json" in Root
            await expect(
                eas.attest({
                    schema: anchorSchemaUID,
                    data: { recipient: ZeroAddress, expirationTime: NO_EXPIRATION, revocable: false, refUID: rootUID, data: data, value: 0n }
                })
            ).to.be.revertedWithCustomError(indexer, "DuplicateFileName");
        });
    });

    describe("Enforcement (Relationships)", function () {
        it("Should fail to attach DATA to a non-Anchor (e.g. Root)", async function () {
            // Try attaching DATA to ZeroHash (not an Anchor)
            const schemaEncoder = new ethers.AbiCoder();
            // Expect EAS to revert with InvalidAttestation() because indexer returns false
            await expect(eas.attest({
                schema: dataSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: ZERO_BYTES32, // Invalid Ref
                    data: schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]),
                    value: 0n
                }
            })).to.be.revertedWithCustomError(eas, "InvalidAttestation");
        });

        it("Should rejection DATA attached to invalid UID", async function () {
            const schemaEncoder = new ethers.AbiCoder();
            await expect(eas.attest({
                schema: dataSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]),
                    value: 0n
                }
            })).to.be.revertedWithCustomError(eas, "InvalidAttestation");
        });

        it("Should reject PROPERTY attached to non-Anchor", async function () {
            const schemaEncoder = new ethers.AbiCoder();
            await expect(eas.attest({
                schema: propertySchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["val"]),
                    value: 0n
                }
            })).to.be.revertedWithCustomError(eas, "InvalidAttestation");
        });
    });

    describe("Path Resolution", function () {
        it("Should resolve root paths", async function () {
            const schemaEncoder = new ethers.AbiCoder();
            const tx = await eas.connect(user1).attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["test_file"]),
                    value: 0n
                }
            });
            const receipt = await tx.wait();
            const uid = await getUIDFromReceipt(receipt);

            expect(await indexer.resolvePath(ZERO_BYTES32, "test_file")).to.equal(uid);
        });

        it("should resolve nested paths", async function () {
            const schemaEncoder = new ethers.AbiCoder();

            // /home
            const tx1 = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["home"]),
                    value: 0n,
                },
            });
            const receipt1 = await tx1.wait();
            // We need the UID. In tests we can compute it or get from event.
            // EAS emits Attested(bytes32 indexed uid, ...)
            // But `attest` function returns transaction. 
            // Hardhat-EAS helpers usually return UID string but I'm calling raw contract.
            // Let's parse logs.
            const homeUID = getUIDFromReceipt(receipt1); // Attested event
            // Better: compute UID vs fetch from indexer resolvePath.
            // Here we use indexer to resolve the path and verify it matches the latest attestation.
            const resolvedHome = await indexer.resolvePath(ZERO_BYTES32, "home");
            expect(resolvedHome).to.equal(homeUID);

            // /home/user
            const tx2 = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: homeUID,
                    data: schemaEncoder.encode(["string"], ["user"]),
                    value: 0n,
                },
            });
            const receipt2 = await tx2.wait();
            // Verify that the retrieved UID matches the one from resolution logic
            // Note: EAS `attest` call returns a receipt, but parsing logs depends on which contract emitted events.
            // We use getUIDFromReceipt to extract the UID from the EAS 'Attested' event.

            const userUID = (await indexer.resolvePath(homeUID, "user"));
            expect(userUID).to.not.equal(ZERO_BYTES32);

            // /home/user/docs
            const tx3 = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: userUID,
                    data: schemaEncoder.encode(["string"], ["docs"]),
                    value: 0n,
                },
            });

            const docsUID = await indexer.resolvePath(userUID, "docs");
            expect(docsUID).to.not.equal(ZERO_BYTES32);
        });
    });

    describe("Hierarchy & Pagination", function () {
        let parentUID: string;
        let child1UID: string;
        let child2UID: string;
        let child3UID: string;
        const schemaEncoder = new ethers.AbiCoder();

        beforeEach(async function () {
            // Create Parent
            const txParent = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["parent"]),
                    value: 0n,
                },
            });
            const receiptParent = await txParent.wait();
            parentUID = getUIDFromReceipt(receiptParent);

            // Create 3 children
            const createChild = async (name: string) => {
                const tx = await eas.attest({
                    schema: anchorSchemaUID,
                    data: {
                        recipient: ZeroAddress,
                        expirationTime: NO_EXPIRATION,
                        revocable: false,
                        refUID: parentUID,
                        data: schemaEncoder.encode(["string"], [name]),
                        value: 0n,
                    },
                });
                const receipt = await tx.wait();
                return getUIDFromReceipt(receipt);
            };

            child1UID = await createChild("child1");
            child2UID = await createChild("child2");
            child3UID = await createChild("child3");
        });

        it("Should paginate children (Forward)", async function () {
            // Updated signature: getChildren(uid, start, length, reverse)
            const page1 = await indexer.getChildren(parentUID, 0, 2, false);
            expect(page1.length).to.equal(2);
            expect(page1[0]).to.equal(child1UID);
            expect(page1[1]).to.equal(child2UID);

            const page2 = await indexer.getChildren(parentUID, 2, 2, false);
            expect(page2.length).to.equal(1);
            expect(page2[0]).to.equal(child3UID);

            const count = await indexer.getChildrenCount(parentUID);
            expect(count).to.equal(3);
        });

        it("Should paginate children (Reverse)", async function () {
            // Updated signature: getChildren(uid, start, length, reverse)
            // Reverse: start 0 means "latest"
            const page1 = await indexer.getChildren(parentUID, 0, 2, true);
            expect(page1.length).to.equal(2);
            expect(page1[0]).to.equal(child3UID); // Last added is first
            expect(page1[1]).to.equal(child2UID);
        });
    });

    describe("Filtering & MimeTypes", function () {
        let parentUID: string;
        let blobUID: string;
        let dataUID: string;
        let userFileUID: string;
        let user2FileUID: string;
        let fileUID: string;
        const schemaEncoder = new ethers.AbiCoder();

        beforeEach(async function () {
            // 1. Create Parent "files"
            const txParent = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["files"]),
                    value: 0n,
                },
            });
            const receiptParent = await txParent.wait();
            parentUID = getUIDFromReceipt(receiptParent);

            // 2. Create BLOB (video/mp4)
            const blobTx = await eas.attest({
                schema: blobSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(
                        ["string", "uint8", "bytes"],
                        ["video/mp4", 0, "0x1234"]
                    ),
                    value: 0n,
                }
            });
            const blobReceipt = await blobTx.wait();
            blobUID = getUIDFromReceipt(blobReceipt);

            // 3. Create Anchor "my_video.mp4" inside "files"
            const txFile = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: parentUID,
                    data: schemaEncoder.encode(["string"], ["my_video.mp4"]),
                    value: 0n
                }
            });
            const rcFile = await txFile.wait();
            fileUID = getUIDFromReceipt(rcFile);

            // 4. Attach DATA to "my_video.mp4"
            const dataTx = await eas.attest({
                schema: dataSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: fileUID, // Points to the file Anchor
                    data: schemaEncoder.encode(
                        ["bytes32", "string"],
                        [blobUID, "0644"]
                    ),
                    value: 0n
                }
            });
            await dataTx.wait();

            // Setup for Attester Filter
            // User A creates file "user1.txt" in "files"
            const txUser1File = await eas.connect(user1).attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: parentUID,
                    data: schemaEncoder.encode(["string"], ["user1.txt"]),
                    value: 0n,
                },
            });
            const receiptUser1File = await txUser1File.wait();
            userFileUID = getUIDFromReceipt(receiptUser1File);

            // User B creates file "user2.txt" in "files"
            const txUser2File = await eas.connect(user2).attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: parentUID,
                    data: schemaEncoder.encode(["string"], ["user2.txt"]),
                    value: 0n,
                },
            });
            const receiptUser2File = await txUser2File.wait();
            user2FileUID = getUIDFromReceipt(receiptUser2File);
        });

        it("Should index by mime type and category", async function () {
            // Verify getChildrenByType("video/mp4") on Parent ("files")
            // Should return "my_video.mp4" (fileUID)
            const videos = await indexer.getChildrenByType(parentUID, "video/mp4", 0, 10, false);
            expect(videos).to.include(fileUID);

            // Verify getChildrenByType("video") - Category
            const category = await indexer.getChildrenByType(parentUID, "video", 0, 10, false);
            expect(category).to.include(fileUID);
        });

        it("Should filter by Attester", async function () {
            // Filter children of "files" by User A
            const u1Files = await indexer.getChildrenByAttester(parentUID, await user1.getAddress(), 0, 10, false);
            expect(u1Files.length).to.equal(1);
            expect(u1Files[0]).to.equal(userFileUID);

            // Filter children of "files" by User B
            const u2Files = await indexer.getChildrenByAttester(parentUID, await user2.getAddress(), 0, 10, false);
            expect(u2Files.length).to.equal(1);
            expect(u2Files[0]).to.equal(user2FileUID);
        });
    });

    describe("Revocation", function () {
        it("should PREVENT revocation of Anchors", async function () {
            const schemaEncoder = new ethers.AbiCoder();
            // Create "temp.txt"
            const tx = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false, // Schema is now irrevocable
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["temp.txt"]),
                    value: 0n
                }
            });
            const receipt = await tx.wait();
            const uid = getUIDFromReceipt(receipt); // Attested UID

            expect(await indexer.resolvePath(ZERO_BYTES32, "temp.txt")).to.equal(uid);

            // 2. Try Revoke - Should Revert because Schema is irrevocable (checked by EAS)
            // EAS logic: if schema.revocable is false, revoke() reverts with Irrevocable()
            await expect(eas.revoke({
                schema: anchorSchemaUID,
                data: {
                    uid: uid,
                    value: 0n
                }
            })).to.be.revertedWithCustomError(eas, "Irrevocable");
        });
    });

    describe("Tags (Crowd Sourcing)", function () {
        it("Should allow tagging with weight (int256)", async function () {
            // Create Anchor
            const schemaEncoder = new ethers.AbiCoder();
            const tx = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["tagged_file"]),
                    value: 0n
                }
            });
            const receipt = await tx.wait();
            const anchorUID = getUIDFromReceipt(receipt);

            // Forward Tag (Positive Weight)
            await eas.attest({
                schema: tagSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: anchorUID,
                    data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 100n]), // LabelUID generic, Weight 100
                    value: 0n
                }
            });

            // Rejection Tag (Negative Weight)
            await eas.attest({
                schema: tagSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: anchorUID,
                    data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, -50n]), // Weight -50
                    value: 0n
                }
            });

            // Verify via Generic Index
            const referencing = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false);
            expect(referencing.length).to.equal(2);

            // Verify Aggregated Weight
            // 100 - 50 = 50
            const weight = await indexer.getTagWeight(anchorUID, ethers.ZeroHash);
            expect(weight).to.equal(50n);
        });

        it("Should return the correct count of referencing attestations", async function () {
            const schemaEncoder = new ethers.AbiCoder();
            const tx = await eas.attest({
                schema: anchorSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: false,
                    refUID: ZERO_BYTES32,
                    data: schemaEncoder.encode(["string"], ["file_for_count"]),
                    value: 0n
                }
            });
            const receipt = await tx.wait();
            const anchorUID = getUIDFromReceipt(receipt);

            // Create a tag
            const tagTx = await eas.attest({
                schema: tagSchemaUID,
                data: {
                    recipient: ZeroAddress,
                    expirationTime: NO_EXPIRATION,
                    revocable: true,
                    refUID: anchorUID,
                    data: schemaEncoder.encode(["bytes32", "int256"], [ethers.ZeroHash, 10n]),
                    value: 0n
                }
            });
            const tagReceipt = await tagTx.wait();
            const tagUID = getUIDFromReceipt(tagReceipt);

            // Verify via Generic Index
            const attestations = await indexer.getReferencingAttestations(anchorUID, tagSchemaUID, 0, 10, false);
            expect(attestations.length).to.equal(1);
            expect(attestations[0]).to.equal(tagUID);

            const count = await indexer.getReferencingAttestationCount(anchorUID, tagSchemaUID);
            expect(count).to.equal(1);
        });
    });

});
