import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) — same as 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

const deployMirrors: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying MirrorResolver with account:", deployer);

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

  // 2. Get the deployed Indexer
  const indexerDeployment = await hre.deployments.get("Indexer");
  const indexerAddress = indexerDeployment.address;
  console.log("Using EFSIndexer at:", indexerAddress);

  // 3. Nonce prediction for MirrorResolver address
  // Deployment order:
  //   nonce+0: Register MIRROR schema
  //   nonce+1: Deploy MirrorResolver
  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureMirrorResolverAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 1 });
  console.log("Predicted MirrorResolver Address:", futureMirrorResolverAddress);

  // 4. Register MIRROR schema
  const mirrorDefinition = "bytes32 transportDefinition, string uri";
  const mirrorRevocable = true;

  const mirrorSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [mirrorDefinition, futureMirrorResolverAddress, mirrorRevocable],
  );
  console.log("Registering MIRROR schema:", mirrorSchemaUID);

  try {
    const tx = await schemaRegistry.register(mirrorDefinition, futureMirrorResolverAddress, mirrorRevocable);
    await tx.wait();
    console.log("Registered MIRROR schema");
  } catch {
    console.log("Failed to register MIRROR (likely already exists). Skipping.");
  }

  // 5. Deploy MirrorResolver
  await deploy("MirrorResolver", {
    contract: "MirrorResolver",
    from: deployer,
    args: [EAS_ADDRESS, indexerAddress],
    log: true,
    autoMine: true,
  });

  const mirrorResolver = await hre.ethers.getContract<Contract>("MirrorResolver", deployer);
  console.log("MirrorResolver deployed at:", mirrorResolver.target);

  if (mirrorResolver.target !== futureMirrorResolverAddress) {
    console.warn("WARNING: MirrorResolver address different from predicted!");
    console.warn(`Expected: ${futureMirrorResolverAddress}, Got: ${mirrorResolver.target}`);
  }

  // 6. Wire ALL partner contracts into EFSIndexer
  //    (moved here from 04_sortoverlay.ts so mirrorResolver is available)
  const indexer = await hre.ethers.getContract<Contract>("Indexer", deployer);
  const tagResolverDeployment = await hre.deployments.get("TagResolver");
  const tagResolver = await hre.ethers.getContractAt("TagResolver", tagResolverDeployment.address);
  const tagSchemaUID = await tagResolver.TAG_SCHEMA_UID();

  const sortOverlayDeployment = await hre.deployments.get("EFSSortOverlay");
  const sortOverlay = await hre.ethers.getContractAt("EFSSortOverlay", sortOverlayDeployment.address);
  const sortInfoSchemaUID = await sortOverlay.SORT_INFO_SCHEMA_UID();

  try {
    await (
      await indexer.wireContracts(
        tagResolverDeployment.address,
        tagSchemaUID,
        sortOverlay.target,
        sortInfoSchemaUID,
        mirrorResolver.target,
        mirrorSchemaUID,
        schemaRegistryAddress,
      )
    ).wait();
    console.log("EFSIndexer wired:");
    console.log("  tagResolver:         ", tagResolverDeployment.address);
    console.log("  TAG_SCHEMA_UID:      ", tagSchemaUID);
    console.log("  sortOverlay:         ", sortOverlay.target);
    console.log("  SORT_INFO_SCHEMA_UID:", sortInfoSchemaUID);
    console.log("  mirrorResolver:      ", mirrorResolver.target);
    console.log("  MIRROR_SCHEMA_UID:   ", mirrorSchemaUID);
    console.log("  schemaRegistry:      ", schemaRegistryAddress);
  } catch (e: any) {
    if (e?.message?.includes("already wired")) {
      console.log("EFSIndexer already wired — skipping.");
    } else {
      throw e;
    }
  }

  // 7. Create /transports/ anchor tree
  const anchorSchemaUID = await indexer.ANCHOR_SCHEMA_UID();
  const rootUID = await indexer.rootAnchorUID();

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

  // Create /transports/ parent anchor
  let transportsUID = await indexer.resolvePath(rootUID, "transports");
  if (transportsUID === ethers.ZeroHash) {
    console.log("Creating 'transports' Anchor under root...");
    const tx = await eas.attest({
      schema: anchorSchemaUID,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: 0,
        revocable: false,
        refUID: rootUID,
        data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], ["transports", ethers.ZeroHash]),
        value: 0,
      },
    });
    const receipt = await tx.wait();
    transportsUID = extractUID(receipt) ?? ethers.ZeroHash;
    console.log("'transports' Anchor created:", transportsUID);
  } else {
    console.log("'transports' Anchor already exists:", transportsUID);
  }

  // Create transport type anchors
  const transportTypes = ["onchain", "ipfs", "arweave", "magnet", "https"];
  for (const transportName of transportTypes) {
    const existing = await indexer.resolvePath(transportsUID, transportName);
    if (existing === ethers.ZeroHash) {
      console.log(`Creating '/transports/${transportName}' Anchor...`);
      const tx = await eas.attest({
        schema: anchorSchemaUID,
        data: {
          recipient: ethers.ZeroAddress,
          expirationTime: 0,
          revocable: false,
          refUID: transportsUID,
          data: ethers.AbiCoder.defaultAbiCoder().encode(["string", "bytes32"], [transportName, ethers.ZeroHash]),
          value: 0,
        },
      });
      const receipt = await tx.wait();
      const uid = extractUID(receipt);
      console.log(`  '/transports/${transportName}' created:`, uid);
    } else {
      console.log(`  '/transports/${transportName}' already exists:`, existing);
    }
  }

  // 8. Wire /transports/ anchor into MirrorResolver for ancestry validation
  if (transportsUID !== ethers.ZeroHash) {
    const currentTransportsAnchor = await mirrorResolver.transportsAnchorUID();
    if (currentTransportsAnchor === ethers.ZeroHash) {
      await (await mirrorResolver.setTransportsAnchor(transportsUID)).wait();
      console.log("MirrorResolver.transportsAnchorUID set to:", transportsUID);
    } else {
      console.log("MirrorResolver.transportsAnchorUID already set:", currentTransportsAnchor);
    }
  } else {
    console.log("WARNING: /transports/ anchor UID is zero — skipping MirrorResolver wiring (EAS likely unavailable).");
  }

  console.log("MirrorResolver deployment and transport anchors complete.");
};

export default deployMirrors;
deployMirrors.tags = ["Mirrors"];
deployMirrors.dependencies = ["Indexer", "SortOverlay"];
