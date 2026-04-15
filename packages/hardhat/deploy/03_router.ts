import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";
import { Contract } from "ethers";

const EAS_ADDRESS = "0xC2679fBD37d54388Ce493F1DB75320D236e1815e";

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

  await deploy("EFSRouter", {
    from: deployer,
    args: [indexer.target, EAS_ADDRESS, tagResolverDeployment.address, dataSchemaUID],
    log: true,
    autoMine: true,
  });

  const router = await ethers.getContract<Contract>("EFSRouter", deployer);
  console.log("EFSRouter deployed at:", router.target);
};

export default deployEFSRouter;
deployEFSRouter.tags = ["EFSRouter"];
deployEFSRouter.dependencies = ["Indexer"];
