import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";
import { redeployIfArgsChanged } from "../deploy-utils";

const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";
const SCHEMA_REGISTRY_ADDRESS = "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0";

const deployEFSRouter: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const ethers = hre.ethers;

  console.log("Deploying EFSRouter with account:", deployer);

  // Get Deployed Indexer
  const indexer = await ethers.getContract<Contract>("Indexer", deployer);
  if (!indexer) {
    throw new Error("EFSIndexer not found! Make sure 01_indexer.ts ran.");
  }

  const dataSchemaUID = await indexer.DATA_SCHEMA_UID();

  // Get TagResolver (deployed in 01_indexer.ts)
  const tagResolverDeployment = await hre.deployments.get("TagResolver");

  // Resolve SchemaRegistry via EAS (matches 01_indexer.ts fallback pattern)
  const eas = await ethers.getContractAt(
    "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol:IEAS",
    EAS_ADDRESS,
  );
  let schemaRegistryAddress: string;
  try {
    schemaRegistryAddress = await eas.getSchemaRegistry();
  } catch {
    console.log("Could not fetch SchemaRegistry from EAS, defaulting to known address.");
    schemaRegistryAddress = SCHEMA_REGISTRY_ADDRESS;
  }

  const routerArgs = [indexer.target, EAS_ADDRESS, tagResolverDeployment.address, schemaRegistryAddress, dataSchemaUID];
  await redeployIfArgsChanged(hre, "EFSRouter", routerArgs);

  await deploy("EFSRouter", {
    from: deployer,
    args: routerArgs,
    log: true,
    autoMine: true,
  });

  const router = await ethers.getContract<Contract>("EFSRouter", deployer);
  console.log("EFSRouter deployed at:", router.target);
};

export default deployEFSRouter;
deployEFSRouter.tags = ["EFSRouter"];
deployEFSRouter.dependencies = ["Indexer"];
