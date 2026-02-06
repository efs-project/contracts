import { ethers, deployments } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("Testing schemas with signer:", signer.address);

  // 1. Get Contract Addresses and UIDs
  const indexerDeployment = await deployments.get("Indexer");
  const indexerAddress = indexerDeployment.address;
  console.log("Indexer Address:", indexerAddress);

  const indexer = await ethers.getContractAt("Indexer", indexerAddress);
  const easAddress = await indexer.getEAS();
  console.log("EAS Address:", easAddress);

  const eas = await ethers.getContractAt("IEAS", easAddress);

  // Parse schema-uids.txt
  const schemaFile = path.resolve(__dirname, "../schema-uids.txt");
  const schemaContent = fs.readFileSync(schemaFile, "utf8");
  const schemaLines = schemaContent.split("\n");

  const SCHEMA_UIDS: Record<string, string> = {};

  schemaLines.forEach(line => {
    const match = line.match(/^(\w+) Schema: (0x[a-fA-F0-9]{64})/);
    if (match) {
      SCHEMA_UIDS[match[1]] = match[2];
    }
  });

  console.log("Loaded Schemas:", SCHEMA_UIDS);

  // 2. Resolve Root Topic UID (needed for refs)
  // We can get it from the TopicResolver
  const topicResolverDeployment = await deployments.get("TopicResolver");
  const topicResolver = await ethers.getContractAt("TopicResolver", topicResolverDeployment.address);
  const rootTopicUID = await topicResolver.rootTopicUid();
  console.log("Root Topic UID:", rootTopicUID);

  // 3. Validation Logic

  // Validate TAG Schema
  // Definition: "bytes32 definition"
  if (SCHEMA_UIDS["TAG"]) {
    console.log("\n--- Testing TAG Schema ---");
    try {
      const tagData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [ethers.hexlify(ethers.randomBytes(32))]);

      const tx = await eas.attest({
        schema: SCHEMA_UIDS["TAG"],
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: rootTopicUID,
          data: tagData,
          value: 0,
        },
      });
      const receipt = await tx.wait();
      console.log("✅ TAG attestation successful! Hash:", receipt?.hash);
    } catch (e) {
      console.error("❌ TAG attestation failed:", e);
    }
  } else {
    console.error("⚠️ TAG Schema UID not found");
  }

  // Validate PROPERTY Schema
  // Definition: "string value"
  if (SCHEMA_UIDS["PROPERTY"]) {
    console.log("\n--- Testing PROPERTY Schema ---");
    try {
      const propData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Testing Property Value"]);

      const tx = await eas.attest({
        schema: SCHEMA_UIDS["PROPERTY"],
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: rootTopicUID,
          data: propData,
          value: 0,
        },
      });
      const receipt = await tx.wait();
      console.log("✅ PROPERTY attestation successful! Hash:", receipt?.hash);
    } catch (e) {
      console.error("❌ PROPERTY attestation failed:", e);
    }
  }

  // Validate FILE Schema
  // Definition: "uint8 type, string data"
  if (SCHEMA_UIDS["FILE"]) {
    console.log("\n--- Testing FILE Schema ---");
    try {
      const fileData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint8", "string"],
        [1, "https://ipfs.io/ipfs/QmExample"],
      );

      const tx = await eas.attest({
        schema: SCHEMA_UIDS["FILE"],
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: rootTopicUID,
          data: fileData,
          value: 0,
        },
      });
      const receipt = await tx.wait();
      console.log("✅ FILE attestation successful! Hash:", receipt?.hash);
    } catch (e) {
      console.error("❌ FILE attestation failed:", e);
    }
  }

  // Validate BLOB Schema
  // Definition: "bytes data, string contentType"
  if (SCHEMA_UIDS["BLOB"]) {
    console.log("\n--- Testing BLOB Schema ---");
    try {
      const blobData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes", "string"],
        [ethers.toUtf8Bytes("<html>Hello World</html>"), "text/html"],
      );

      const tx = await eas.attest({
        schema: SCHEMA_UIDS["BLOB"],
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: true,
          refUID: ethers.ZeroHash,
          data: blobData,
          value: 0,
        },
      });
      const receipt = await tx.wait();
      console.log("✅ BLOB attestation successful! Hash:", receipt?.hash);
    } catch (e) {
      console.error("❌ BLOB attestation failed:", e);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
