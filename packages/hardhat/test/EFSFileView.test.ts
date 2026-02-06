import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSFileView, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

describe("EFSFileView", function () {
  let indexer: EFSIndexer;
  let fileView: EFSFileView;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("SchemaRegistry");
    registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();

    const EASFactory = await ethers.getContractFactory("EAS");
    eas = await EASFactory.deploy(await registry.getAddress());
    await eas.waitForDeployment();

    const ownerAddr = await owner.getAddress();
    const nonce = await ethers.provider.getTransactionCount(ownerAddr);

    // Transactions: Registry, EAS, Anchor, Property, Data, Blob, Tag -> Indexer
    // Note: Empirical testing showed +5 offset (5 transactions consumed before Indexer).
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 5 });

    // Register Schemas
    const tx1 = await registry.register("string name", futureIndexerAddr, true);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1];

    // Property
    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    const rc2 = await tx2.wait();
    propertySchemaUID = rc2!.logs[0].topics[1];

    // Data
    const tx3 = await registry.register("bytes32 blobUID, string fileMode", futureIndexerAddr, true);
    const rc3 = await tx3.wait();
    dataSchemaUID = rc3!.logs[0].topics[1];

    // Blob (No resolver)
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    const rc4 = await tx4.wait();
    const blobSchemaUID = rc4!.logs[0].topics[1];

    // Tag
    const tx5 = await registry.register("bytes32 labelUID, int256 weight", futureIndexerAddr, true);
    const rc5 = await tx5.wait();
    const tagSchemaUID = rc5!.logs[0].topics[1];

    // Deploy Indexer
    const IndexerFactory = await ethers.getContractFactory("EFSIndexer");
    indexer = await IndexerFactory.deploy(
      await eas.getAddress(),
      anchorSchemaUID,
      propertySchemaUID,
      dataSchemaUID,
      blobSchemaUID,
      tagSchemaUID,
    );
    await indexer.waitForDeployment();

    expect(await indexer.getAddress()).to.equal(futureIndexerAddr);

    // Deploy FileView
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress());
    await fileView.waitForDeployment();
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
    console.log("Logs:", receipt.logs);
    throw new Error("Attested event not found in receipt");
  };

  it("Should fetch a directory page with correct metadata", async function () {
    const schemaEncoder = new ethers.AbiCoder();

    // 1. Create Root
    const rootData = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
    const txRoot = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: rootData,
        value: 0n,
      },
    });
    const rootReceipt = await txRoot.wait();
    const rootUID = getUIDFromReceipt(rootReceipt);

    // 2. Create "Folder" (Anchor with child)
    const folderData = schemaEncoder.encode(["string", "bytes32"], ["Docs", ZERO_BYTES32]);
    const txFolder = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: rootUID,
        data: folderData,
        value: 0n,
      },
    });
    const folderReceipt = await txFolder.wait();
    const folderUID = getUIDFromReceipt(folderReceipt);

    // Add child to Folder to make it a "Folder" (isFolder = true)
    const subData = schemaEncoder.encode(["string", "bytes32"], ["sub", ZERO_BYTES32]);
    await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: folderUID,
        data: subData,
        value: 0n,
      },
    });

    // 3. Create "File" (Anchor with Data)
    const fileData = schemaEncoder.encode(["string", "bytes32"], ["notes.txt", dataSchemaUID]);
    const txFile = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: rootUID,
        data: fileData,
        value: 0n,
      },
    });
    const fileReceipt = await txFile.wait();
    const fileUID = getUIDFromReceipt(fileReceipt);

    // Add Data to File to make it a "File" (hasData = true)
    const contentData = schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]);
    await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: fileUID,
        data: contentData,
        value: 0n,
      },
    });

    // 4. Test View
    const items = await fileView.getDirectoryPage(rootUID, 0, 10, dataSchemaUID, propertySchemaUID);

    expect(items.length).to.equal(2);

    // Reverse order: "notes.txt" should be first (newest), "Docs" second
    const item1 = items[0];
    const item2 = items[1];

    expect(item1.name).to.equal("notes.txt");
    expect(item1.isFolder).to.be.false; // eslint-disable-line @typescript-eslint/no-unused-expressions
    expect(item1.hasData).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions

    expect(item2.name).to.equal("Docs");
    expect(item2.isFolder).to.be.true; // eslint-disable-line @typescript-eslint/no-unused-expressions
    expect(item2.hasData).to.be.false; // eslint-disable-line @typescript-eslint/no-unused-expressions
  });
});
