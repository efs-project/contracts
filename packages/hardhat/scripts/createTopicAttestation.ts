import { ethers } from "hardhat";
import * as fs from "fs";

async function main() {
  const [signer] = await ethers.getSigners();
  
  // Get EAS contract
  const indexer = await ethers.getContract("Indexer") as any;
  const easAddress = await indexer.getEAS();
  const eas = await ethers.getContractAt("IEAS", easAddress);
  
  // Read schema UID from file
  let schemaUID;
  try {
    const schemaUids = fs.readFileSync("schema-uids.txt", "utf8");
    // Get the last non-empty line that starts with "Topic Schema:"
    const topicSchemaLines = schemaUids.split("\n")
      .filter(line => line.trim().startsWith("Topic Schema:") && line.trim().length > 12);
    
    if (topicSchemaLines.length > 0) {
      // Use the last entry
      const lastLine = topicSchemaLines[topicSchemaLines.length - 1];
      schemaUID = lastLine.split(": ")[1].trim();
      console.log("Found schema UID:", schemaUID);
    } else {
      throw new Error("Topic schema UID not found");
    }
  } catch (error) {
    console.error("Error reading schema UID:", error);
    process.exit(1);
  }
  
  // Create topic attestation
  const topicName = process.argv[2] || "Example Topic";
  const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [topicName]);
  
  console.log(`Creating attestation with schema ${schemaUID}`);
  console.log(`Topic name: ${topicName}`);
  
  try {
    const tx = await eas.attest({
      schema: schemaUID,
      data: {
        recipient: await signer.getAddress(), // Self-attestation in this example
        expirationTime: 0n, // No expiration
        revocable: true,
        refUID: "0x0000000000000000000000000000000000000000000000000000000000000000",
        data: encodedData,
        value: 0n
      }
    });
    
    console.log("Transaction sent:", tx.hash);
    
    const receipt = await tx.wait();
    console.log(`Attestation created successfully`);
    
    // Get the Attested event to find the UID
    if (receipt) {
      console.log("Receipt logs count:", receipt.logs.length);
      
      for (let i = 0; i < receipt.logs.length; i++) {
        console.log(`Log ${i}:`, {
          address: receipt.logs[i].address,
          topics: receipt.logs[i].topics,
          data: receipt.logs[i].data
        });
      }
      
      // Try to manually extract the UID from the first topic of the event
      // The UID should be the second topic (index 1) in the Attested event
      if (receipt.logs.length > 0 && receipt.logs[0].topics.length > 1) {
        const uid = receipt.logs[0].topics[1];
        console.log(`Attestation UID: ${uid}`);
      } else {
        console.log("Could not find UID in logs");
      }
    }
  } catch (error) {
    console.error("Failed to create attestation:", error);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
