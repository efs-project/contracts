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

    // Property (unified free-floating model per ADR-0035, non-revocable)
    const tx2 = await registry.register("string value", futureIndexerAddr, false);
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

  it("Folder visibility requires an explicit TAG — untagged folders with file-anchor children do NOT appear", async function () {
    // Post-refactor (ADR-0006 revised 2026-04-18): folder visibility is tag-only. A folder
    // does NOT appear in a schema-filtered listing just because it contains file-anchor
    // children; the attester must emit a TAG(definition=dataSchemaUID, refUID=folder)
    // to claim that folder in their edition. The client upload flow walks the ancestor
    // chain and emits any missing visibility TAGs.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const folderWithContentUID = await createAnchor("has-content", rootUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", folderWithContentUID, dataSchemaUID); // file anchor inside, but folder NOT tagged

    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const [items] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);

    expect(items.length).to.equal(0);
  });

  it("Empty folders appear when explicitly tagged with the schema UID", async function () {
    // A folder is visible in an edition iff it has an active applies=true TAG with
    // definition=dataSchemaUID by someone in the edition list.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);

    const emptyTaggedUID = await createAnchor("empty-tagged", rootUID, ZERO_BYTES32);
    await createTag(emptyTaggedUID, dataSchemaUID, true);

    await createAnchor("empty-untagged", rootUID, ZERO_BYTES32);

    const [items] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);

    expect(items.length).to.equal(1);
    expect(items[0].name).to.equal("empty-tagged");
  });

  it("Ancestor-chain visibility: only folders explicitly tagged appear, regardless of nested contents", async function () {
    // root → /photos/ → /cats/ → cat.jpg (file anchor, with /photos/ and /cats/ explicitly tagged)
    // In the tag-only model the client walks the ancestor chain on upload and emits a
    // visibility TAG at every ancestor. A folder with no TAG never appears even if deeply
    // nested content exists beneath it.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const photosUID = await createAnchor("photos", rootUID, ZERO_BYTES32);
    const catsUID = await createAnchor("cats", photosUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", catsUID, dataSchemaUID);

    // Simulate client ancestor-walk: tag every ancestor folder up to (but excluding) root.
    await createTag(catsUID, dataSchemaUID, true);
    await createTag(photosUID, dataSchemaUID, true);

    const [rootItems] = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(rootItems.length).to.equal(1);
    expect(rootItems[0].name).to.equal("photos");

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

  it("Untagged ancestor is invisible even when a deeper descendant is tagged and populated", async function () {
    // If the client skipped one ancestor in the walk, that ancestor is invisible.
    // This is the intended property: folder visibility follows TAG, not content.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const photosUID = await createAnchor("photos", rootUID, ZERO_BYTES32); // NOT tagged
    const catsUID = await createAnchor("cats", photosUID, ZERO_BYTES32);
    await createAnchor("cat.jpg", catsUID, dataSchemaUID);
    await createTag(catsUID, dataSchemaUID, true);

    const [rootItems] = await fileView.getDirectoryPageBySchemaAndAddressList(
      rootUID,
      dataSchemaUID,
      [ownerAddr],
      0,
      10,
    );
    expect(rootItems.length).to.equal(0);
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

  it("Should not return a tagged folder after its tag is revoked via EAS multiRevoke", async function () {
    // Regression: the client-driven folder delete flow issues EAS multiRevoke on the
    // visibility TAG rather than attesting applies=false. This must produce the same
    // outcome — folder disappears from the edition listing.
    const ownerAddr = await owner.getAddress();

    const rootUID = await createAnchor("root", ZERO_BYTES32, ZERO_BYTES32);
    const folderUID = await createAnchor("my-folder", rootUID, ZERO_BYTES32);

    const visTagUID = await createTag(folderUID, dataSchemaUID, true);

    const [before] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(before.length).to.equal(1);

    await eas.multiRevoke([{ schema: tagSchemaUID, data: [{ uid: visTagUID, value: 0n }] }]);

    const [after] = await fileView.getDirectoryPageBySchemaAndAddressList(rootUID, dataSchemaUID, [ownerAddr], 0, 10);
    expect(after.length).to.equal(0);
  });
});
