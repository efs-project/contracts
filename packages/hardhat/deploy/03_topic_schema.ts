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
  
  // Only write to file if the UID doesn't match the last entry
  if (shouldWriteUID) {
    console.log("Writing new schema UID to schema-uids.txt");
    fs.appendFileSync(
      path, 
      `Topic Schema: ${schemaUID}\n`
    );
  }
};

export default deployTopicSchema;

// Tags are useful if you have multiple deploy files and only want to run one of them
deployTopicSchema.tags = ["TopicSchema"];
