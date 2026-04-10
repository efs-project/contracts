import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EFSFileView, EAS, SchemaRegistry, TagResolver } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_EXPIRATION = 0n;

describe("EFSFileView", function () {
  let indexer: EFSIndexer;
  let fileView: EFSFileView;
  let tagResolver: TagResolver;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;

  let anchorSchemaUID: string;
  let dataSchemaUID: string;
  let propertySchemaUID: string;
  let tagSchemaUID: string;

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

    // Deploy order:
    //   nonce+0: TagResolver
    //   nonce+1..4: Anchor, Property, Data, Blob schema registrations
    //   nonce+5: TAG schema registration
    //   nonce+6: Indexer
    const futureTagResolverAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce });
    const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 6 });
    const precomputedTagSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 definition, bool applies", futureTagResolverAddr, true],
    );

    // Deploy TagResolver first
    const TagResolverFactory = await ethers.getContractFactory("TagResolver");
    tagResolver = await TagResolverFactory.deploy(
      await eas.getAddress(),
      precomputedTagSchemaUID,
      futureIndexerAddr,
      await registry.getAddress(),
    );
    await tagResolver.waitForDeployment();

    // Register Schemas (aligned with canonical EFSIndexer and EFSRouter schemas)
    const tx1 = await registry.register("string name, bytes32 schemaUID", futureIndexerAddr, true);
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1];

    // Property
    const tx2 = await registry.register("string key, string value", futureIndexerAddr, true);
    const rc2 = await tx2.wait();
    propertySchemaUID = rc2!.logs[0].topics[1];

    // Data (aligned with EFSRouter: string uri, string contentType, string fileMode)
    const tx3 = await registry.register("string uri, string contentType, string fileMode", futureIndexerAddr, true);
    const rc3 = await tx3.wait();
    dataSchemaUID = rc3!.logs[0].topics[1];

    // Blob (No resolver)
    const tx4 = await registry.register("string mimeType, uint8 storageType, bytes location", ZeroAddress, true);
    const rc4 = await tx4.wait();
    const blobSchemaUID = rc4!.logs[0].topics[1];

    // TAG schema
    const tx5 = await registry.register("bytes32 definition, bool applies", futureTagResolverAddr, true);
    const rc5 = await tx5.wait();
    tagSchemaUID = rc5!.logs[0].topics[1];

    // Deploy Indexer
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

    // Deploy FileView (with TagResolver)
    const FileViewFactory = await ethers.getContractFactory("EFSFileView");
    fileView = await FileViewFactory.deploy(await indexer.getAddress(), await tagResolver.getAddress());
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
      } catch {}
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
    // Aligned with canonical DATA schema: string uri, string contentType, string fileMode
    const contentData = schemaEncoder.encode(["string", "string", "string"], ["web3://0x0000", "text/plain", "file"]);
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

  it("Should show empty generic folders tagged with the requested schema", async function () {
    const schemaEncoder = new ethers.AbiCoder();
    const ownerAddr = await owner.getAddress();

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
        value: 0,
      },
    });
    const rootUID = getUIDFromReceipt(await txRoot.wait());

    // 2. Create a file anchor with DATA under root (so root has content)
    const fileData = schemaEncoder.encode(["string", "bytes32"], ["photo.jpg", dataSchemaUID]);
    const txFile = await eas.attest({
      schema: anchorSchemaUID,
      data: { recipient: ZeroAddress, expirationTime: 0, revocable: false, refUID: rootUID, data: fileData, value: 0 },
    });
    const fileUID = getUIDFromReceipt(await txFile.wait());

    // Attach DATA to the file anchor
    const dataPayload = schemaEncoder.encode(
      ["string", "string", "string"],
      ["web3://photo-data", "image/jpeg", "file"],
    );
    await eas.attest({
      schema: dataSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0,
        revocable: true,
        refUID: fileUID,
        data: dataPayload,
        value: 0,
      },
    });

    // 3. Create an empty generic folder under root (no children, no data)
    const folderData = schemaEncoder.encode(["string", "bytes32"], ["EmptyFolder", ZERO_BYTES32]);
    const txFolder = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: rootUID,
        data: folderData,
        value: 0,
      },
    });
    const emptyFolderUID = getUIDFromReceipt(await txFolder.wait());

    // 4. Without tagging, getDirectoryPageBySchemaAndAddressList should NOT show the empty folder
    const [itemsBefore] = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(itemsBefore.length).to.equal(1); // only the file anchor
    expect(itemsBefore[0].name).to.equal("photo.jpg");

    // 5. Tag the empty folder with dataSchemaUID as the definition
    const tagData = schemaEncoder.encode(["bytes32", "bool"], [dataSchemaUID, true]);
    await eas.attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: 0,
        revocable: true,
        refUID: emptyFolderUID,
        data: tagData,
        value: 0,
      },
    });

    // 6. Now getDirectoryPageBySchemaAndAddressList SHOULD show the empty folder
    const [itemsAfter] = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(itemsAfter.length).to.equal(2); // file anchor + tagged empty folder
    const names = itemsAfter.map((i: any) => i.name);
    expect(names).to.include("photo.jpg");
    expect(names).to.include("EmptyFolder");

    // The empty folder should be recognized as a folder (no children yet but it's generic)
    const emptyFolderItem = itemsAfter.find((i: any) => i.name === "EmptyFolder");
    expect(emptyFolderItem).to.not.be.undefined;
    expect(emptyFolderItem!.schema).to.equal(ZERO_BYTES32); // generic anchor
  });
});
