import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract, Signer } from "ethers";

/**
 * Deploys the TopicResolver and registers the Topic schema
 * @param hre HardhatRuntimeEnvironment object
 */
const deployTopicSchema: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;

  // Get EAS address from the Indexer contract
  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  const easAddress = await indexer.getEAS();
  
  console.log("EAS address:", easAddress);

  // Deploy the TopicResolver contract
  const TopicResolver = await deploy("TopicResolver", {
    from: deployer,
    args: [easAddress],
    log: true,
    autoMine: true,
  });

  console.log("TopicResolver deployed at:", TopicResolver.address);

  // Get the contracts we need
  const eas = await hre.ethers.getContractAt("IEAS", easAddress);
  const deployerSigner = await hre.ethers.getSigner(deployer);

  // Get SchemaRegistry address from EAS
  const schemaRegistryAddress = await eas.getSchemaRegistry();
  const schemaRegistry = await hre.ethers.getContractAt("ISchemaRegistry", schemaRegistryAddress);

  // Define the schema
  const schemaDefinition = "string name";
  const revocable = false;
  
  // Generate schema UID - using the same algorithm as the contracts use
  const schemaUID = hre.ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [schemaDefinition, TopicResolver.address, revocable]
  );
  
  console.log("Calculated Topic schema UID:", schemaUID);
   // Store the schema UID in a file for later reference
  // We check if this UID already exists as the last entry to avoid duplicates
  
  // Check if the file exists and read its contents
  const fs = require("fs");
  const path = "schema-uids.txt";
  let shouldWriteUID = true;
  let schemaExists = false;
  
  try {
    if (fs.existsSync(path)) {
      const fileContent = fs.readFileSync(path, 'utf8');
      const lines = fileContent.split('\n');
      
      // Find the last non-empty line that starts with "Topic Schema:"
      const topicSchemaLines = lines
        .filter((line: string) => line.trim().startsWith("Topic Schema:") && line.trim().length > 12);
      
      if (topicSchemaLines.length > 0) {
        // Get the UID from the last entry
        const lastLine = topicSchemaLines[topicSchemaLines.length - 1];
        const lastUID = lastLine.split(": ")[1].trim();
        
        // Check if the new UID is the same as the last one
        if (lastUID === schemaUID) {
          console.log("Schema UID already exists as the last entry. Skipping write.");
          shouldWriteUID = false;
          schemaExists = true;
        }
      }
    }
  } catch (error) {
    console.error("Error checking schema-uids.txt:", error);
  }
  
  // Check if the schema already exists in the registry
  if (!schemaExists) {
    try {
      const existingSchema = await schemaRegistry.getSchema(schemaUID);
      if (existingSchema && existingSchema.uid === schemaUID) {
        console.log("Schema already registered with UID:", schemaUID);
        schemaExists = true;
      }
    } catch (error) {
      console.log("Schema not found in registry, will register it");
    }
  }

  // Register the schema if it doesn't exist
  if (!schemaExists) {
    console.log("Registering schema:", schemaDefinition);
    try {
      const tx = await schemaRegistry.connect(deployerSigner).register(
        schemaDefinition,
        TopicResolver.address,
        revocable
      );
      const receipt = await tx.wait();
      if (receipt) {
        console.log("Schema registered successfully. Transaction hash:", receipt.hash);
      }
    } catch (error) {
      console.error("Error registering schema:", error);
    }
  }

  console.log("Schema registration complete. Schema UID:", schemaUID);
  
  // Only write to file if the UID doesn't match the last entry
  if (shouldWriteUID) {
    console.log("Writing new schema UID to schema-uids.txt");
    fs.appendFileSync(
      path, 
      `Topic Schema: ${schemaUID}\n`
    );
  }
  async function createTopicAttestation(topicName: string, parentTopicUID?: string): Promise<string | null> {
    console.log(`Creating Topic attestation for: ${topicName}${parentTopicUID ? ` (parent: ${parentTopicUID})` : ' (root topic)'}`);
    
    try {
      // Encode the attestation data according to the schema "string name"
      const encodedData = hre.ethers.AbiCoder.defaultAbiCoder().encode(
        ["string"],
        [topicName]
      );

      // Create the attestation with timeout handling
      console.log(`Submitting attestation transaction for ${topicName}...`);
      const attestationTx = await eas.connect(deployerSigner).attest({
        schema: schemaUID,
        data: {
          recipient: hre.ethers.ZeroAddress, // No specific recipient
          expirationTime: 0, // Never expires
          revocable: revocable,
          refUID: parentTopicUID || hre.ethers.ZeroHash, // Reference parent topic or ZeroHash for root
          data: encodedData,
          value: 0 // No ETH value
        }
      });

      console.log(`Waiting for transaction confirmation for ${topicName}...`);
      const attestationReceipt = await attestationTx.wait();
      
      if (attestationReceipt) {
        console.log(`${topicName} Topic attestation created successfully. Transaction hash:`, attestationReceipt.hash);
        
        // The EAS attest function returns the attestation UID directly
        // Let's try to get it from the transaction result first
        let attestationUID: string | null = null;
        
        try {
          // Method 1: Try to get the return value from the transaction
          // Note: This might not work with all RPC providers
          const iface = new hre.ethers.Interface([
            "event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)"
          ]);
          
          // Look for the Attested event in the logs
          for (const log of attestationReceipt.logs) {
            try {
              const parsed = iface.parseLog({
                topics: log.topics,
                data: log.data
              });
              if (parsed && parsed.name === "Attested") {
                attestationUID = parsed.args.uid;
                break;
              }
            } catch (e) {
              // Skip logs that don't match our interface
              continue;
            }
          }
        } catch (error) {
          console.log("Could not parse attestation UID from logs, trying alternative method");
        }
        
        if (attestationUID) {
          console.log(`${topicName} Topic attestation UID:`, attestationUID);
          
          // Verify the attestation exists
          try {
            const attestation = await eas.getAttestation(attestationUID);
            console.log(`✓ Verified attestation exists on-chain for ${topicName}`);
          } catch (error) {
            console.error(`✗ Could not verify attestation ${attestationUID} on-chain:`, error);
            return null;
          }
          
          // Index the attestation
          try {
            console.log(`Indexing attestation ${attestationUID} for ${topicName}...`);
            const indexTx = await indexer.indexAttestation(attestationUID);
            const indexReceipt = await indexTx.wait();
            if (indexReceipt) {
              console.log(`✓ Successfully indexed attestation for ${topicName}`);
            }
          } catch (error) {
            console.error(`✗ Failed to index attestation ${attestationUID} for ${topicName}:`, error);
            // Continue execution even if indexing fails
          }
          
          // Store the attestation UID in a file
          const fs = require("fs");
          fs.appendFileSync(
            "topic-attestations.txt",
            `${topicName} Topic Attestation: ${attestationUID}${parentTopicUID ? ` (parent: ${parentTopicUID})` : ' (root)'}\n`
          );
          
          return attestationUID;
        } else {
          console.error(`Could not extract attestation UID for ${topicName}`);
          return null;
        }
      }
    } catch (error) {
      console.error(`Error creating ${topicName} Topic attestation:`, error);
      
      // If it's the custom error 0xc5723b51, let's try to understand what it means
      if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.includes("0xc5723b51")) {
        console.error("This appears to be a custom contract error. Possible causes:");
        console.error("1. Schema UID might not be registered properly");
        console.error("2. TopicResolver might be rejecting the attestation");
        console.error("3. Parent topic UID might be invalid or not exist");
        
        // Let's verify the schema exists
        try {
          const schema = await schemaRegistry.getSchema(schemaUID);
          console.log("Schema verification:", schema);
        } catch (e) {
          console.error("Schema does not exist in registry!");
        }
        
        // If this is not the root topic, verify parent exists
        if (parentTopicUID && parentTopicUID !== hre.ethers.ZeroHash) {
          try {
            const parentAttestation = await eas.getAttestation(parentTopicUID);
            console.log("Parent attestation verification:", parentAttestation.uid);
          } catch (e) {
            console.error("Parent attestation does not exist!");
          }
        }
      }
    }
    
    return null;
  }

  // Check if root topic already exists
  const topicResolver = await hre.ethers.getContractAt("TopicResolver", TopicResolver.address);
  const existingRootTopicUID = await topicResolver.rootTopicUid();
  
  let rootTopicUID: string | null = null;
  
  if (existingRootTopicUID === hre.ethers.ZeroHash) {
    console.log("No root topic exists, creating new root topic");
    rootTopicUID = await createTopicAttestation("root");
  } else {
    console.log("Root topic already exists with UID:", existingRootTopicUID);
    rootTopicUID = existingRootTopicUID;
  }
  
  // Create blockchain-related sample topics
  if (rootTopicUID) {
    // Helper function to add delay between attestations
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    
    // Create main blockchain topics
    console.log("Creating main blockchain topics...");
    const ethereumUID = await createTopicAttestation("ethereum", rootTopicUID);
    await delay(1000); // 1 second delay
    
    const bitcoinUID = await createTopicAttestation("bitcoin", rootTopicUID);
    await delay(1000);
    
    const solanaUID = await createTopicAttestation("solana", rootTopicUID);
    await delay(1000);
    
    // Create Ethereum-related subtopics
    if (ethereumUID) {
      console.log("Creating Ethereum subtopics...");
      await createTopicAttestation("vitalik", ethereumUID);
      await delay(1000);
      await createTopicAttestation("eth", ethereumUID);
      await delay(1000);
      await createTopicAttestation("defi", ethereumUID);
      await delay(1000);
      await createTopicAttestation("eip", ethereumUID);
      await delay(1000);
    }
    
    // Create Bitcoin-related subtopics
    if (bitcoinUID) {
      console.log("Creating Bitcoin subtopics...");
      await createTopicAttestation("satoshi", bitcoinUID);
      await delay(1000);
      await createTopicAttestation("btc", bitcoinUID);
      await delay(1000);
      await createTopicAttestation("lightning", bitcoinUID);
      await delay(1000);
    }
    
    // Create Solana-related subtopics
    if (solanaUID) {
      console.log("Creating Solana subtopics...");
      await createTopicAttestation("sol", solanaUID);
      await delay(1000);
      await createTopicAttestation("anatoly", solanaUID);
      await delay(1000);
      await createTopicAttestation("phantom", solanaUID);
    }
  }
};

export default deployTopicSchema;

// Tags are useful if you have multiple deploy files and only want to run one of them
deployTopicSchema.tags = ["TopicSchema"];
