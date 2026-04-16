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

  it("Should return only explicitly-tagged folders in schema-filtered views", async function () {
    // Regression / design test: _getQualifyingTaggedFolders no longer scans all generic
    // folders (O(N_total)). Only folders explicitly tagged with the target schema UID appear.
    // Untagged folders that happen to contain schema-matching children are NOT returned —
    // developers must tag folders to opt them into schema-filtered listings.

    const ownerAddr = await owner.getAddress();

    // 1. Create root
    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    // 2. Create tagged folders — each is tagged with definition=dataSchemaUID via TagResolver
    const TAGGED_COUNT = 5;
    const taggedNames: string[] = [];
    for (let i = 0; i < TAGGED_COUNT; i++) {
      const name = `tagged-${i}`;
      taggedNames.push(name);
      const folderUID = await createAnchor(name, rootUID, ZERO_BYTES32);
      await createTag(folderUID, dataSchemaUID, true);
    }

    // 3. Create untagged folders — generic folders with no TAG attestation
    for (let i = 0; i < 3; i++) {
      await createAnchor(`untagged-${i}`, rootUID, ZERO_BYTES32);
    }

    // 4. Query schema-filtered directory
    const [items] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 20);

    // Only tagged folders qualify — untagged ones are absent
    expect(items.length).to.equal(TAGGED_COUNT);

    const returnedNames = new Set(items.map((i: any) => i.name));
    for (const name of taggedNames) {
      expect(returnedNames.has(name), `missing tagged folder: ${name}`).to.equal(true);
    }
    for (let i = 0; i < 3; i++) {
      expect(returnedNames.has(`untagged-${i}`), `untagged folder should not appear`).to.equal(false);
    }
  });

  it("Should not return a tagged folder after its tag is set to applies=false", async function () {
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("my-folder", rootUID, ZERO_BYTES32);

    // Tag the folder
    await createTag(folderUID, dataSchemaUID, true);

    const [before] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(before.length).to.equal(1);
    expect(before[0].name).to.equal("my-folder");

    // Untag the folder
    await createTag(folderUID, dataSchemaUID, false);

    const [after] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(after.length).to.equal(0);
  });
});
