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

  console.log("Deploying EFS contracts with account:", deployer);

  // 1. Get EAS and SchemaRegistry
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  let schemaRegistryAddress;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    console.log("Could not fetch SchemaRegistry from EAS, defaulting to known address.");
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }
  const schemaRegistry = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/ISchemaRegistry.sol:ISchemaRegistry",
    schemaRegistryAddress,
  );

  // 2. Define Schemas
  const schemas = [
    { name: "ANCHOR", definition: "string name, bytes32 schemaUID", revocable: false },
    { name: "PROPERTY", definition: "string value", revocable: true },
    { name: "DATA", definition: "string uri, string contentType, string fileMode", revocable: true },
    {
      name: "BLOB",
      definition: "string mimeType, uint8 storageType, bytes location",
      revocable: true,
      noResolver: true,
    },
    { name: "TAG", definition: "bytes32 definition, bool applies", revocable: true, useTagResolver: true },
    { name: "NAMING", definition: "bytes32 schemaId, string name", revocable: true, noResolver: true },
  ];

  // 3. Calculate Future Addresses
  // Deployment order:
  //   nonce+0: Deploy TagResolver
  //   nonce+1 through nonce+6: Register 6 schemas
  //   nonce+7: Deploy EFSIndexer

  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureTagResolverAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce });
  const futureIndexerAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 7 });
  console.log("Predicted TagResolver Address:", futureTagResolverAddress);
  console.log("Predicted EFSIndexer Address:", futureIndexerAddress);

  // 4. Deploy TagResolver first (needs to exist before schema registration)
  await deploy("TagResolver", {
    contract: "TagResolver",
    from: deployer,
    args: [EAS_ADDRESS],
    log: true,
    autoMine: true,
  });

  const tagResolver = await hre.ethers.getContract<Contract>("TagResolver", deployer);
  console.log("TagResolver deployed at:", tagResolver.target);

  if (tagResolver.target !== futureTagResolverAddress) {
    console.warn("WARNING: TagResolver address different from predicted!");
    console.warn(`Expected: ${futureTagResolverAddress}, Got: ${tagResolver.target}`);
  }

  // 5. Register Schemas with appropriate Resolvers
  const schemaUIDs: Record<string, string> = {};

  for (const schema of schemas) {
    let resolver: string;
    if (schema.noResolver) {
      resolver = ethers.ZeroAddress;
    } else if (schema.useTagResolver) {
      resolver = futureTagResolverAddress;
    } else {
      resolver = futureIndexerAddress;
    }

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

  // 6. Deploy EFSIndexer (no longer takes TAG_SCHEMA_UID)
  await deploy("Indexer", {
    contract: "EFSIndexer",
    from: deployer,
    args: [EAS_ADDRESS, schemaUIDs["ANCHOR"], schemaUIDs["PROPERTY"], schemaUIDs["DATA"], schemaUIDs["BLOB"]],
    log: true,
    autoMine: true,
  });

  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  console.log("EFSIndexer deployed at:", indexer.target);

  if (indexer.target !== futureIndexerAddress) {
    console.warn("WARNING: Deployed address different from predicted! Resolver configuration might be broken.");
    console.warn(`Expected: ${futureIndexerAddress}, Got: ${indexer.target}`);
  }

  // 7. Deploy SchemaNameIndex
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

  // 8. Attest Names for Schemas and Index them
  console.log("Attesting and Indexing Schema Names...");
  for (const schema of schemas) {
    const name = `EFS ${schema.name.charAt(0).toUpperCase() + schema.name.slice(1).toLowerCase()} Schema`;
    const targetSchemaUID = schemaUIDs[schema.name];

    try {
      const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [targetSchemaUID, name]);

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
      const receipt = await tx.wait();

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

  // 9. Create Root Anchor
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
          revocable: false,
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
