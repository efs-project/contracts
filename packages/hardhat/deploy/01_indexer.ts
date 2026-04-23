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
  //    PIN and TAG are sibling edge schemas served by a single EdgeResolver. Cardinality
  //    lives in the schema UID itself (PIN = singleton, TAG = list). The two schemas have
  //    DIFFERENT on-wire shapes — PIN carries just the predicate, TAG carries predicate +
  //    per-entry weight (generic metadata: sort key, score, ranking). The differing field
  //    counts make the EAS UIDs naturally distinct (EAS UID = keccak256(definition_string,
  //    resolver, revocable)); the resolver branches on attestation.schema before decoding.
  //
  //      - PIN  (cardinality 1) — `bytes32 definition`. Re-attest at the same slot
  //                                supersedes; revoke clears. No per-entry metadata.
  //      - TAG  (cardinality N) — `bytes32 definition, int256 weight`. Re-attest updates
  //                                weight in place; revoke removes. No supersede-via-weight.
  //    See ADR-0041.
  const schemas = [
    { name: "ANCHOR", definition: "string name, bytes32 schemaUID", revocable: false },
    { name: "PROPERTY", definition: "string value", revocable: false },
    { name: "DATA", definition: "bytes32 contentHash, uint64 size", revocable: false },
    {
      name: "BLOB",
      definition: "string mimeType, uint8 storageType, bytes location",
      revocable: true,
      noResolver: true,
    },
    { name: "PIN", definition: "bytes32 definition", revocable: true, useEdgeResolver: true },
    { name: "TAG", definition: "bytes32 definition, int256 weight", revocable: true, useEdgeResolver: true },
    { name: "NAMING", definition: "bytes32 schemaId, string name", revocable: true, noResolver: true },
  ];

  // 3. Calculate Future Addresses
  // Deployment order:
  //   nonce+0: Deploy EdgeResolver
  //   nonce+1 through nonce+7: Register 7 schemas (ANCHOR, PROPERTY, DATA, BLOB, PIN, TAG, NAMING)
  //   nonce+8: Deploy EFSIndexer

  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureEdgeResolverAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce });
  const futureIndexerAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 8 });
  console.log("Predicted EdgeResolver Address:", futureEdgeResolverAddress);
  console.log("Predicted EFSIndexer Address:", futureIndexerAddress);

  // Pre-compute PIN and TAG schema UIDs (deterministic: keccak256(definition, resolver, revocable))
  const pinSchema = schemas.find(s => s.name === "PIN")!;
  const tagSchema = schemas.find(s => s.name === "TAG")!;
  const pinSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [pinSchema.definition, futureEdgeResolverAddress, pinSchema.revocable],
  );
  const tagSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [tagSchema.definition, futureEdgeResolverAddress, tagSchema.revocable],
  );
  console.log("Pre-computed PIN_SCHEMA_UID:", pinSchemaUID);
  console.log("Pre-computed TAG_SCHEMA_UID:", tagSchemaUID);

  // 4. Deploy EdgeResolver first (needs to exist before schema registration)
  //    EdgeResolver serves both PIN and TAG schemas. Both UIDs are immutable on the resolver
  //    so it can dispatch storage by attestation.schema in one branch.
  await deploy("EdgeResolver", {
    contract: "EdgeResolver",
    from: deployer,
    args: [EAS_ADDRESS, pinSchemaUID, tagSchemaUID, futureIndexerAddress, schemaRegistryAddress],
    log: true,
    autoMine: true,
  });

  const edgeResolver = await hre.ethers.getContract<Contract>("EdgeResolver", deployer);
  console.log("EdgeResolver deployed at:", edgeResolver.target);

  if (edgeResolver.target !== futureEdgeResolverAddress) {
    console.warn("WARNING: EdgeResolver address different from predicted!");
    console.warn(`Expected: ${futureEdgeResolverAddress}, Got: ${edgeResolver.target}`);
  }

  // 5. Register Schemas with appropriate Resolvers
  const schemaUIDs: Record<string, string> = {};

  for (const schema of schemas) {
    let resolver: string;
    if (schema.noResolver) {
      resolver = ethers.ZeroAddress;
    } else if (schema.useEdgeResolver) {
      resolver = futureEdgeResolverAddress;
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

  // 6. Deploy EFSIndexer
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
    throw new Error(
      `Indexer deployed at wrong address — resolver wiring is broken.\n` +
        `Expected: ${futureIndexerAddress}\n` +
        `Got:      ${indexer.target}\n` +
        `Adjust the nonce offset in the deploy script and redeploy.`,
    );
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

  // 9. Create Root Anchor and "tags" Anchor
  //    Tag definitions (e.g. "favorites") are normal anchors under "tags", which is
  //    itself a normal anchor under root. One tree, uniform anchors throughout.
  const anchorSchemaUID = schemaUIDs["ANCHOR"];

  const extractUID = (receipt: any): string | undefined => {
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = eas.interface.parseLog(log);
        if (parsed?.name === "Attested") return parsed.args.uid;
      } catch {
        // Not our event
      }
    }
    return undefined;
  };

  try {
    let rootUID = await indexer.rootAnchorUID();

    if (rootUID === ethers.ZeroHash) {
      console.log("Creating Root Anchor...");
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
      const receipt = await tx.wait();
      rootUID = extractUID(receipt) ?? ethers.ZeroHash;
      console.log("Root Anchor 'root' created:", rootUID);
    } else {
      console.log("Root Anchor already exists:", rootUID);
    }

    // Check if "tags" already exists under root
    const existingTagsUID = await indexer.resolvePath(rootUID, "tags");
    if (existingTagsUID === ethers.ZeroHash) {
      console.log("Creating 'tags' Anchor under root...");
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false,
          refUID: rootUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["tags", ethers.ZeroHash]),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      const tagsUID = extractUID(receipt);
      console.log("'tags' Anchor created:", tagsUID);
    } else {
      console.log("'tags' Anchor already exists:", existingTagsUID);
    }
  } catch (e) {
    console.error("Failed to create Root / 'tags' Anchors:", e);
  }
};

export default deployEFSIndexer;
deployEFSIndexer.tags = ["Indexer"];
