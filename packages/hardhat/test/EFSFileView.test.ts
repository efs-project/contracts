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

    // Data (non-revocable, content-addressed — matches EFSIndexer DATA_SCHEMA_UID)
    const tx3 = await registry.register("bytes32 contentHash, uint64 size", futureIndexerAddr, false);
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

  const enc = new ethers.AbiCoder();

  /** Create an anchor under parentUID with the given name and schema type. */
  const createAnchor = async (name: string, parentUID: string, schema: string): Promise<string> => {
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: parentUID,
        data: enc.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    return getUIDFromReceipt(await tx.wait());
  };

  /** Create a TAG attestation (goes through TagResolver). */
  const createTag = async (targetUID: string, definition: string, applies: boolean): Promise<string> => {
    const tx = await eas.attest({
      schema: tagSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: targetUID,
        data: enc.encode(["bytes32", "bool"], [definition, applies]),
        value: 0n,
      },
    });
    return getUIDFromReceipt(await tx.wait());
  };

  it("Source A: folders with file-anchor children appear without explicit tagging", async function () {
    // A generic subfolder qualifies in schema-filtered listings if it organically acquired
    // children of the target schema (file Anchors with schemaUID=dataSchemaUID). No TAG needed.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    // Create a generic folder containing a file anchor — qualifies via source A
    const folderWithContentUID = await createAnchor("has-content", rootUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", folderWithContentUID, dataSchemaUID); // file anchor inside

    // Create a generic folder with no children — should NOT appear
    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const [items] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);

    expect(items.length).to.equal(1);
    expect(items[0].name).to.equal("has-content");
  });

  it("Source B: empty folders appear when explicitly tagged with the schema UID", async function () {
    // Empty generic folders are invisible to source A (no children), but they appear via
    // source B if explicitly tagged with definition=dataSchemaUID via TagResolver.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const emptyTaggedUID = await createAnchor("empty-tagged", rootUID, ZERO_BYTES32);
    await createTag(emptyTaggedUID, dataSchemaUID, true);

    // An empty folder with no tag — should NOT appear
    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const [items] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);

    expect(items.length).to.equal(1);
    expect(items[0].name).to.equal("empty-tagged");
  });

  it("Source A (deep): grandparent folder appears without explicit tagging when a nested file-anchor exists", async function () {
    // root → /photos/ → /cats/ → cat.jpg (file anchor)
    // Listing root with dataSchemaUID should return /photos/ even though the file is 2 hops down.
    // Without the ancestor-chain walk this was a navigation-breaking bug — only /cats/ appeared
    // when listing /photos/, but /photos/ never appeared when listing root.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const photosUID = await createAnchor("photos", rootUID, ZERO_BYTES32);
    const catsUID = await createAnchor("cats", photosUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", catsUID, dataSchemaUID);

    // Root level: /photos/ must appear
    const [rootItems] = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(rootItems.length).to.equal(1);
    expect(rootItems[0].name).to.equal("photos");

    // /photos/ level: /cats/ must appear
    const [photosItems] = await fileView.getDirectoryPageBySchemaAndAddressList(
      photosUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(photosItems.length).to.equal(1);
    expect(photosItems[0].name).to.equal("cats");
  });

  it("Should not return a tagged folder after its tag is set to applies=false", async function () {
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("my-folder", rootUID, ZERO_BYTES32);

    await createTag(folderUID, dataSchemaUID, true);

    const [before] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(before.length).to.equal(1);
    expect(before[0].name).to.equal("my-folder");

    await createTag(folderUID, dataSchemaUID, false);

    const [after] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(after.length).to.equal(0);
  });
});
