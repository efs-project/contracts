import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) - Assuming forking or consistent addresses
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

const deployEFSIndexer: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSIndexer with account:", deployer);

  // 1. Get EAS and SchemaRegistry
  const eas = await ethers.getContractAt("IEAS", EAS_ADDRESS);
  let schemaRegistryAddress;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    console.log("Could not fetch SchemaRegistry from EAS, defaulting to known address.");
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }
  const schemaRegistry = await ethers.getContractAt("ISchemaRegistry", schemaRegistryAddress);

  // 2. Define Schemas
  const schemas = [
    { name: "ANCHOR", definition: "string name, bytes32 schemaUID", revocable: false }, // Permanent
    { name: "PROPERTY", definition: "string value", revocable: true }, // Value only (Name is in Anchor)
    { name: "DATA", definition: "bytes32 blobUID, string fileMode", revocable: true }, // Removed metadata
    {
      name: "BLOB",
      definition: "string mimeType, uint8 storageType, bytes location",
      revocable: true,
      noResolver: true,
    },
    { name: "TAG", definition: "bytes32 labelUID, int256 weight", revocable: true },
    { name: "NAMING", definition: "bytes32 schemaId, string name", revocable: true, noResolver: true }, // New Naming Schema (Standard)
  ];

  // 3. Calculate Future Address of EFSIndexer
  // Predict: 6 (schemas) + 0 (deploy indexer) = Indexer is at Nonce + 6

  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  // We have 6 schemas to register. The Indexer will be deployed AFTER these 6 txs.
  // So deployment nonce = currentNonce + 6.
  const futureIndexerAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 6 });
  console.log("Predicted EFSIndexer Address:", futureIndexerAddress);

  // 4. Register Schemas with Resolver
  const schemaUIDs: Record<string, string> = {};

  for (const schema of schemas) {
    const resolver = schema.noResolver ? ethers.ZeroAddress : futureIndexerAddress;

    // Calculate UID locally
    const uid = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [schema.definition, resolver, schema.revocable],
    );
    schemaUIDs[schema.name] = uid;

    console.log(`Registering ${schema.name} (${uid}) with resolver ${resolver}...`);

    try {
      const tx = await schemaRegistry.register(schema.definition, resolver, schema.revocable);
      await tx.wait();
      console.log(`Registered ${schema.name}`);
    } catch {
      console.log(`Failed to register ${schema.name} (likely already exists). Skipping.`);
    }
  }

  // 5. Deploy EFSIndexer
  await deploy("Indexer", {
    contract: "EFSIndexer",
    from: deployer,
    args: [
      EAS_ADDRESS,
      schemaUIDs["ANCHOR"],
      schemaUIDs["PROPERTY"],
      schemaUIDs["DATA"],
      schemaUIDs["BLOB"],
      schemaUIDs["TAG"],
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

  // 6. Deploy SchemaNameIndex
  const namingSchemaUID = schemaUIDs["NAMING"];
  await deploy("SchemaNameIndex", {
    contract: "SchemaNameIndex",
    from: deployer,
    args: [EAS_ADDRESS, namingSchemaUID],
    log: true,
    autoMine: true,
  });
  const schemaNameIndex = await hre.ethers.getContract<Contract>("SchemaNameIndex", deployer);
  console.log("SchemaNameIndex deployed at:", schemaNameIndex.target);

  // 7. Attest Names for Schemas and Index them
  console.log("Attesting and Indexing Schema Names...");
  for (const schema of schemas) {
    // We want to name our EFS schemas.
    // Name format: "EFS [Name] Schema"
    const name = `EFS ${schema.name.charAt(0).toUpperCase() + schema.name.slice(1).toLowerCase()} Schema`;
    const targetSchemaUID = schemaUIDs[schema.name];

    try {
      // 1. Attest
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [targetSchemaUID, name]);

      const tx = await eas.attest({
        schema: namingSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0n,
          revocable: true,
          refUID: ethers.ZeroHash, // Standard Naming Schema uses refUID=0
          data: encodedData,
          value: 0n,
        },
      });
      const receipt = await tx.wait();
      // Get UID from logs (or predictable event if we parse it, but EAS returns UID in return value which we can't access easily in ethers v6 tx response directly without callStatic)
      // Actually, let's just use event parsing.
      // Or cleaner: staticCall to get UID, then send tx.

      // Use static call to simulate
      // const uid = await eas.attest.staticCall({ ... });
      // But wait, we need the actual tx to be mined.

      // Simpler: Parse the Attested event from the logs.
      // Event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)

      // Find the "Attested" event log
      const log = receipt?.logs.find((l: any) => {
        try {
          return eas.interface.parseLog(l)?.name === "Attested";
        } catch {
          return false;
        }
      });

      if (log) {
        const parsedLog = eas.interface.parseLog(log);
        const attestationUID = parsedLog?.args.uid;
        console.log(`Attested Name for ${schema.name}: ${attestationUID}`);

        // 2. Index
        const indexTx = await schemaNameIndex.indexAttestation(attestationUID);
        await indexTx.wait();
        console.log(`Indexed Name for ${schema.name}`);
      } else {
        console.log(`Failed to find Attested event for ${schema.name}`);
      }
    } catch (e) {
      console.error(`Failed to name ${schema.name}:`, e);
    }
  }

  // 8. Create Root Anchor
  try {
    console.log("Creating Root Anchor...");
    const anchorSchemaUID = schemaUIDs["ANCHOR"];
    const rootUID = await indexer.rootAnchorUID();

    if (rootUID === ethers.ZeroHash) {
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false, // Anchors are NOT revocable
          refUID: ethers.ZeroHash,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["root", ethers.ZeroHash]),
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
