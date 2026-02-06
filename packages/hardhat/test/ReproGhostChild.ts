import { expect } from "chai";
import { ethers } from "hardhat";
import { EFSIndexer, EAS, SchemaRegistry } from "../typechain-types";
import { Signer, ZeroAddress } from "ethers";

// Constants
const NO_EXPIRATION = 0n;
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("EFSIndexer Ghost Child Repro", function () {
  let indexer: EFSIndexer;
  let eas: EAS;
  let registry: SchemaRegistry;
  let owner: Signer;

  let anchorSchemaUID: string;
  // We only need Anchor schema for this repro
  const propertySchemaUID = ZERO_BYTES32;
  const dataSchemaUID = ZERO_BYTES32;
  const blobSchemaUID = ZERO_BYTES32;
  const tagSchemaUID = ZERO_BYTES32;

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

    const ownerAddr = await owner.getAddress();
    // const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    // const futureIndexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: nonce + 2 }); // Registry + EAS deployed, next is registers... wait

    // Actually simpler: Deploy Indexer first? No, need UIDs.
    // Let's just follow the pattern but assume we get the address right.
    // We register 1 schema.
    // Registry is deployed (nonce), EAS is deployed (nonce+1).
    // Register tx is nonce+2.
    // Indexer deploy is nonce+3.

    // Wait, the previous test did nonce + 7 because of many schemas.
    // checking:
    // 1. Registry deploy
    // 2. EAS deploy
    // ... calculation ...

    // Let's just USE a placeholder resolver first, then deployment? No, schema needs resolver.
    // Let's use the same calculation method.
    // Current nonce is for next tx.
    // Txs:
    // 1. Register Anchor (nonce)
    // 2. Deploy Indexer (nonce + 1)

    const currentNonce = await ethers.provider.getTransactionCount(ownerAddr);
    const indexerAddr = ethers.getCreateAddress({ from: ownerAddr, nonce: currentNonce + 1 });

    const tx1 = await registry.register("string name", indexerAddr, true); // Revocable!
    const rc1 = await tx1.wait();
    anchorSchemaUID = rc1!.logs[0].topics[1];

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

    expect(await indexer.getAddress()).to.equal(indexerAddr);
  });

  const getUIDFromReceipt = (receipt: any) => {
    const easInterface = eas.interface;
    for (const log of receipt.logs) {
      try {
        const parsed = easInterface.parseLog(log);
        if (parsed && parsed.name === "Attested") {
          return parsed.args.uid;
        }
      } catch {
        // ignore
      }
    }
    throw new Error("Attested event not found");
  };

  it("Should show ghost children after revocation", async function () {
    const schemaEncoder = new ethers.AbiCoder();

    // 1. Create Root
    const data = schemaEncoder.encode(["string", "bytes32"], ["root", ZERO_BYTES32]);
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: ZERO_BYTES32,
        data: data,
        value: 0n,
      },
    });
    const receipt = await tx.wait();
    const rootUID = getUIDFromReceipt(receipt);

    // 2. Create Child "file.txt"
    const childData = schemaEncoder.encode(["string", "bytes32"], ["file.txt", ZERO_BYTES32]);
    const tx2 = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: rootUID,
        data: childData,
        value: 0n,
      },
    });
    const receipt2 = await tx2.wait();
    const childUID = getUIDFromReceipt(receipt2);

    // Verify it's there
    expect(await indexer.resolvePath(rootUID, "file.txt")).to.equal(childUID);
    let children = await indexer.getChildren(rootUID, 0, 10, false);
    expect(children).to.include(childUID);
    expect(children.length).to.equal(1);

    // 3. Revoke Child
    await eas.revoke({
      schema: anchorSchemaUID,
      data: { uid: childUID, value: 0n },
    });

    // Verify path resolution is gone
    expect(await indexer.resolvePath(rootUID, "file.txt")).to.equal(ZERO_BYTES32);

    // 4. Create NEW "file.txt"
    const tx3 = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: rootUID,
        data: childData,
        value: 0n,
      },
    });
    const receipt3 = await tx3.wait();
    const newChildUID = getUIDFromReceipt(receipt3);

    // Verify path resolution points to NEW UID
    expect(await indexer.resolvePath(rootUID, "file.txt")).to.equal(newChildUID);

    // 5. Check Children List - EXPECT BUG
    children = await indexer.getChildren(rootUID, 0, 10, false);
    console.log("Children UIDs:", children);

    // If bug is fixed, length should be 1 (only the new one)
    expect(children.length).to.equal(1);
    expect(children).to.include(newChildUID);
    expect(children).to.not.include(childUID); // Revoked one should be gone
  });

  it("Should show ghost references after revocation", async function () {
    const schemaEncoder = new ethers.AbiCoder();

    // 1. Create Anchor
    const data = schemaEncoder.encode(["string", "bytes32"], ["ref_target", ZERO_BYTES32]);
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: false,
        refUID: ZERO_BYTES32,
        data: data,
        value: 0n,
      },
    });
    const receipt = await tx.wait();
    const anchorUID = getUIDFromReceipt(receipt);

    // 2. Create Tag (Tag Schema is not registered in this shortened test, let's register it or use Anchor as a fake tag)
    // We need a schema that goes to "generic logic".
    // Let's quickly register a "Like" schema.

    // const ownerAddr = await owner.getAddress();
    // const nonce = await ethers.provider.getTransactionCount(ownerAddr);
    // Note: Global registry is shared? No, deployed in beforeEach.
    // We need to register a new schema pointing to our indexer.
    const txR = await registry.register("bytes32 target", await indexer.getAddress(), true);
    const rcR = await txR.wait();
    const likeSchemaUID = rcR!.logs[0].topics[1];

    // 3. Like the Anchor
    const likeData = schemaEncoder.encode(["bytes32"], [anchorUID]);
    const txLike = await eas.attest({
      schema: likeSchemaUID,
      data: {
        recipient: ZeroAddress,
        expirationTime: NO_EXPIRATION,
        revocable: true,
        refUID: anchorUID,
        data: likeData,
        value: 0n,
      },
    });
    const rcLike = await txLike.wait();
    const likeUID = getUIDFromReceipt(rcLike);

    // Verify Reference
    let refs = await indexer.getReferencingAttestations(anchorUID, likeSchemaUID, 0, 10, false);
    expect(refs).to.include(likeUID);
    expect(refs.length).to.equal(1);

    // 4. Revoke Like
    await eas.revoke({
      schema: likeSchemaUID,
      data: { uid: likeUID, value: 0n },
    });

    // 5. Check References - EXPECT BUG (Ghost Reference)
    refs = await indexer.getReferencingAttestations(anchorUID, likeSchemaUID, 0, 10, false);
    console.log("Refs:", refs);
    expect(refs.length).to.equal(0); // Should be gone!
    expect(refs).to.not.include(likeUID);
  });
});
