import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

// EAS Addresses (Sepolia) — same as 01_indexer.ts
const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

const deployEFSSortOverlay: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSSortOverlay with account:", deployer);

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

  // 2. Get the deployed Indexer address
  const indexerDeployment = await hre.deployments.get("Indexer");
  const indexerAddress = indexerDeployment.address;
  console.log("Using EFSIndexer at:", indexerAddress);

  // 3. Nonce prediction
  // Deployment order:
  //   nonce+0: Register SORT_INFO schema
  //   nonce+1: Deploy EFSSortOverlay
  const currentNonce = await ethers.provider.getTransactionCount(deployer);
  console.log("Current Nonce:", currentNonce);

  const futureSortOverlayAddress = ethers.getCreateAddress({ from: deployer, nonce: currentNonce + 1 });
  console.log("Predicted EFSSortOverlay Address:", futureSortOverlayAddress);

  // 4. Register SORT_INFO schema
  const sortInfoDefinition = "address sortFunc, bytes32 targetSchema";
  const sortInfoRevocable = true;

  const sortInfoSchemaUID = ethers.solidityPackedKeccak256(
    ["string", "address", "bool"],
    [sortInfoDefinition, futureSortOverlayAddress, sortInfoRevocable],
  );
  console.log("Registering SORT_INFO schema:", sortInfoSchemaUID);

  try {
    const tx = await schemaRegistry.register(sortInfoDefinition, futureSortOverlayAddress, sortInfoRevocable);
    await tx.wait();
    console.log("Registered SORT_INFO schema");
  } catch {
    console.log("Failed to register SORT_INFO (likely already exists). Skipping.");
  }

  // 5. Deploy EFSSortOverlay
  await deploy("EFSSortOverlay", {
    contract: "EFSSortOverlay",
    from: deployer,
    args: [EAS_ADDRESS, sortInfoSchemaUID, indexerAddress],
    log: true,
    autoMine: true,
  });

  const sortOverlay = await hre.ethers.getContract<Contract>("EFSSortOverlay", deployer);
  console.log("EFSSortOverlay deployed at:", sortOverlay.target);

  if (sortOverlay.target !== futureSortOverlayAddress) {
    console.warn("WARNING: EFSSortOverlay address different from predicted!");
    console.warn(`Expected: ${futureSortOverlayAddress}, Got: ${sortOverlay.target}`);
  }

  console.log("EFSSortOverlay deployment complete.");
  console.log("  SORT_INFO schema UID:", sortInfoSchemaUID);
};

export default deployEFSSortOverlay;
deployEFSSortOverlay.tags = ["SortOverlay"];
deployEFSSortOverlay.dependencies = ["Indexer"];
