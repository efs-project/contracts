import { ethers, getNamedAccounts } from "hardhat";

import { EFSIndexer } from "../typechain-types";

async function main() {
  const { deployer } = await getNamedAccounts();
  const signer = await ethers.getSigner(deployer);
  console.log("Seeding data with account:", deployer);

  // Get Contracts
  const indexer = (await ethers.getContract("Indexer", signer)) as unknown as EFSIndexer;
  const easAddr = await indexer.getEAS();
  const eas = await ethers.getContractAt("IEAS", easAddr, signer);

  // Get Schema UIDs values from Indexer
  // We can't get them directly if they are immutable private/internal?
  // They are public immutable? Step 63: "bytes32 public immutable ANCHOR_SCHEMA_UID;"
  // Yes, they are public.

  const anchorSchema = await indexer.ANCHOR_SCHEMA_UID();
  const dataSchema = await indexer.DATA_SCHEMA_UID();
  // const propertySchema = await indexer.PROPERTY_SCHEMA_UID();

  // 1. Get Root
  const rootUID = await indexer.rootAnchorUID();
  console.log("Root UID:", rootUID);

  // 2. Create "Documents" Folder
  console.log("Creating 'Documents' folder...");
  const folderData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Documents"]);
  const txFolder = await eas.attest({
    schema: anchorSchema,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0,
      revocable: false,
      refUID: rootUID,
      data: folderData,
      value: 0,
    },
  });
  await txFolder.wait();
  // Get UID from events? Or Indexer?
  // EAS emits Attested(recipient, attester, uid, schemaUID)
  // We can just fetch children of Root.

  // Helper to get UID from receipt
  /*
    const getUID = (rc: any) => {
        const event = rc.logs.find((log: any) => log.fragment && log.fragment.name === 'Attested');
        return event ? event.args.uid : null;
    };
    */
  // Assuming last child of root is our folder
  const children1 = await indexer.getChildren(rootUID, 0, 10, true);
  const docsUID = children1[0];
  console.log("Documents Folder UID:", docsUID);

  // 3. Create "Notes.txt" File in Documents
  console.log("Creating 'Notes.txt'...");
  const fileData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Notes.txt"]);
  const txFile = await eas.attest({
    schema: anchorSchema,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0,
      revocable: false,
      refUID: docsUID,
      data: fileData,
      value: 0,
    },
  });
  await txFile.wait();

  const children2 = await indexer.getChildren(docsUID, 0, 10, true);
  const notesUID = children2[0];
  console.log("Notes.txt UID:", notesUID);

  // 4. Add Content to Notes.txt
  console.log("Adding content to Notes.txt...");
  // const content = "Hello World! This is a seeded file.";
  const contentEncoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "string"],
    [ethers.ZeroHash, "text/plain"],
  );
  // Wait, DATA schema is: "bytes32 blobUID, string fileMode" (based on 01_indexer.ts)
  // In 01_indexer.ts line 40: { name: "DATA", definition: "bytes32 blobUID, string fileMode" ... }

  // Wait. My tests used "bytes32 blobUID, string fileMode" in EFSIndexer.test.ts?
  // In EFSFileView.test.ts I used:
  // const contentData = schemaEncoder.encode(["bytes32", "string"], [ZERO_BYTES32, "0644"]);

  // Ah, logic:
  // BLOB schema has content? "string mimeType, uint8 storageType, bytes location"

  // If I want "Hello World", I should create a BLOB attestation First?
  // Or just store it in Data?
  // The design seems to be:
  // - BLOB attestation holds location/content metadata.
  // - DATA attestation links Anchor -> Blob + properties?

  // But for a simple file, maybe I want the content?
  // User plan said: "EFSFileView... Hydrates with EAS data"
  // "Interpret this data as a file system."

  // For now, I will use a placeholder Blob UID (ZeroHash) and "text/plain" as fileMode/mimeType?
  // 01_indexer definition: blobUID, fileMode.

  const dataTx = await eas.attest({
    schema: dataSchema,
    data: {
      recipient: ethers.ZeroAddress,
      expirationTime: 0,
      revocable: true,
      refUID: notesUID,
      data: contentEncoded,
      value: 0,
    },
  });
  await dataTx.wait();
  console.log("Added Data to Notes.txt");

  console.log("Seeding Complete!");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
