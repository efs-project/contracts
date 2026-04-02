import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) — same as 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

const deployEFSListManager: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSListManager with account:", deployer);

  // 1. Get EAS and SchemaRegistry
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  let schemaRegistryAddress: string;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    console.log("Could not fetch SchemaRegistry from EAS, defaulting to known address.");
    schemaRegistryAddress = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";
  }
  const schemaRegistry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    schemaRegistryAddress,
  );

  // 2. Define List Schemas
  const listSchemas = [
    {
      name: "LIST_INFO",
      definition: "uint8 listType, bytes32 targetSchemaUID",
      revocable: true,
    },
    {
      name: "LIST_ITEM",
      definition: "bytes32 itemUID, string fractionalIndex, bytes32 tags",
      revocable: true,
    },
  ];

  // 3. Calculate Future Addresses
  // Deployment order:
  //   nonce+0: Register LIST_INFO schema
  //   nonce+1: Register LIST_ITEM schema
  //   nonce+2: Deploy EFSListManager
  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureListManagerAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 2 });
  console.log("Predicted EFSListManager Address:", futureListManagerAddress);

  // 4. Compute schema UIDs and register schemas
  const schemaUIDs: Record<string, string> = {};

  for (const schema of listSchemas) {
    const uid = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      [schema.definition, futureListManagerAddress, schema.revocable],
    );
    schemaUIDs[schema.name] = uid;
    console.log(`Registering ${schema.name} (${uid}) with resolver ${futureListManagerAddress}...`);

    try {
      const tx = await schemaRegistry.register(schema.definition, futureListManagerAddress, schema.revocable);
      await tx.wait();
      console.log(`Registered ${schema.name}`);
    } catch {
      console.log(`Failed to register ${schema.name} (likely already exists). Skipping.`);
    }
  }

  // 5. Deploy EFSListManager
  await deploy("EFSListManager", {
    contract: "EFSListManager",
    from: deployer,
    args: [EAS_ADDRESS, schemaUIDs["LIST_INFO"], schemaUIDs["LIST_ITEM"]],
    log: true,
    autoMine: true,
  });

  const listManager = await hre.ethers.getContract<Contract>("EFSListManager", deployer);
  console.log("EFSListManager deployed at:", listManager.target);

  if (listManager.target !== futureListManagerAddress) {
    console.warn("WARNING: EFSListManager address different from predicted!");
    console.warn(`Expected: ${futureListManagerAddress}, Got: ${listManager.target}`);
  }

  // 6. Attest NAMING schema entries for discoverability
  // Retrieve the NAMING schema UID from the Indexer deployment
  let namingSchemaUID: string | undefined;
  try {
    const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
    // The Indexer doesn't expose NAMING_SCHEMA_UID directly — look it up from SchemaNameIndex if available
    // Fallback: compute it from the known definition and zero resolver
    namingSchemaUID = ethers.solidityPackedKeccak256(
      ["string", "address", "bool"],
      ["bytes32 schemaId, string name", ethers.ZeroAddress, true],
    );
    console.log("Using NAMING schema UID:", namingSchemaUID);
  } catch {
    console.log("Could not resolve Indexer; skipping NAMING attestations.");
  }

  if (namingSchemaUID) {
    const names = [
      { schema: schemaUIDs["LIST_INFO"], name: "EFS List Info Schema" },
      { schema: schemaUIDs["LIST_ITEM"], name: "EFS List Item Schema" },
    ];

    for (const entry of names) {
      try {
        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [entry.schema, entry.name],
        );
        const tx = await eas.attest({
          schema: namingSchemaUID,
          data: {
            recipient: ethers.ZeroAddress,
            expirationTime: 0n,
            revocable: true,
            refUID: ethers.ZeroHash,
            data: encodedData,
            value: 0n,
          },
        });
        await tx.wait();
        console.log(`Attested Name for ${entry.name}`);
      } catch (e) {
        console.error(`Failed to name ${entry.name}:`, e);
      }
    }
  }

  console.log("EFSListManager deployment complete.");
  console.log("  LIST_INFO schema UID:", schemaUIDs["LIST_INFO"]);
  console.log("  LIST_ITEM schema UID:", schemaUIDs["LIST_ITEM"]);
};

export default deployEFSListManager;
deployEFSListManager.tags = ["ListManager"];
deployEFSListManager.dependencies = ["Indexer"];
