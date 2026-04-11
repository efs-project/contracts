/**
 * EFS Seed Script
 *
 * Creates a small realistic file tree for manual UI testing:
 *
 *   /docs/
 *     readme.txt  (owner DATA: "Hello from EFS!")
 *     notes.txt   (owner DATA: "Some notes")
 *   /images/
 *     cat.jpg     (owner DATA)
 *     dog.jpg     (owner DATA)
 *   /shared/
 *     photo.png   (owner + user1 DATA — editions demo)
 *
 * Run: npx hardhat run scripts/seed.ts --network localhost
 *      (or: yarn hardhat:seed)
 */

import { ethers, getNamedAccounts } from "hardhat";
import { EFSIndexer } from "../typechain-types";

async function main() {
  const { deployer } = await getNamedAccounts();
  const deployerSigner = await ethers.getSigner(deployer);
  const [, user1] = await ethers.getSigners();

  console.log("═══════════════════════════════════════");
  console.log("  EFS Seed Script");
  console.log("═══════════════════════════════════════\n");
  console.log(`Deployer: ${deployer}`);
  console.log(`User1:    ${await user1.getAddress()}\n`);

  // ── Connect to contracts ─────────────────────────────────────────────────────

  const indexer = (await ethers.getContract("Indexer", deployerSigner)) as unknown as EFSIndexer;
  const easAddr = await indexer.getEAS();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eas = (await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    easAddr,
  )) as any;

  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();
  const rootUID = await indexer.rootAnchorUID();
  const encode = ethers.AbiCoder.defaultAbiCoder();

  console.log(`Indexer:  ${indexer.target}`);
  console.log(`Root:     ${rootUID}\n`);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  const getUID = async (tx: any): Promise<string> => {
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid as string;
      } catch {}
    }
    throw new Error("Attested event not found in receipt");
  };

  // Create an ANCHOR attestation. schema=ZeroHash → generic folder.
  // schema=dataSchemaUID → file slot (will hold DATA attestations).
  const makeAnchor = async (
    signer: any,
    name: string,
    parentUID: string,
    schema: string = ethers.ZeroHash,
  ): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: false,
        refUID: parentUID,
        data: encode.encode(["string", "bytes32"], [name, schema]),
        value: 0n,
      },
    });
    const uid = await getUID(tx);
    console.log(`  Anchor  "${name}"  ${uid.slice(0, 10)}…`);
    return uid;
  };

  // Attach a DATA attestation to an anchor (file content pointer).
  const makeData = async (signer: any, anchorUID: string, uri: string, contentType: string): Promise<string> => {
    const tx = await eas.connect(signer).attest({
      schema: dataSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0n,
        revocable: true,
        refUID: anchorUID,
        data: encode.encode(["string", "string", "string"], [uri, contentType, "file"]),
        value: 0n,
      },
    });
    const uid = await getUID(tx);
    console.log(`  Data    ${uid.slice(0, 10)}…  →  ${uri}`);
    return uid;
  };

  // ── Build tree ────────────────────────────────────────────────────────────────

  console.log("── /docs/ ──");
  const docsUID = await makeAnchor(deployerSigner, "docs", rootUID);
  const readmeUID = await makeAnchor(deployerSigner, "readme.txt", docsUID, dataSchemaUID);
  await makeData(deployerSigner, readmeUID, "data:text/plain,Hello%20from%20EFS!", "text/plain");
  const notesUID = await makeAnchor(deployerSigner, "notes.txt", docsUID, dataSchemaUID);
  await makeData(deployerSigner, notesUID, "data:text/plain,Some%20notes", "text/plain");

  console.log("\n── /images/ ──");
  const imagesUID = await makeAnchor(deployerSigner, "images", rootUID);
  const catUID = await makeAnchor(deployerSigner, "cat.jpg", imagesUID, dataSchemaUID);
  await makeData(deployerSigner, catUID, "https://placecats.com/300/200", "image/jpeg");
  const dogUID = await makeAnchor(deployerSigner, "dog.jpg", imagesUID, dataSchemaUID);
  await makeData(deployerSigner, dogUID, "https://placedog.net/300/200", "image/jpeg");

  console.log("\n── /shared/ (editions demo) ──");
  const sharedUID = await makeAnchor(deployerSigner, "shared", rootUID);
  const photoUID = await makeAnchor(deployerSigner, "photo.png", sharedUID, dataSchemaUID);
  await makeData(deployerSigner, photoUID, "ipfs://owner-version-of-photo", "image/png");
  await makeData(user1, photoUID, "ipfs://user1-version-of-photo", "image/png");

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════");
  console.log("  Seeding complete!");
  console.log(`  docs/     ${docsUID.slice(0, 14)}…`);
  console.log(`  images/   ${imagesUID.slice(0, 14)}…`);
  console.log(`  shared/   ${sharedUID.slice(0, 14)}…`);
  console.log("═══════════════════════════════════════\n");
  console.log("Tip: open the explorer at http://localhost:3000/explorer");
  console.log("     to browse the seeded data.\n");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
