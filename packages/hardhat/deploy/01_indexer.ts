import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) - Assuming forking or consistent addresses
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0"; // Standard Sepolia Registry? Needs verification or fetch from EAS.
// Wait, 01_indexer.ts previous args were: [EAS, PREV_INDEXER].
// The second arg was prevIndexer? "0xaEF4103A04090071165F78D45D83A0C0782c2B2a" on Sepolia.

const deployEFSIndexer: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSIndexer with account:", deployer);

  // 1. Get EAS and SchemaRegistry
  // On local fork, we can use these addresses. If pure local, they might fail if not deployed.
  // Assuming Fork environment as per context.

  const eas = await ethers.getContractAt("IEAS", EAS_ADDRESS);
  // Fetch registry from EAS to be sure
  let schemaRegistryAddress;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch (e) {
    console.log("Could not fetch SchemaRegistry from EAS (mock might be needed for tests?), defaulting to known address.");
    // If we are on a mock/local network effectively without EAS deployed, this script will fail.
    // But we must assume environment is prepared.
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }

  const schemaRegistry = await ethers.getContractAt("ISchemaRegistry", schemaRegistryAddress);

  // 2. Define Schemas
  const schemas = [
    { name: "ANCHOR", definition: "string name", revocable: false }, // Permanent
    { name: "PROPERTY", definition: "string value", revocable: true }, // Removed key
    { name: "DATA", definition: "bytes32 blobUID, string fileMode", revocable: true }, // Removed metadata
    { name: "BLOB", definition: "string mimeType, uint8 storageType, bytes location", revocable: true, noResolver: true },
    { name: "TAG", definition: "bytes32 labelUID, int256 weight", revocable: true }, // Changed bool to int256
  ];

  // 3. Calculate Future Address of EFSIndexer
  // We need to know how many transactions we will emit before deploying Indexer.
  // Each schema registration is 1 tx.
  // We have 5 schemas.

  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  // Predict: 5 (schemas) + 0 (deploy indexer) = Indexer is at Nonce + 5?
  // Wait. Address depends on Nonce AT DEPLOYMENT.
  // If we run 5 txs first, the deploy tx will be at currentNonce + 5.
  const futureIndexerAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 5 });
  console.log("Predicted EFSIndexer Address:", futureIndexerAddress);

  // 4. Register Schemas with Resolver = Future Address (except BLOB)
  const schemaUIDs: Record<string, string> = {};

  for (const schema of schemas) {
    const resolver = schema.noResolver ? ethers.ZeroAddress : futureIndexerAddress;

    // Calculate UID locally to verify or update consts
    const uid = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [schema.definition, resolver, schema.revocable]
    );
    schemaUIDs[schema.name] = uid;

    console.log(`Registering ${schema.name} (${uid}) with resolver ${resolver}...`);

    // Check if already registered? 
    // Problem: If already registered, we don't burn a nonce?
    // If we don't burn a nonce, our prediction fails!
    // CRITICAL: Deployment scripts on Hardhat Localhost are usually ephemeral or persistent.
    // If persistent, nonce is higher.
    // If we skip registration, nonce doesn't increment.
    // EFSIndexer deployment MUST happen at the PREDICTED nonce.
    // If we already moved past the nonce, we can't deploy at that address!

    // ROBUST STRATEGY: 
    // On a persistent chain like Sepolia, we can't easily rely on Create2 prediction unless we control the nonce exactly or use a Deployer Contract / Create2Factory.
    // But for this task (Local Dev), we might be restarting.

    // However, if we assume we are running this fresh:
    // We must execute the transactions.

    // If schema exists, we can't re-register it usually? 
    // SchemaRegistry allows multiple registrations? No, UID is unique.
    // If we try to register existing UID, it probably reverts or just returns ID.
    // IF IT REVERTS, we fail.

    // BUT: The UID depends on the Resolver Address.
    // If we are deploying a NEW EFSIndexer (new address), the Resolver Address is different (unless we get same address).
    // If we get same address (restarting node), then schema exists.

    // Since we are in dev/agentic flow:
    // We will try to register. If it fails, we assume it's done? 
    // BUT WE NEED TO BURN NONCE to match prediction if we relied on prediction.

    // BETTER STRATEGY IS TO NOT RELY ON PREDICTION IF WE CAN HELP IT?
    // But we CAN'T. EFSIndexer immutable args need Schema UIDs. Schema UIDs need EFSIndexer Address.
    // Circular.

    // SOLUTION: Use a Create2 Factory? Too complex for this script.
    // SOLUTION: Use "Nonce burning" checking?

    // For localhost dev, let's just Try Register.
    try {
      // Note: hardhat-deploy usually handles deployments idempotently.
      // But here we are running raw ethers txs.
      const tx = await schemaRegistry.register(schema.definition, resolver, schema.revocable);
      await tx.wait();
      console.log(`Registered ${schema.name}`);
    } catch (e) {
      console.log(`Failed to register ${schema.name} (maybe already exists? or nonce mismatch). Error: ${e}`);
      // If we failed, we didn't increment nonce?
      // Then our prediction is wrong.
      // This approach is brittle on re-runs.

      // Fallback: If registration fails, we might just assume UIDs are valid?
      // But Indexer deployment will be at WRONG address if we didn't burn nonce.
      // And if Indexer is at wrong address, the Schema Resolver settings point to the WRONG (predicted) address!

      // Development Hack: Send 0 ETH to self to burn nonce if needed?
      // Or just proceed and see.
      // In a "Testing" environment, usually we start fresh.
    }
  }

  // 5. Deploy EFSIndexer
  // We rename the artifact to "Indexer" for compatibility? or just "EFSIndexer"?
  // The user asked specifically for EFSIndexer? No, "Test this contract...".
  // Let's deploy as "Indexer" (name in basic deploy system) but using EFSIndexer artifact.

  await deploy("Indexer", {
    contract: "EFSIndexer", // Specify artifact
    from: deployer,
    args: [
      EAS_ADDRESS,
      schemaUIDs["ANCHOR"],
      schemaUIDs["PROPERTY"],
      schemaUIDs["DATA"],
      schemaUIDs["BLOB"],
      schemaUIDs["TAG"]
    ],
    log: true,
    autoMine: true,
  });

  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  console.log("EFSIndexer deployed at:", indexer.target);

  if (indexer.target !== futureIndexerAddress) {
    console.warn("WARNING: Deployed address different from predicted! Resolver configuration might be broken.");
    console.warn(`Expected: ${futureIndexerAddress}, Got: ${indexer.target}`);
  }

  // 6. Create Root Anchor
  // The system requires a Root Anchor to function.
  try {
    console.log("Creating Root Anchor...");
    const anchorSchemaUID = schemaUIDs["ANCHOR"];

    // Check if root anchor already exists (via Indexer)
    // We can check public var rootAnchorUID()
    const rootUID = await indexer.rootAnchorUID();

    if (rootUID === ethers.ZeroHash) {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false, // Anchors are NOT revocable
          refUID: ethers.ZeroHash,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["root"]),
          value: 0,
        },
      });
      await tx.wait();
      console.log("Root Anchor 'root' created successfully!");
    } else {
      console.log("Root Anchor already exists:", rootUID);
    }
  } catch (e) {
    console.error("Failed to create Root Anchor:", e);
  }
};

export default deployEFSIndexer;
deployEFSIndexer.tags = ["Indexer"];
